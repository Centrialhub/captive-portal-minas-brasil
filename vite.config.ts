import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

function portalStartup() {
  return {
    name: "portal-startup",
    transformIndexHtml(html: string) {
      const source = readFileSync(new URL("./src/portal-boot.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
      if (/<\/script/i.test(source)) throw new Error("Startup protection contains an HTML script terminator");
      if (!html.includes("<!-- PORTAL_BOOT -->")) throw new Error("Missing portal startup placeholder");
      return html.replace("<!-- PORTAL_BOOT -->", `<script id="portal-boot">\n${source}\n</script>`);
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: [
      "wifi-minasbrasil-wifi-minasbrasil.tqchy2.easypanel.host",
      "drogariaminasbrasilapp.com.br",
      "minasbrasilwifi.com.br",
      "187.77.48.59",
    ],
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api/captive-portal": {
        target: "https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/captive-portal/, ""),
      },
    },
  },
  preview: {
    host: "::",
    port: 3000,
    allowedHosts: [
      "wifi-minasbrasil-wifi-minasbrasil.tqchy2.easypanel.host",
      "drogariaminasbrasilapp.com.br",
      "minasbrasilwifi.com.br",
      "187.77.48.59",
    ],

  },
  build: {
    target: "es2015",
  },
  test: {
    exclude: [...configDefaults.exclude, "tmp/**"],
  },
  plugins: [react(), portalStartup()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));
