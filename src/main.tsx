import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// SPA fallback: restore original URL after 404.html redirect
const redirect = sessionStorage.getItem('redirect');
if (redirect) {
  sessionStorage.removeItem('redirect');
  const url = new URL(redirect);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

createRoot(document.getElementById("root")!).render(<App />);
