import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

export default function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate("/admin", { replace: true });
    });
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    navigate("/admin", { replace: true });
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f3f4f6", padding: 16 }}>
      <form onSubmit={handleSubmit} style={{ background: "white", padding: 32, borderRadius: 12, width: "100%", maxWidth: 380, boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}>
        <h1 style={{ margin: 0, marginBottom: 8, fontSize: 22, color: "#E30613" }}>Admin Minas Brasil</h1>
        <p style={{ marginTop: 0, marginBottom: 20, color: "#6b7280", fontSize: 14 }}>Acesso restrito ao painel de observabilidade.</p>
        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: "#374151" }}>E-mail</span>
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: "10px 12px", marginTop: 4, border: "1px solid #d1d5db", borderRadius: 6 }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: "#374151" }}>Senha</span>
          <input
            type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: "10px 12px", marginTop: 4, border: "1px solid #d1d5db", borderRadius: 6 }}
          />
        </label>
        {error && <div style={{ background: "#fef2f2", color: "#b91c1c", padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <button type="submit" disabled={loading}
          style={{ width: "100%", padding: 12, background: "#E30613", color: "white", border: 0, borderRadius: 6, fontWeight: 600, cursor: loading ? "default" : "pointer", opacity: loading ? 0.7 : 1 }}>
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}
