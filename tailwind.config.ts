import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    extend: {
      colors: {
        brand: {
          red: "#c0392b",
          yellow: "#f5c542",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
