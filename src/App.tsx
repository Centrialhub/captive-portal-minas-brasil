import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import CaptivePortal from "./pages/CaptivePortal";
import AdminPanel from "./pages/AdminPanel";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Portal público: "/" com ?store=SLUG */}
          <Route path="/" element={<CaptivePortal />} />

          {/* Admin em /auth/admin */}
          <Route path="/auth/admin" element={<AdminPanel />} />

          {/* Redirects de rotas antigas */}
          <Route path="/admin" element={<Navigate to="/auth/admin" replace />} />
          <Route path="/s/:slug" element={<SlugRedirect />} />
          <Route path="/portal" element={<CaptivePortal />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

/** Converte /s/SLUG → /?store=SLUG mantendo outros query params */
function SlugRedirect() {
  const pathParts = window.location.pathname.split("/");
  const sIdx = pathParts.indexOf("s");
  const slug = sIdx >= 0 ? pathParts[sIdx + 1] : "";
  const params = new URLSearchParams(window.location.search);
  if (slug) params.set("store", slug);
  return <Navigate to={`/?${params.toString()}`} replace />;
}

export default App;
