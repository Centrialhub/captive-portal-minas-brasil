import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import AdminLogin from "./pages/AdminLogin";
import AdminDashboard from "./pages/AdminDashboard";

// Do NOT hide fallback here — wait until React App signals it's ready
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminDashboard />} />
      <Route path="*" element={<App />} />
    </Routes>
  </BrowserRouter>
);
