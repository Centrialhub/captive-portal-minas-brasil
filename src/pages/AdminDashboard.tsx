import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

interface SessionRow {
  id: string;
  trace_id: string | null;
  store_id: string | null;
  client_mac: string | null;
  client_ip: string | null;
  status: string;
  last_step: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  fail_reason: string | null;
  started_at: string;
  params_received_at: string | null;
  form_submitted_at: string | null;
  otp_sent_at: string | null;
  otp_verified_at: string | null;
  unifi_authorize_called_at: string | null;
  unifi_confirmed_at: string | null;
  redirect_served_at: string | null;
  total_latency_ms: number | null;
}

interface EventRow {
  id: string;
  created_at: string;
  event_type: string;
  step: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number | null;
  payload: any;
}

const STEPS = ["params", "form", "otp", "unifi", "redirect"] as const;
const STATUSES = ["started", "submitted", "authorized", "failed"] as const;

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString("pt-BR", { hour12: false }) : "—";
const dur = (a: string | null, b: string | null) => {
  if (!a || !b) return null;
  return `${Math.round((new Date(b).getTime() - new Date(a).getTime()) / 100) / 10}s`;
};

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [userEmail, setUserEmail] = useState<string>("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [stepFilter, setStepFilter] = useState<string>("");
  const [searchTrace, setSearchTrace] = useState("");
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  // Auth gate
  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        navigate("/admin/login", { replace: true });
        return;
      }
      setUserEmail(data.session.user.email || "");
      const { data: roleRow } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", data.session.user.id)
        .eq("role", "admin")
        .maybeSingle();
      setIsAdmin(!!roleRow);
    };
    init();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) navigate("/admin/login", { replace: true });
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  const loadSessions = async () => {
    setLoading(true);
    let q = supabase
      .from("captive_sessions")
      .select("id,trace_id,store_id,client_mac,client_ip,status,last_step,last_error_code,last_error_message,fail_reason,started_at,params_received_at,form_submitted_at,otp_sent_at,otp_verified_at,unifi_authorize_called_at,unifi_confirmed_at,redirect_served_at,total_latency_ms")
      .order("started_at", { ascending: false })
      .limit(200);
    if (statusFilter) q = q.eq("status", statusFilter as any);
    if (stepFilter) q = q.eq("last_step", stepFilter);
    if (searchTrace.trim()) q = q.eq("trace_id", searchTrace.trim());
    const { data, error } = await q;
    if (error) console.error(error);
    setSessions((data as SessionRow[]) || []);
    setLoading(false);
  };

  useEffect(() => { if (isAdmin) loadSessions(); /* eslint-disable-next-line */ }, [isAdmin, statusFilter, stepFilter]);

  const openSession = async (s: SessionRow) => {
    setSelected(s);
    setLoadingEvents(true);
    const { data } = await supabase
      .from("portal_events")
      .select("id,created_at,event_type,step,status,error_code,error_message,latency_ms,payload")
      .eq("session_id", s.id)
      .order("created_at", { ascending: true });
    setEvents((data as EventRow[]) || []);
    setLoadingEvents(false);
  };

  const funnel = useMemo(() => {
    const total = sessions.length;
    const formSubmitted = sessions.filter(s => !!s.form_submitted_at).length;
    const otpSent = sessions.filter(s => !!s.otp_sent_at).length;
    const otpVerified = sessions.filter(s => !!s.otp_verified_at).length;
    const unifiCalled = sessions.filter(s => !!s.unifi_authorize_called_at).length;
    const unifiConfirmed = sessions.filter(s => !!s.unifi_confirmed_at).length;
    return { total, formSubmitted, otpSent, otpVerified, unifiCalled, unifiConfirmed };
  }, [sessions]);

  if (isAdmin === null) {
    return <div style={{ padding: 32 }}>Carregando…</div>;
  }
  if (!isAdmin) {
    return (
      <div style={{ padding: 32, maxWidth: 600 }}>
        <h1 style={{ color: "#E30613" }}>Acesso negado</h1>
        <p>Sua conta ({userEmail}) não tem permissão de admin.</p>
        <p style={{ fontSize: 13, color: "#6b7280" }}>
          Para liberar o acesso, insira uma linha em <code>user_roles</code> com seu user_id e role = 'admin'.
        </p>
        <button onClick={() => supabase.auth.signOut()} style={btnSecondary}>Sair</button>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f9fafb", padding: 24 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, color: "#E30613", fontSize: 22 }}>Observabilidade — Captive Portal</h1>
          <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>{userEmail}</p>
        </div>
        <button onClick={() => supabase.auth.signOut()} style={btnSecondary}>Sair</button>
      </header>

      {/* Funnel */}
      <section style={cardStyle}>
        <h2 style={h2Style}>Funil (últimas {sessions.length} sessões)</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginTop: 12 }}>
          <Stat label="Sessões" value={funnel.total} />
          <Stat label="Formulário" value={funnel.formSubmitted} pct={funnel.total ? funnel.formSubmitted / funnel.total : 0} />
          <Stat label="OTP enviado" value={funnel.otpSent} pct={funnel.total ? funnel.otpSent / funnel.total : 0} />
          <Stat label="OTP verificado" value={funnel.otpVerified} pct={funnel.total ? funnel.otpVerified / funnel.total : 0} />
          <Stat label="UniFi chamado" value={funnel.unifiCalled} pct={funnel.total ? funnel.unifiCalled / funnel.total : 0} />
          <Stat label="UniFi confirmado" value={funnel.unifiConfirmed} pct={funnel.total ? funnel.unifiConfirmed / funnel.total : 0} highlight />
        </div>
      </section>

      {/* Filters */}
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <Field label="Status">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
              <option value="">Todos</option>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Última etapa">
            <select value={stepFilter} onChange={(e) => setStepFilter(e.target.value)} style={inputStyle}>
              <option value="">Todas</option>
              {STEPS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Trace ID">
            <input value={searchTrace} onChange={(e) => setSearchTrace(e.target.value)}
              placeholder="cole um trace_id"
              style={{ ...inputStyle, width: 280 }}
              onKeyDown={(e) => { if (e.key === "Enter") loadSessions(); }}
            />
          </Field>
          <button onClick={loadSessions} style={btnPrimary}>{loading ? "Carregando…" : "Atualizar"}</button>
        </div>
      </section>

      {/* Sessions table */}
      <section style={{ ...cardStyle, marginTop: 16, overflowX: "auto" }}>
        <h2 style={h2Style}>Sessões</h2>
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginTop: 8 }}>
          <thead>
            <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
              <Th>Iniciado</Th><Th>Status</Th><Th>Etapa</Th><Th>MAC</Th>
              <Th>IP</Th><Th>Erro</Th><Th>Latência</Th><Th>Trace</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                <Td>{fmt(s.started_at)}</Td>
                <Td><StatusPill status={s.status} /></Td>
                <Td>{s.last_step || "—"}</Td>
                <Td style={{ fontFamily: "monospace", fontSize: 11 }}>{s.client_mac || "—"}</Td>
                <Td style={{ fontFamily: "monospace", fontSize: 11 }}>{s.client_ip || "—"}</Td>
                <Td style={{ color: "#b91c1c" }}>{s.last_error_code || s.fail_reason || "—"}</Td>
                <Td>{s.total_latency_ms ? `${s.total_latency_ms}ms` : "—"}</Td>
                <Td style={{ fontFamily: "monospace", fontSize: 10 }}>{s.trace_id ? s.trace_id.slice(0, 8) : "—"}</Td>
                <Td><button onClick={() => openSession(s)} style={btnLink}>Abrir</button></Td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>Nenhuma sessão encontrada.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Detail drawer */}
      {selected && (
        <div onClick={() => setSelected(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50, display: "flex", justifyContent: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "min(720px, 100%)", background: "white", height: "100%", overflowY: "auto", padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, color: "#E30613", fontSize: 18 }}>Sessão {selected.id.slice(0, 8)}</h2>
              <button onClick={() => setSelected(null)} style={btnSecondary}>Fechar</button>
            </div>
            <p style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>Trace: <span style={{ fontFamily: "monospace" }}>{selected.trace_id || "—"}</span></p>

            <h3 style={{ ...h2Style, fontSize: 14, marginTop: 16 }}>Timeline</h3>
            <Timeline s={selected} />

            <h3 style={{ ...h2Style, fontSize: 14, marginTop: 16 }}>Eventos ({events.length})</h3>
            {loadingEvents ? <p>Carregando…</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {events.map(ev => (
                  <div key={ev.id} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span><strong>{ev.event_type}</strong> <span style={{ color: "#6b7280" }}>· {ev.step} · {ev.status}</span></span>
                      <span style={{ color: "#6b7280" }}>{fmt(ev.created_at)} {ev.latency_ms ? `(${ev.latency_ms}ms)` : ""}</span>
                    </div>
                    {ev.error_code && <div style={{ color: "#b91c1c", fontSize: 12, marginTop: 4 }}>{ev.error_code}: {ev.error_message}</div>}
                    {ev.payload && (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ cursor: "pointer", fontSize: 11, color: "#6b7280" }}>payload</summary>
                        <pre style={{ background: "#f9fafb", padding: 8, fontSize: 11, overflowX: "auto", marginTop: 4 }}>{JSON.stringify(ev.payload, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                ))}
                {events.length === 0 && <p style={{ color: "#6b7280" }}>Nenhum evento registrado.</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Timeline({ s }: { s: SessionRow }) {
  const rows: { label: string; at: string | null; from?: string | null }[] = [
    { label: "Início", at: s.started_at },
    { label: "Params recebidos", at: s.params_received_at, from: s.started_at },
    { label: "Form enviado", at: s.form_submitted_at, from: s.params_received_at || s.started_at },
    { label: "OTP enviado", at: s.otp_sent_at, from: s.form_submitted_at },
    { label: "OTP verificado", at: s.otp_verified_at, from: s.otp_sent_at },
    { label: "UniFi chamado", at: s.unifi_authorize_called_at, from: s.otp_verified_at },
    { label: "UniFi confirmado", at: s.unifi_confirmed_at, from: s.unifi_authorize_called_at },
    { label: "Redirect entregue", at: s.redirect_served_at, from: s.unifi_authorize_called_at || s.otp_verified_at },
  ];
  return (
    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
            <td style={{ padding: "6px 8px", color: r.at ? "#111827" : "#9ca3af" }}>{r.label}</td>
            <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{fmt(r.at)}</td>
            <td style={{ padding: "6px 8px", color: "#6b7280" }}>{r.at && r.from ? `+${dur(r.from, r.at)}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ label, value, pct, highlight }: { label: string; value: number; pct?: number; highlight?: boolean }) {
  return (
    <div style={{ background: highlight ? "#fef2f2" : "#f9fafb", padding: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}>
      <div style={{ fontSize: 11, color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: highlight ? "#E30613" : "#111827" }}>{value}</div>
      {pct !== undefined && <div style={{ fontSize: 11, color: "#6b7280" }}>{(pct * 100).toFixed(0)}%</div>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, [string, string]> = {
    authorized: ["#dcfce7", "#166534"],
    submitted: ["#dbeafe", "#1d4ed8"],
    started: ["#f3f4f6", "#374151"],
    failed: ["#fee2e2", "#b91c1c"],
  };
  const [bg, fg] = colors[status] || ["#f3f4f6", "#374151"];
  return <span style={{ background: bg, color: fg, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>{status}</span>;
}

const Th = ({ children }: { children: React.ReactNode }) => <th style={{ padding: "8px 6px", fontWeight: 600 }}>{children}</th>;
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => <td style={{ padding: "8px 6px", ...style }}>{children}</td>;
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span style={{ fontSize: 11, color: "#6b7280" }}>{label}</span>{children}
  </div>
);

const cardStyle: React.CSSProperties = { background: "white", padding: 16, borderRadius: 8, border: "1px solid #e5e7eb" };
const h2Style: React.CSSProperties = { margin: 0, fontSize: 16, color: "#111827" };
const inputStyle: React.CSSProperties = { padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13 };
const btnPrimary: React.CSSProperties = { padding: "8px 14px", background: "#E30613", color: "white", border: 0, borderRadius: 6, fontWeight: 600, cursor: "pointer" };
const btnSecondary: React.CSSProperties = { padding: "6px 12px", background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnLink: React.CSSProperties = { background: "none", border: 0, color: "#E30613", fontWeight: 600, cursor: "pointer", padding: 0 };
