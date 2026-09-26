import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import AdminLogin from "./pages/AdminLogin";
import AdminDashboard from "./pages/AdminDashboard";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import { PortalStartupBoundary } from "./components/PortalStartupBoundary";
// The boundary acknowledges startup only after React has committed the page.
createRoot(document.getElementById("root")!).render(
  <PortalStartupBoundary>
    <BrowserRouter>
      <Routes>
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/politica-privacidade" element={<PrivacyPolicy />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </PortalStartupBoundary>
);
