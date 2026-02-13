import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { api } from "@/lib/api";

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
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm space-y-3 rounded border bg-card p-6">
          <h1 className="text-lg font-bold text-foreground">Admin Login</h1>
          {loginError && <p className="text-sm text-destructive">{loginError}</p>}
          <input type="email" placeholder="E-mail" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} required className="w-full rounded border bg-background px-3 py-2 text-foreground" />
          <input type="password" placeholder="Senha" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} required className="w-full rounded border bg-background px-3 py-2 text-foreground" />
          <button type="submit" className="w-full rounded bg-primary px-4 py-2 text-primary-foreground">Entrar</button>
        </form>
      </div>
    );
  }

  const token = session.access_token;

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-foreground">Captive Portal - Admin</h1>
          <button onClick={() => supabase.auth.signOut()} className="rounded border px-3 py-1 text-sm text-muted-foreground hover:text-foreground">Sair</button>
        </div>
        <div className="mb-4 flex gap-2">
          {(["stores", "leads", "consent", "sessions"] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`rounded px-3 py-1 text-sm ${activeTab === tab ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              {tab === "stores" ? "Lojas" : tab === "leads" ? "Leads" : tab === "consent" ? "Consentimento" : "Sessões"}
            </button>
          ))}
        </div>

        {activeTab === "stores" && <StoresTab token={token} />}
        {activeTab === "leads" && <LeadsTab token={token} />}
        {activeTab === "consent" && <ConsentTab token={token} />}
        {activeTab === "sessions" && <SessionsTab token={token} />}
      </div>
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
      <button onClick={() => { setShowForm(!showForm); setEditingId(null); setForm({ slug: "", name: "", city: "", post_auth_redirect_url: "", unifi_controller_url: "", unifi_site_id: "", unifi_api_key_or_token: "" }); }} className="mb-3 rounded bg-primary px-3 py-1 text-sm text-primary-foreground">
        {showForm ? "Cancelar" : "Nova Loja"}
      </button>

      {showForm && (
        <div className="mb-4 space-y-2 rounded border bg-card p-4">
          <input placeholder="Slug (ex: loja01)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
          <input placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
          <input placeholder="Cidade" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
          <input placeholder="URL de redirecionamento pós-auth (opcional)" value={form.post_auth_redirect_url} onChange={(e) => setForm({ ...form, post_auth_redirect_url: e.target.value })} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
          <input placeholder="UniFi Controller URL" value={form.unifi_controller_url} onChange={(e) => setForm({ ...form, unifi_controller_url: e.target.value })} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
          <input placeholder="UniFi Site ID" value={form.unifi_site_id} onChange={(e) => setForm({ ...form, unifi_site_id: e.target.value })} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
          <input placeholder="UniFi API Key / Token" type="password" value={form.unifi_api_key_or_token} onChange={(e) => setForm({ ...form, unifi_api_key_or_token: e.target.value })} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
          <button onClick={handleSave} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">{editingId ? "Atualizar" : "Criar"}</button>
        </div>
      )}

      <table className="w-full text-sm">
        <thead><tr className="border-b text-left text-muted-foreground"><th className="p-2">Slug</th><th className="p-2">Nome</th><th className="p-2">Cidade</th><th className="p-2">Ativo</th><th className="p-2">UniFi</th><th className="p-2"></th></tr></thead>
        <tbody>
          {stores.map((s) => (
            <tr key={s.id} className="border-b text-foreground">
              <td className="p-2 font-mono">{s.slug}</td>
              <td className="p-2">{s.name}</td>
              <td className="p-2">{s.city || "-"}</td>
              <td className="p-2">{s.is_active ? "✅" : "❌"}</td>
              <td className="p-2">{s.unifi_controller_url ? "✅" : "—"}</td>
              <td className="p-2">
                <button onClick={() => { setEditingId(s.id); setForm({ slug: s.slug, name: s.name, city: s.city || "", post_auth_redirect_url: s.post_auth_redirect_url || "", unifi_controller_url: s.unifi_controller_url || "", unifi_site_id: s.unifi_site_id || "", unifi_api_key_or_token: "" }); setShowForm(true); }} className="text-xs text-primary underline">Editar</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

  // Load stores for XML export dropdown
  useEffect(() => {
    (async () => {
      const data = await api.adminRequest("stores", token);
      if (Array.isArray(data)) setStores(data);
    })();
  }, [token]);

  const exportCsv = () => {
    const params = new URLSearchParams({ format: "csv" });
    if (storeFilter) params.set("store_id", storeFilter);
    window.open(`https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal/admin/leads?${params}`, "_blank");
  };

  const exportXml = (scope: "store" | "all", slug?: string) => {
    const params = new URLSearchParams();
    if (scope === "store" && slug) params.set("store_slug", slug);
    else params.set("scope", "all");
    if (xmlFrom) params.set("from", xmlFrom);
    if (xmlTo) params.set("to", xmlTo);
    window.open(`https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal/admin/leads-xml?${params}`, "_blank");
  };

  return (
    <div>
      <div className="mb-3 flex gap-2 items-center flex-wrap">
        <input placeholder="Filtrar por store_id" value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)} className="rounded border bg-background px-3 py-1 text-foreground text-sm" />
        <button onClick={exportCsv} className="rounded border px-3 py-1 text-sm text-muted-foreground">Exportar CSV</button>
        <button onClick={() => exportXml("all")} className="rounded border px-3 py-1 text-sm text-muted-foreground">Exportar XML (todas)</button>
      </div>
      <div className="mb-3 flex gap-2 items-center flex-wrap">
        <label className="text-xs text-muted-foreground">Filtro data XML:</label>
        <input type="date" value={xmlFrom} onChange={(e) => setXmlFrom(e.target.value)} className="rounded border bg-background px-2 py-1 text-foreground text-xs" />
        <span className="text-xs text-muted-foreground">até</span>
        <input type="date" value={xmlTo} onChange={(e) => setXmlTo(e.target.value)} className="rounded border bg-background px-2 py-1 text-foreground text-xs" />
        {stores.length > 0 && (
          <select onChange={(e) => { if (e.target.value) exportXml("store", e.target.value); }} defaultValue="" className="rounded border bg-background px-2 py-1 text-foreground text-xs">
            <option value="" disabled>XML por loja...</option>
            {stores.map((s: any) => (
              <option key={s.id} value={s.slug}>{s.name} ({s.slug})</option>
            ))}
          </select>
        )}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">Total: {leads.total || 0}</p>
      <table className="w-full text-sm">
        <thead><tr className="border-b text-left text-muted-foreground"><th className="p-2">Nome</th><th className="p-2">Email</th><th className="p-2">Telefone</th><th className="p-2">MAC</th><th className="p-2">Loja</th><th className="p-2">Data</th></tr></thead>
        <tbody>
          {(leads.data || []).map((l: any) => (
            <tr key={l.id} className="border-b text-foreground">
              <td className="p-2">{l.name}</td>
              <td className="p-2">{l.email || "-"}</td>
              <td className="p-2">{l.phone || "-"}</td>
              <td className="p-2 font-mono text-xs">{l.client_mac || "-"}</td>
              <td className="p-2">{(l.stores as any)?.slug || "-"}</td>
              <td className="p-2 text-xs">{new Date(l.created_at).toLocaleString("pt-BR")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex gap-2">
        <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="rounded border px-2 py-1 text-xs disabled:opacity-50">Anterior</button>
        <span className="text-xs text-muted-foreground py-1">Página {page}</span>
        <button onClick={() => setPage(page + 1)} className="rounded border px-2 py-1 text-xs">Próxima</button>
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
      <div className="mb-4 space-y-2 rounded border bg-card p-4">
        <h3 className="text-sm font-medium text-foreground">Nova versão de consentimento</h3>
        <input placeholder="Versão (ex: v1.1)" value={newVersion} onChange={(e) => setNewVersion(e.target.value)} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
        <textarea placeholder="Texto do consentimento..." value={newText} onChange={(e) => setNewText(e.target.value)} rows={4} className="w-full rounded border bg-background px-3 py-2 text-foreground text-sm" />
        <button onClick={handleCreate} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">Publicar</button>
      </div>

      <h3 className="mb-2 text-sm font-medium text-foreground">Versões existentes</h3>
      {versions.map((v) => (
        <div key={v.id} className="mb-2 rounded border p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-foreground">{v.version}</span>
            {v.is_active && <span className="rounded bg-primary/20 px-2 py-0.5 text-xs text-primary">Ativa</span>}
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

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">Total: {sessions.total || 0}</p>
      <table className="w-full text-sm">
        <thead><tr className="border-b text-left text-muted-foreground"><th className="p-2">Status</th><th className="p-2">MAC</th><th className="p-2">IP</th><th className="p-2">SSID</th><th className="p-2">Loja</th><th className="p-2">Início</th></tr></thead>
        <tbody>
          {(sessions.data || []).map((s: any) => (
            <tr key={s.id} className="border-b text-foreground">
              <td className="p-2">
                <span className={`inline-block rounded px-2 py-0.5 text-xs ${s.status === "authorized" ? "bg-green-100 text-green-800" : s.status === "failed" ? "bg-red-100 text-red-800" : s.status === "submitted" ? "bg-blue-100 text-blue-800" : "bg-muted text-muted-foreground"}`}>
                  {s.status}
                </span>
              </td>
              <td className="p-2 font-mono text-xs">{s.client_mac || "-"}</td>
              <td className="p-2 text-xs">{s.client_ip || "-"}</td>
              <td className="p-2 text-xs">{s.ssid || "-"}</td>
              <td className="p-2">{(s.stores as any)?.slug || "-"}</td>
              <td className="p-2 text-xs">{new Date(s.started_at).toLocaleString("pt-BR")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex gap-2">
        <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="rounded border px-2 py-1 text-xs disabled:opacity-50">Anterior</button>
        <span className="text-xs text-muted-foreground py-1">Página {page}</span>
        <button onClick={() => setPage(page + 1)} className="rounded border px-2 py-1 text-xs">Próxima</button>
      </div>
    </div>
  );
}
