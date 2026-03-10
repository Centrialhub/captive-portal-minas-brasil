import { createRoot } from "react-dom/client";
import App from "./App";

// Do NOT hide fallback here — wait until React App signals it's ready
createRoot(document.getElementById("root")!).render(<App />);
