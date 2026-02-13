import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { api } from "@/lib/api";
import logoMinasBrasil from "@/assets/logo-minas-brasil.png";

export default function AdminPanel() {
  const [session, setSession] = useState<{ access_token: string } | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [activeTab, setActiveTab] = useState<"stores" | "leads" | "consent" | "sessions">("stores");

  useEffect(() => {
    supabase.auth.onAuthStateChange((_event, s) => {
      if (s?.access_token) setSession({ access_token: s.access_token });
      else setSession(null);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.access_token) setSession({ access_token: data.session.access_token });
    });
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPassword });
    if (error) setLoginError(error.message);
  };

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-primary p-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm space-y-4 rounded-xl bg-card p-8 shadow-2xl">
          <div className="text-center">
            <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="mx-auto mb-3 h-14 object-contain" />
            <h1 className="text-lg font-bold text-foreground">Painel Administrativo</h1>
          </div>
          {loginError && <p className="text-sm text-destructive font-medium">{loginError}</p>}
          <input type="email" placeholder="E-mail" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} required className="w-full rounded-lg border-2 border-border bg-background px-3 py-2.5 text-foreground focus:border-secondary outline-none" />
          <input type="password" placeholder="Senha" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} required className="w-full rounded-lg border-2 border-border bg-background px-3 py-2.5 text-foreground focus:border-secondary outline-none" />
          <button type="submit" className="w-full rounded-lg bg-secondary px-4 py-3 font-bold text-secondary-foreground hover:bg-brand-yellow-hover transition-colors">Entrar</button>
        </form>
      </div>
    );
  }

  const token = session.access_token;
  const tabs = [
    { key: "stores" as const, label: "Lojas" },
    { key: "leads" as const, label: "Leads" },
    { key: "consent" as const, label: "Consentimento" },
    { key: "sessions" as const, label: "Sessões" },
  ];

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-primary text-primary-foreground flex flex-col shrink-0">
        <div className="p-4 border-b border-primary-foreground/20">
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="h-10 object-contain brightness-0 invert" />
          <p className="text-[10px] mt-1 opacity-70 font-medium tracking-wide">PAINEL ADMIN</p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "text-primary-foreground/70 hover:bg-primary-foreground/10 hover:text-primary-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-primary-foreground/20">
          <button onClick={() => supabase.auth.signOut()} className="w-full rounded-lg border border-primary-foreground/30 px-3 py-1.5 text-xs text-primary-foreground/80 hover:bg-primary-foreground/10 transition-colors">
            Sair
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        {/* Top red stripe */}
        <div className="h-1 bg-primary" />
        <header className="bg-card border-b px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-bold text-foreground">
            {tabs.find((t) => t.key === activeTab)?.label}
          </h1>
        </header>

        <main className="flex-1 p-6 bg-muted/30">
          <div className="mx-auto max-w-5xl">
            {activeTab === "stores" && <StoresTab token={token} />}
            {activeTab === "leads" && <LeadsTab token={token} />}
            {activeTab === "consent" && <ConsentTab token={token} />}
            {activeTab === "sessions" && <SessionsTab token={token} />}
          </div>
        </main>
      </div>
    </div>
  );
}

/* ============ Branded table wrapper ============ */
function BrandedTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-primary text-primary-foreground">
            {headers.map((h) => (
              <th key={h} className="p-3 text-left text-xs font-bold uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {children}
        </tbody>
      </table>
    </div>
  );
}

function StoresTab({ token }: { token: string }) {
  const [stores, setStores] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ slug: "", name: "", city: "", post_auth_redirect_url: "", unifi_controller_url: "", unifi_site_id: "", unifi_api_key_or_token: "" });
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api.adminRequest("stores", token);
    if (Array.isArray(data)) setStores(data);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (editingId) {
      await api.adminRequest("stores", token, { method: "PUT", body: JSON.stringify({ id: editingId, ...form }) });
    } else {
      await api.adminRequest("stores", token, { method: "POST", body: JSON.stringify(form) });
    }
    setShowForm(false);
    setEditingId(null);
    setForm({ slug: "", name: "", city: "", post_auth_redirect_url: "", unifi_controller_url: "", unifi_site_id: "", unifi_api_key_or_token: "" });
    load();
  };

  return (
    <div>
      <button onClick={() => { setShowForm(!showForm); setEditingId(null); setForm({ slug: "", name: "", city: "", post_auth_redirect_url: "", unifi_controller_url: "", unifi_site_id: "", unifi_api_key_or_token: "" }); }} className="mb-4 rounded-lg bg-secondary px-4 py-2 text-sm font-bold text-secondary-foreground hover:bg-brand-yellow-hover transition-colors">
        {showForm ? "Cancelar" : "Nova Loja"}
      </button>

      {showForm && (
        <div className="mb-4 space-y-2 rounded-lg border bg-card p-5">
          <input placeholder="Slug (ex: loja01)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
          <input placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
          <input placeholder="Cidade" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
          <input placeholder="URL de redirecionamento pós-auth (opcional)" value={form.post_auth_redirect_url} onChange={(e) => setForm({ ...form, post_auth_redirect_url: e.target.value })} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
          <input placeholder="UniFi Controller URL" value={form.unifi_controller_url} onChange={(e) => setForm({ ...form, unifi_controller_url: e.target.value })} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
          <input placeholder="UniFi Site ID" value={form.unifi_site_id} onChange={(e) => setForm({ ...form, unifi_site_id: e.target.value })} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
          <input placeholder="UniFi API Key / Token" type="password" value={form.unifi_api_key_or_token} onChange={(e) => setForm({ ...form, unifi_api_key_or_token: e.target.value })} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
          <button onClick={handleSave} className="rounded-lg bg-secondary px-4 py-2 text-sm font-bold text-secondary-foreground hover:bg-brand-yellow-hover transition-colors">{editingId ? "Atualizar" : "Criar"}</button>
        </div>
      )}

      <BrandedTable headers={["Slug", "Nome", "Cidade", "Ativo", "UniFi", ""]}>
        {stores.map((s, i) => (
          <tr key={s.id} className={i % 2 === 0 ? "bg-card" : "bg-muted/40"}>
            <td className="p-3 font-mono text-xs">{s.slug}</td>
            <td className="p-3">{s.name}</td>
            <td className="p-3">{s.city || "-"}</td>
            <td className="p-3">{s.is_active ? "✅" : "❌"}</td>
            <td className="p-3">{s.unifi_controller_url ? "✅" : "—"}</td>
            <td className="p-3">
              <button onClick={() => { setEditingId(s.id); setForm({ slug: s.slug, name: s.name, city: s.city || "", post_auth_redirect_url: s.post_auth_redirect_url || "", unifi_controller_url: s.unifi_controller_url || "", unifi_site_id: s.unifi_site_id || "", unifi_api_key_or_token: "" }); setShowForm(true); }} className="text-xs font-medium text-primary hover:underline">Editar</button>
            </td>
          </tr>
        ))}
      </BrandedTable>
    </div>
  );
}

function LeadsTab({ token }: { token: string }) {
  const [leads, setLeads] = useState<any>({ data: [], total: 0 });
  const [storeFilter, setStoreFilter] = useState("");
  const [page, setPage] = useState(1);
  const [xmlFrom, setXmlFrom] = useState("");
  const [xmlTo, setXmlTo] = useState("");
  const [stores, setStores] = useState<any[]>([]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (storeFilter) params.set("store_id", storeFilter);
    const data = await api.adminRequest(`leads?${params}`, token);
    setLeads(data);
  }, [token, page, storeFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      const data = await api.adminRequest("stores", token);
      if (Array.isArray(data)) setStores(data);
    })();
  }, [token]);

  const downloadBlob = async (url: string, defaultFilename: string) => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        alert(`Erro ao exportar: ${err.error || res.statusText}`);
        return;
      }
      const disposition = res.headers.get("Content-Disposition");
      const match = disposition?.match(/filename="?([^";\s]+)"?/);
      const filename = match?.[1] || defaultFilename;
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      alert("Erro de rede ao exportar.");
    }
  };

  const exportCsv = () => {
    const params = new URLSearchParams({ format: "csv" });
    if (storeFilter) params.set("store_id", storeFilter);
    downloadBlob(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/captive-portal/admin/leads?${params}`, `leads_${new Date().toISOString().slice(0,10)}.csv`);
  };

  const exportXml = (scope: "store" | "all", slug?: string) => {
    const params = new URLSearchParams();
    if (scope === "store" && slug) params.set("store_slug", slug);
    else params.set("scope", "all");
    if (xmlFrom) params.set("from", xmlFrom);
    if (xmlTo) params.set("to", xmlTo);
    downloadBlob(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/captive-portal/admin/leads-xml?${params}`, slug ? `leads_${slug}.xml` : `leads_all.xml`);
  };

  return (
    <div>
      <div className="mb-4 flex gap-2 items-center flex-wrap">
        <input placeholder="Filtrar por store_id" value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)} className="rounded-lg border-2 border-border bg-background px-3 py-1.5 text-foreground text-sm focus:border-secondary outline-none" />
        <button onClick={exportCsv} className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-80 transition-opacity">Exportar CSV</button>
        <button onClick={() => exportXml("all")} className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-80 transition-opacity">Exportar XML (todas)</button>
      </div>
      <div className="mb-4 flex gap-2 items-center flex-wrap">
        <label className="text-xs text-muted-foreground font-medium">Filtro data XML:</label>
        <input type="date" value={xmlFrom} onChange={(e) => setXmlFrom(e.target.value)} className="rounded-lg border-2 border-border bg-background px-2 py-1 text-foreground text-xs focus:border-secondary outline-none" />
        <span className="text-xs text-muted-foreground">até</span>
        <input type="date" value={xmlTo} onChange={(e) => setXmlTo(e.target.value)} className="rounded-lg border-2 border-border bg-background px-2 py-1 text-foreground text-xs focus:border-secondary outline-none" />
        {stores.length > 0 && (
          <select onChange={(e) => { if (e.target.value) exportXml("store", e.target.value); }} defaultValue="" className="rounded-lg border-2 border-border bg-background px-2 py-1 text-foreground text-xs focus:border-secondary outline-none">
            <option value="" disabled>XML por loja...</option>
            {stores.map((s: any) => (
              <option key={s.id} value={s.slug}>{s.name} ({s.slug})</option>
            ))}
          </select>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground font-medium">Total: {leads.total || 0}</p>
      <BrandedTable headers={["Nome", "Email", "Telefone", "MAC", "Loja", "Data"]}>
        {(leads.data || []).map((l: any, i: number) => (
          <tr key={l.id} className={i % 2 === 0 ? "bg-card" : "bg-muted/40"}>
            <td className="p-3">{l.name}</td>
            <td className="p-3">{l.email || "-"}</td>
            <td className="p-3">{l.phone || "-"}</td>
            <td className="p-3 font-mono text-xs">{l.client_mac || "-"}</td>
            <td className="p-3">{(l.stores as any)?.slug || "-"}</td>
            <td className="p-3 text-xs">{new Date(l.created_at).toLocaleString("pt-BR")}</td>
          </tr>
        ))}
      </BrandedTable>
      <div className="mt-3 flex gap-2">
        <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="rounded-lg border-2 border-border px-3 py-1 text-xs font-medium disabled:opacity-50 hover:bg-muted transition-colors">Anterior</button>
        <span className="text-xs text-muted-foreground py-1 font-medium">Página {page}</span>
        <button onClick={() => setPage(page + 1)} className="rounded-lg border-2 border-border px-3 py-1 text-xs font-medium hover:bg-muted transition-colors">Próxima</button>
      </div>
    </div>
  );
}

function ConsentTab({ token }: { token: string }) {
  const [versions, setVersions] = useState<any[]>([]);
  const [newVersion, setNewVersion] = useState("");
  const [newText, setNewText] = useState("");

  const load = useCallback(async () => {
    const data = await api.adminRequest("consent", token);
    if (Array.isArray(data)) setVersions(data);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newVersion || !newText) return;
    await api.adminRequest("consent", token, { method: "POST", body: JSON.stringify({ version: newVersion, text: newText }) });
    setNewVersion("");
    setNewText("");
    load();
  };

  return (
    <div>
      <div className="mb-4 space-y-3 rounded-lg border bg-card p-5">
        <h3 className="text-sm font-bold text-foreground">Nova versão de consentimento</h3>
        <input placeholder="Versão (ex: v1.1)" value={newVersion} onChange={(e) => setNewVersion(e.target.value)} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
        <textarea placeholder="Texto do consentimento..." value={newText} onChange={(e) => setNewText(e.target.value)} rows={4} className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-foreground text-sm focus:border-secondary outline-none" />
        <button onClick={handleCreate} className="rounded-lg bg-secondary px-4 py-2 text-sm font-bold text-secondary-foreground hover:bg-brand-yellow-hover transition-colors">Publicar</button>
      </div>

      <h3 className="mb-3 text-sm font-bold text-foreground">Versões existentes</h3>
      {versions.map((v) => (
        <div key={v.id} className="mb-2 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-foreground">{v.version}</span>
            {v.is_active && <span className="rounded-full bg-secondary/20 px-2 py-0.5 text-xs font-bold text-secondary-foreground">Ativa</span>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground whitespace-pre-line">{v.text}</p>
        </div>
      ))}
    </div>
  );
}

function SessionsTab({ token }: { token: string }) {
  const [sessions, setSessions] = useState<any>({ data: [], total: 0 });
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    const data = await api.adminRequest(`sessions?page=${page}&limit=50`, token);
    setSessions(data);
  }, [token, page]);

  useEffect(() => { load(); }, [load]);

  const statusStyles: Record<string, string> = {
    authorized: "bg-brand-success-bg text-brand-success",
    failed: "bg-destructive/10 text-destructive",
    submitted: "bg-secondary/20 text-secondary-foreground",
  };

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground font-medium">Total: {sessions.total || 0}</p>
      <BrandedTable headers={["Status", "MAC", "IP", "SSID", "Loja", "Início"]}>
        {(sessions.data || []).map((s: any, i: number) => (
          <tr key={s.id} className={i % 2 === 0 ? "bg-card" : "bg-muted/40"}>
            <td className="p-3">
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${statusStyles[s.status] || "bg-muted text-muted-foreground"}`}>
                {s.status}
              </span>
            </td>
            <td className="p-3 font-mono text-xs">{s.client_mac || "-"}</td>
            <td className="p-3 text-xs">{s.client_ip || "-"}</td>
            <td className="p-3 text-xs">{s.ssid || "-"}</td>
            <td className="p-3">{(s.stores as any)?.slug || "-"}</td>
            <td className="p-3 text-xs">{new Date(s.started_at).toLocaleString("pt-BR")}</td>
          </tr>
        ))}
      </BrandedTable>
      <div className="mt-3 flex gap-2">
        <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="rounded-lg border-2 border-border px-3 py-1 text-xs font-medium disabled:opacity-50 hover:bg-muted transition-colors">Anterior</button>
        <span className="text-xs text-muted-foreground py-1 font-medium">Página {page}</span>
        <button onClick={() => setPage(page + 1)} className="rounded-lg border-2 border-border px-3 py-1 text-xs font-medium hover:bg-muted transition-colors">Próxima</button>
      </div>
    </div>
  );
}
