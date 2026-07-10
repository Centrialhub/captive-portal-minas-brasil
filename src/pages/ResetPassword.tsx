import { useEffect, useState } from "react";
import { supabase } from "../integrations/supabase/client";
import logoMinasBrasil from "../assets/logo-minas-brasil.png";
import "../index.css";

type Status = "waiting" | "ready" | "saving" | "done" | "error";

export default function ResetPassword() {
  const [status, setStatus] = useState<Status>("waiting");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");

  useEffect(() => {
    // Hide vanilla-JS fallback
    const fb = document.getElementById("fb");
    if (fb) fb.style.display = "none";

    let mounted = true;

    // Supabase-JS parses the recovery hash automatically and emits PASSWORD_RECOVERY.
    // We also inspect getSession() in case the event already fired before we subscribed.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (!mounted) return;
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setStatus("ready");
      }
    });

    (async () => {
      // Wait briefly for the hash to be processed
      await new Promise((r) => setTimeout(r, 400));
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      if (data?.session) {
        setStatus("ready");
      } else if (!window.location.hash.includes("access_token")) {
        setStatus("error");
        setError(
          "Link inválido ou expirado. Solicite um novo e-mail de recuperação no portal Wi-Fi.",
        );
      }
    })();

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("A senha deve ter ao menos 8 caracteres.");
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      return setError("A senha deve conter letras e números.");
    if (password !== password2) return setError("As senhas não coincidem.");

    setStatus("saving");
    const { error: updErr } = await supabase.auth.updateUser({ password });
    if (updErr) {
      setError(updErr.message || "Não foi possível redefinir a senha.");
      setStatus("ready");
      return;
    }
    // Sign out so the reset session doesn't leak into the captive flow
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
    setStatus("done");
  };

  if (status === "waiting") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p style={{ color: "#888", marginTop: 12 }}>Validando link...</p>
        </div>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <h1 className="portal-title">Senha alterada</h1>
          <p className="portal-subtitle">
            Sua senha foi redefinida com sucesso. Volte ao portal Wi-Fi da loja e faça login com a
            nova senha.
          </p>
          <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <h1 className="portal-title">Link inválido</h1>
          <p className="portal-subtitle">{error}</p>
          <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="portal-wrapper">
      <div className="portal-card">
        <div style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
        </div>
        <h1 className="portal-title">Redefinir senha</h1>
        <p className="portal-subtitle">Escolha uma nova senha para sua conta.</p>
        {error && <div className="portal-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <label className="portal-label">Nova senha</label>
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            required minLength={8} className="portal-input"
            placeholder="Mínimo 8 caracteres, letras e números"
            autoComplete="new-password"
          />
          <label className="portal-label">Confirmar nova senha</label>
          <input
            type="password" value={password2} onChange={(e) => setPassword2(e.target.value)}
            required minLength={8} className="portal-input"
            placeholder="Digite a senha novamente"
            autoComplete="new-password"
          />
          <button type="submit" disabled={status === "saving"} className="portal-btn">
            {status === "saving" ? "Salvando..." : "Salvar nova senha"}
          </button>
        </form>
        <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
      </div>
    </div>
  );
}
