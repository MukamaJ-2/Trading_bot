import { useState } from "react";
import { api } from "./api";
import { AlgoProvider } from "./live/AlgoContext";
import { AlgoSignalsTab } from "./tabs/AlgoSignalsTab";
import { GttTab } from "./tabs/GttTab";
import { SignalsTab } from "./tabs/SignalsTab";
import { UserTab } from "./tabs/UserTab";

const TABS = [
  { id: "user", label: "User", icon: "◉" },
  { id: "signals", label: "Signals", icon: "≋" },
  { id: "algo", label: "Algo Signals", icon: "⚡" },
  { id: "gtt", label: "GTT Placement", icon: "⌖" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function Dashboard({ userName, demo, onLogout }: { userName: string | null; demo: boolean; onLogout: () => void }) {
  const [tab, setTab] = useState<TabId>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("tab");
    } catch {
      /* storage unavailable */
    }
    return TABS.some((t) => t.id === saved) ? (saved as TabId) : "user";
  });

  const choose = (id: TabId) => {
    setTab(id);
    try {
      localStorage.setItem("tab", id);
    } catch {
      /* storage unavailable */
    }
  };

  const logout = async () => {
    await api.post("/api/auth/logout").catch(() => undefined);
    onLogout();
  };

  return (
    <AlgoProvider>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">
            <span className="logo">K</span> Kite Algo
          </div>
          {demo && <div className="demo-badge">DEMO DATA</div>}
          <nav>
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => choose(t.id)}>
                <span className="icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="muted small">{userName ?? "Logged in"}</div>
            {!demo && (
              <button className="btn ghost small" onClick={logout}>
                Log out
              </button>
            )}
          </div>
        </aside>
        <main className="content">
          {tab === "user" && <UserTab />}
          {tab === "signals" && <SignalsTab />}
          {tab === "algo" && <AlgoSignalsTab />}
          {tab === "gtt" && <GttTab />}
        </main>
      </div>
    </AlgoProvider>
  );
}
