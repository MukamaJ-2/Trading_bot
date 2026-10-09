import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { STRATEGIES } from "./strategies";
import { normalizeArgs, computeBacktest, computeTournament, computePlateau, computeWalkForward } from "./lab";
import { dailyStatus, dailySignal, runDaily, resetDaily } from "./dailyBot";

/**
 * Local web interface: `npm run ui` -> http://localhost:3000
 *
 * Node built-ins only. Binds to 127.0.0.1 so it is never reachable from the network. Paper
 * only: the one action that changes anything is the daily paper bot (the same idempotent
 * `npm run daily`) and resetting its paper account.
 *
 * Guards for a local server: every POST must be `application/json` (a cross-site form can't
 * send that without a CORS preflight, which this server never approves), and the Host header
 * must be localhost (blocks DNS-rebinding pages from talking to it).
 */

const UI_FILE = path.join(__dirname, "..", "ui", "index.html");
const MAX_BODY = 15 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  // JSON has no Infinity/NaN: send profit factor "inf" for no-losers and null for "no closed trades".
  const json = JSON.stringify(body, (_k, v) => (v === Infinity ? "inf" : typeof v === "number" && Number.isNaN(v) ? null : v));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large (15 MB max)."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === "object" ? v : {});
      } catch {
        reject(new Error("Body must be JSON."));
      }
    });
    req.on("error", reject);
  });
}

const LAB: Record<string, (a: ReturnType<typeof normalizeArgs>) => Promise<unknown>> = {
  backtest: computeBacktest,
  tournament: computeTournament,
  plateau: computePlateau,
  walkforward: computeWalkForward,
};

let dailyRunning = false;

async function handle(req: http.IncomingMessage, res: http.ServerResponse, port: number): Promise<void> {
  const host = (req.headers.host || "").toLowerCase();
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) {
    return send(res, 403, { error: "This interface only answers on localhost." });
  }
  const url = new URL(req.url || "/", `http://${host}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === "POST" && !(req.headers["content-type"] || "").startsWith("application/json")) {
    return send(res, 415, { error: "POST requests must be application/json." });
  }

  if (route === "GET /" || route === "GET /index.html") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
      "X-Frame-Options": "DENY",
    });
    res.end(fs.readFileSync(UI_FILE, "utf8"));
    return;
  }

  if (route === "GET /api/meta") {
    return send(res, 200, {
      strategies: STRATEGIES.map((s) => ({ name: s.name, description: s.description, params: s.params })),
      defaults: normalizeArgs({}),
    });
  }

  if (route === "GET /api/daily/status") return send(res, 200, dailyStatus());

  if (route === "GET /api/daily/signal") return send(res, 200, await dailySignal());

  if (route === "POST /api/daily/run") {
    if (dailyRunning) return send(res, 409, { error: "A daily run is already in progress." });
    dailyRunning = true;
    try {
      return send(res, 200, await runDaily());
    } finally {
      dailyRunning = false;
    }
  }

  if (route === "POST /api/daily/reset") {
    const body = await readBody(req);
    if (body.confirm !== true) return send(res, 400, { error: "Send {\"confirm\": true} to reset the paper account." });
    resetDaily();
    return send(res, 200, { ok: true });
  }

  const lab = url.pathname.match(/^\/api\/lab\/(\w+)$/);
  if (req.method === "POST" && lab && LAB[lab[1]]) {
    const body = await readBody(req);
    delete body.csv; // a file path from the browser is never read - CSVs arrive as csvText
    return send(res, 200, await LAB[lab[1]](normalizeArgs(body)));
  }

  send(res, 404, { error: `No route ${route}` });
}

export function startUi(): Promise<void> {
  const port = Number(process.env.UI_PORT) || 3000;
  const server = http.createServer((req, res) => {
    handle(req, res, port).catch((err) => {
      if (!res.headersSent) send(res, 400, { error: (err as Error).message });
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[${new Date().toISOString()}] [UI] Trading bot interface running at http://localhost:${port} (paper only). Ctrl+C to stop.`);
      resolve();
    });
  });
}
