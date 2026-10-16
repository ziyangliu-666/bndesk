import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

// Backend for the dev proxy; override with DESK_API=http://host:port.
const api = process.env.DESK_API ?? "http://127.0.0.1:8710";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

type Chunk = { type: "chunk"; fileName: string; facadeModuleId: string | null; imports: string[]; isEntry: boolean; viteMetadata?: { importedCss: Set<string> } };

/** The files a chunk needs before it runs: itself, its static imports, their CSS. */
function closure(bundle: Record<string, { type: string }>, start: Chunk): string[] {
  const out = new Set<string>();
  const walk = (c: Chunk) => {
    if (out.has(c.fileName)) return;
    out.add(c.fileName);
    c.viteMetadata?.importedCss.forEach((f) => out.add(f));
    for (const i of c.imports) {
      const d = bundle[i] as Chunk | undefined;
      if (d?.type === "chunk") walk(d);
    }
  };
  walk(start);
  return [...out];
}

/**
 * The Desk page is a lazy chunk on both layouts (a phone never loads AG Grid), so its files would be asked for
 * only once the entry has run. A script in index.html asks for the layout's Desk files at once instead, alongside
 * the entry's: `modulepreload` for scripts, `preload` for its CSS. The phone test mirrors responsive.ts.
 */
function preloadDesk(): Plugin {
  let base = "/";
  return {
    name: "preload-desk",
    apply: "build",
    configResolved(c) {
      base = c.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle as Record<string, { type: string }> | undefined;
        if (!bundle) return html;
        const chunks = Object.values(bundle).filter((c): c is Chunk => c.type === "chunk") as Chunk[];
        const entry = chunks.find((c) => c.isEntry);
        const find = (src: string) => chunks.find((c) => c.facadeModuleId?.replaceAll("\\", "/").endsWith(src));
        const desk = find("/src/pages/Desk.tsx");
        const phone = find("/src/pages/mobile/DeskM.tsx");
        if (!entry || !desk || !phone) return html;
        const have = new Set(closure(bundle, entry));
        const files = (c: Chunk) => closure(bundle, c).filter((f) => !have.has(f)).map((f) => base + f);
        const script = `(function(){var m=function(q){return matchMedia(q).matches};var p=m("(max-width: 47.99em)")||(m("(pointer: coarse)")&&Math.min(screen.width,screen.height)<=480);var fs=p?${JSON.stringify(files(phone))}:${JSON.stringify(files(desk))};fs.forEach(function(f){var l=document.createElement("link");if(/\\.css$/.test(f)){l.rel="preload";l.as="style"}else{l.rel="modulepreload"}l.crossOrigin="";l.href=f;document.head.appendChild(l)})})();`;
        // first in the head: a script after a stylesheet waits for it
        return html.replace(/<meta charset="UTF-8" \/>\n/, (m) => `${m}    <script>${script}</script>\n`);
      },
    },
  };
}

/** `.br` and `.gz` next to each text file of the build, best compression: the server sends them as they are
 *  (ServeFile's precompressed files) instead of gzipping each response. */
function precompress(): Plugin {
  let out = "dist";
  return {
    name: "precompress",
    apply: "build",
    configResolved(c) {
      out = c.build.outDir.startsWith("/") ? c.build.outDir : join(c.root, c.build.outDir);
    },
    closeBundle() {
      const walk = (dir: string) => {
        for (const n of readdirSync(dir)) {
          const p = join(dir, n);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(js|css|html|svg|json|webmanifest|txt)$/.test(n) && statSync(p).size >= 1024) {
            const b = readFileSync(p);
            writeFileSync(p + ".br", brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: b.length } }));
            writeFileSync(p + ".gz", gzipSync(b, { level: 9 }));
          }
        }
      };
      walk(out);
    },
  };
}

/** Lightweight Charts starts its touch tracking (the crosshair under a resting finger) after a fixed 240 ms; a thumb
 *  that rests that long before a scroll got caught. Here it is 380 ms, close to the quote map's 320 ms. Fails the
 *  build if the library's code no longer has the pattern (check the new version's long-tap delay). */
const LONG_TAP_MS = 380;
function longTap(): Plugin {
  return {
    name: "lwc-long-tap",
    enforce: "pre",
    transform(code, id) {
      if (!/lightweight-charts[\\/]dist[\\/].*\.m?js$/.test(id)) return null;
      const re = /(setTimeout\(this\.[\w$]+\.bind\(this,\s*\w+\),\s*)240(\s*(?:\/\* Delay\.LongTap \*\/)?\))/;
      if (!re.test(code)) this.error("lwc-long-tap: the long-tap delay was not found in " + id);
      return { code: code.replace(re, `$1${LONG_TAP_MS}$2`), map: null };
    },
  };
}

export default defineConfig({
  plugins: [longTap(), react(), preloadDesk(), precompress()],
  // pre-bundled deps skip the transform above: the dev server serves this one as it is, through it
  optimizeDeps: { exclude: ["lightweight-charts"] },
  // shown on the phone's More page
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILT__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 2500 },
});
