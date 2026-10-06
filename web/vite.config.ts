import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend for the dev proxy; override with DESK_API=http://host:port.
const api = process.env.DESK_API ?? "http://127.0.0.1:8710";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 2500 },
});
