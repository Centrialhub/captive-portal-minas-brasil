import { Link } from "react-router-dom";

const Index = () => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold text-foreground">Captive Portal Wi-Fi</h1>
        <p className="text-muted-foreground">Sistema de captive portal multi-loja para Wi-Fi UniFi.</p>
        <div className="flex gap-3 justify-center">
          <Link to="/admin" className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground">
            Painel Admin
          </Link>
          <Link to="/s/demo" className="rounded border px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
            Portal Demo
          </Link>
        </div>
        <p className="text-xs text-muted-foreground mt-4">
          Portal: <code className="bg-muted px-1 rounded">/s/SLUG</code> ou <code className="bg-muted px-1 rounded">/portal?store=SLUG</code>
        </p>
      </div>
    </div>
  );
};

export default Index;
