import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Dashboard } from "./Dashboard";
import { Login } from "./Login";

interface AuthStatus {
  logged_in: boolean;
  demo: boolean;
  user_name: string | null;
}

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The backend reuses its saved access token, so a page reload or code change
  // goes straight to the dashboard while the Kite session is valid.
  const refresh = useCallback(() => {
    api.get<AuthStatus>("/api/auth/status").then(
      (s) => {
        setStatus(s);
        setError(null);
      },
      (e) => setError(e.message),
    );
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("kite-auth-expired", refresh);
    return () => window.removeEventListener("kite-auth-expired", refresh);
  }, [refresh]);

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="alert error">{error}</div>
          <button className="btn primary block" onClick={refresh}>Retry</button>
        </div>
      </div>
    );
  }
  if (!status) return <div className="login-page"><div className="state">Loading...</div></div>;
  if (!status.logged_in) return <Login onLoggedIn={refresh} />;
  return <Dashboard userName={status.user_name} demo={status.demo} onLogout={refresh} />;
}
