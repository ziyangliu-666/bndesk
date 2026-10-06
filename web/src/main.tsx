import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@mantine/core/styles.css";
import "./styles.css";
import { theme } from "./theme";
import { App } from "./App";
import { useStore } from "./store";
import { connect } from "./ws";

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

// An open dashboard reloads itself when a new build of the page is deployed.
if (import.meta.env.VITE_MOCK !== "1") {
  let build: number | null | undefined;
  setInterval(async () => {
    try {
      const h = (await (await fetch("/api/health", { cache: "no-store" })).json()) as { web_build?: number | null };
      if (build === undefined) build = h.web_build ?? null;
      else if (h.web_build != null && h.web_build !== build) location.reload();
    } catch {
      /* server restarting */
    }
  }, 30_000);
}
