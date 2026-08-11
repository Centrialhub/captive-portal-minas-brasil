import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
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
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
