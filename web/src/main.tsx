import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@mantine/core/styles.css";
import "./styles.css";
import "./mobile.css";
import { theme } from "./theme";
import { App } from "./App";
import { useStore } from "./store";
import { connect } from "./ws";
import { reloadOnce } from "./components/LoadBoundary";

// A chunk (or its CSS) of an older build is gone after a deploy: reload once for the new one. When that was
// just tried, the error goes on to the page's boundary, which shows a line with Reload.
window.addEventListener("vite:preloadError", (e) => {
  if (reloadOnce()) e.preventDefault();
});

if (import.meta.env.VITE_MOCK === "1") {
  void import("./mock").then(({ startMock }) => {
    // Round-trip through JSON so the mock exercises the same shapes as the wire.
    startMock((m) => useStore.getState().apply(JSON.parse(JSON.stringify(m))));
  });
} else {
  connect();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <App />
    </MantineProvider>
  </StrictMode>,
);

// An open dashboard reloads itself when a new build of the page is deployed: every 30 s while shown, and at
// once when the tab (or the phone) comes back, before a tap asks for a chunk the deploy removed.
if (import.meta.env.VITE_MOCK !== "1") {
  let build: number | null | undefined;
  let busy = false;
  const check = async () => {
    if (document.visibilityState === "hidden" || busy) return;
    busy = true;
    try {
      const h = (await (await fetch("/api/health", { cache: "no-store" })).json()) as { web_build?: number | null };
      if (build === undefined) build = h.web_build ?? null;
      else if (h.web_build != null && h.web_build !== build) location.reload();
    } catch {
      /* server restarting */
    } finally {
      busy = false;
    }
  };
  void check();
  setInterval(check, 30_000);
  document.addEventListener("visibilitychange", () => void check());
}
