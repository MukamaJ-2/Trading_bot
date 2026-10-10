import { useEffect, useState } from "react";
import { api } from "../api";

interface Profile {
  user_name: string;
  user_id: string;
  email?: string;
  broker?: string;
  products: string[];
  exchanges: string[];
  demo?: boolean;
}

export function UserTab() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Profile>("/api/profile").then(setProfile, (e) => setError(e.message));
  }, []);

  return (
    <section>
      <header className="page-head">
        <h1>User</h1>
        <p className="muted">Your Kite account profile, read from the backend.</p>
      </header>
      {error && <div className="alert error">{error}</div>}
      {!profile && !error && <div className="state">Loading profile...</div>}
      {profile && (
        <div className="cards">
          <div className="card">
            <div className="label">User Name</div>
            <div className="value">{profile.user_name}</div>
          </div>
          <div className="card">
            <div className="label">User ID</div>
            <div className="value mono">{profile.user_id}</div>
          </div>
          <div className="card wide">
            <div className="label">Products</div>
            <div className="chips">{profile.products.map((p) => <span key={p} className="chip">{p}</span>)}</div>
          </div>
          <div className="card wide">
            <div className="label">Exchanges</div>
            <div className="chips">{profile.exchanges.map((x) => <span key={x} className="chip">{x}</span>)}</div>
          </div>
        </div>
      )}
    </section>
  );
}
