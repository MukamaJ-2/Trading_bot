import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "./api";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [requestToken, setRequestToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { api_key: apiKey, api_secret: apiSecret, request_token: requestToken });
      setApiSecret("");
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loginUrl = apiKey.trim()
    ? `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey.trim())}`
    : null;

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand big">
          <span className="logo">K</span> Kite Algo Dashboard
        </div>
        <p className="muted">Log in with your Zerodha Kite Connect app.</p>

        <label>
          API Key
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" required />
        </label>
        <label>
          API Secret
          <input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} autoComplete="off" required />
        </label>
        <label>
          Request Token
          <input value={requestToken} onChange={(e) => setRequestToken(e.target.value)} autoComplete="off" required />
        </label>

        {error && <div className="alert error">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? "Logging in..." : "Login"}
        </button>

        <div className="help">
          <strong>Where do I get a request token?</strong>
          <ol>
            <li>Enter your API Key above.</li>
            <li>
              {loginUrl ? (
                <a href={loginUrl} target="_blank" rel="noreferrer">Open the Kite login page</a>
              ) : (
                "Open the Kite login page (enter your API Key first)"
              )}{" "}
              and log in.
            </li>
            <li>
              Kite redirects to your app's redirect URL. Copy the <code>request_token</code> value from that URL and
              paste it here. It works once, for a few minutes.
            </li>
          </ol>
          <p className="muted small">
            The backend exchanges it for an access token and keeps it server-side. The browser never sees the token,
            and the API secret is not stored.
          </p>
        </div>
      </form>
    </div>
  );
}
