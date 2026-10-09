// Builds the GitHub Pages version of the interface into docs/:
//   docs/engine.js   the Backtest Lab engine (src/browser.ts) bundled for the browser, global `BM`
//   docs/index.html  ui/index.html with static mode switched on (no local server needed)
// Run with `npm run build:pages`; CI checks that the committed output is up to date.
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const docs = path.join(root, "docs");
const MARKER = "<!-- STATIC_MODE -->";

esbuild.buildSync({
  entryPoints: [path.join(root, "src", "browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "BM",
  platform: "browser",
  target: "es2019",
  minify: true,
  legalComments: "none",
  outfile: path.join(docs, "engine.js"),
});

const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
if (!html.includes(MARKER)) throw new Error(`ui/index.html is missing the ${MARKER} marker.`);
const banner = "<!-- Generated from ui/index.html by `npm run build:pages` - edit that file, not this one. -->\n";
// The banner goes after the doctype - anything before it would put the page in quirks mode.
const out = html
  .replace(/^<!doctype html>\n/i, (m) => m + banner)
  .replace(MARKER, '<script>window.BM_STATIC = true;</script>\n<script src="engine.js"></script>');
fs.writeFileSync(path.join(docs, "index.html"), out);
fs.writeFileSync(path.join(docs, ".nojekyll"), "");
console.log("Built docs/engine.js and docs/index.html");
