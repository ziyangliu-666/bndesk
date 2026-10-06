import { useEffect } from "react";
import { Header, PAGE_KEYS } from "./components/Header";
import { AlertBanner } from "./components/AlertBanner";
import { useStore } from "./store";
import { Desk } from "./pages/Desk";
import { Markouts } from "./pages/Markouts";
import { Accounts } from "./pages/Accounts";
import { Engine } from "./pages/Engine";
import { Orders } from "./pages/Orders";
import { History } from "./pages/History";

export function App() {
  const page = useStore((s) => s.page);
  const ready = useStore((s) => s.snap != null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const p = PAGE_KEYS[e.key];
      if (p) useStore.getState().setPage(p);
      if (e.key === "t") {
        const s = useStore.getState();
        s.setTz(s.tz === "utc" ? "local" : "utc");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <Header />
      <AlertBanner />
      <main className="app-main">
        {!ready ? (
          <div className="waiting">Waiting for the first snapshot from the server</div>
        ) : page === "desk" ? (
          <Desk />
        ) : page === "history" ? (
          <History />
        ) : page === "markouts" ? (
          <Markouts />
        ) : page === "orders" ? (
          <Orders />
        ) : page === "accounts" ? (
          <Accounts />
        ) : (
          <Engine />
        )}
      </main>
    </div>
  );
}
