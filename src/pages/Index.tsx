import { Link } from "react-router-dom";
import logoMinasBrasil from "@/assets/logo-minas-brasil.png";
import brazilMap from "@/assets/brazil-map.png";

const Index = () => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-primary p-4 relative overflow-hidden">
      <img src={brazilMap} alt="" className="absolute right-0 bottom-0 h-72 opacity-10 pointer-events-none" />
      <div className="relative z-10 text-center space-y-5 bg-card rounded-xl p-8 shadow-2xl max-w-md w-full">
        <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="mx-auto h-16 object-contain" />
        <h1 className="text-xl font-extrabold text-foreground">Captive Portal Wi-Fi</h1>
        <p className="text-muted-foreground text-sm">Sistema de captive portal multi-loja para Wi-Fi.</p>
        <div className="flex gap-3 justify-center">
          <Link to="/admin" className="rounded-lg bg-secondary px-5 py-2.5 text-sm font-bold text-secondary-foreground hover:bg-brand-yellow-hover transition-colors">
            Painel Admin
          </Link>
          <Link to="/s/demo" className="rounded-lg border-2 border-border px-5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground transition-colors">
            Portal Demo
          </Link>
        </div>
        <p className="text-xs text-muted-foreground mt-4">
          Portal: <code className="bg-muted px-1.5 py-0.5 rounded text-foreground font-mono">/s/SLUG</code>
        </p>
      </div>
    </div>
  );
};

export default Index;
