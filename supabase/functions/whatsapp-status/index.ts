// WhatsApp delivery-status callback receiver.
// Centrial Hub (or any provider) POSTs delivery updates here.
// Public endpoint, authenticated via Bearer = global_settings.whatsapp_webhook_secret.
//
// Expected JSON body (all optional except request_id OR session_id):
// {
//   "request_id": "<uuid>:<attempt>",   // the X-Request-Id / X-Idempotency-Key we sent
//   "session_id": "<uuid>",             // captive session id (fallback if no request_id)
//   "message_id": "wamid....",          // provider message id (WhatsApp)
//   "status":  "queued" | "sent" | "delivered" | "read" | "failed" | "undelivered",
//   "error_code": "string",
//   "error_message": "string",
//   "timestamp": "2026-06-01T12:00:00Z",
//   "raw": { ... }                      // anything else; stored as-is
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const TERMINAL_OK = new Set(["delivered", "read", "sent"]);
const TERMINAL_FAIL = new Set(["failed", "undelivered", "rejected", "error"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Auth: Bearer must match global_settings.whatsapp_webhook_secret (when set).
  const { data: settings } = await db
    .from("global_settings")
    .select("whatsapp_webhook_secret")
    .eq("id", 1)
    .maybeSingle();

  const expected = settings?.whatsapp_webhook_secret?.trim();
  if (expected) {
    const auth = req.headers.get("authorization") || "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (token !== expected) return json({ error: "unauthorized" }, 401);
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "invalid_body" }, 400);

  const requestId: string | null = typeof body.request_id === "string" ? body.request_id : null;
  let sessionId: string | null = typeof body.session_id === "string" ? body.session_id : null;
  const statusRaw: string = String(body.status || "unknown").toLowerCase();
  const messageId: string | null = body.message_id ? String(body.message_id) : null;
  const errorCode: string | null = body.error_code ? String(body.error_code) : null;
  const errorMessage: string | null = body.error_message ? String(body.error_message) : null;
  const ts: string | null = body.timestamp ? String(body.timestamp) : null;

  // Derive session_id from request_id ("<uuid>:<attempt>") if not provided.
  if (!sessionId && requestId) {
    const m = requestId.match(/^([0-9a-f-]{36})(?::|$)/i);
    if (m) sessionId = m[1];
  }

  // Lookup store + trace from the session (best-effort).
  let storeId: string | null = null;
  let traceId: string | null = null;
  if (sessionId) {
    const { data: s } = await db
      .from("captive_sessions")
      .select("store_id, trace_id")
      .eq("id", sessionId)
      .maybeSingle();
    if (s) {
      storeId = s.store_id ?? null;
      traceId = s.trace_id ?? null;
    }
  }

  const isFail = TERMINAL_FAIL.has(statusRaw);
  const isOk = TERMINAL_OK.has(statusRaw);

  await db.from("portal_events").insert({
    session_id: sessionId,
    store_id: storeId,
    trace_id: traceId,
    event_type: "whatsapp_delivery_status",
    step: "otp",
    status: isFail ? "warn" : "info",
    error_code: isFail ? (errorCode || statusRaw) : null,
    error_message: isFail ? (errorMessage || null) : null,
    payload: {
      request_id: requestId,
      message_id: messageId,
      delivery_status: statusRaw,
      provider_timestamp: ts,
      received_at: new Date().toISOString(),
      raw: body.raw ?? null,
    },
  });

  return json({ ok: true, recorded: statusRaw, session_id: sessionId, terminal: isOk || isFail });
});
