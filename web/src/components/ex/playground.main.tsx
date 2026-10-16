// Dev-only entry for /ex-playground.html (see Playground.tsx). Boots the store like main.tsx does.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@mantine/core/styles.css";
import "../../styles.css";
import "../../mobile.css";
import { theme } from "../../theme";
import { useStore } from "../../store";
import { connect } from "../../ws";
import { Playground } from "./Playground";

if (import.meta.env.VITE_MOCK === "1") {
  void import("../../mock").then(({ startMock }) => startMock((m) => useStore.getState().apply(JSON.parse(JSON.stringify(m)))));
} else connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <Playground />
    </MantineProvider>
  </StrictMode>,
);
