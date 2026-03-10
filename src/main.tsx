import { createRoot } from "react-dom/client";
import App from "./App";

// When React mounts, hide the HTML fallback
const fallback = document.getElementById("fb");
if (fallback) fallback.style.display = "none";

createRoot(document.getElementById("root")!).render(<App />);
