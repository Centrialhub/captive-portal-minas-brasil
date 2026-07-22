import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: ["wifi-minasbrasil-wifi-minasbrasil.tqchy2.easypanel.host", "wifi.guedesepaixao.com.br", "drogariaminasbrasilapp.com.br"],
    hmr: {
      overlay: false,
    },
  },
  preview: {
    host: "::",
    port: 3000,
    allowedHosts: ["wifi-minasbrasil-wifi-minasbrasil.tqchy2.easypanel.host", "wifi.guedesepaixao.com.br", "drogariaminasbrasilapp.com.br"],

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
