import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

function supabaseAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseAuth(authHeader: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  return mac.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

// ========== Rate Limiting (in-memory, per instance) ==========
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max 10 submits per IP per minute

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// ========== UniFi Adapter ==========
async function authorizeClientOnUnifi(
  controllerUrl: string,
  apiKeyOrToken: string,
  siteId: string,
  clientMac: string
): Promise<{ ok: boolean; error?: string }> {
  // UniFi Controller API adapter
  // This is a placeholder — the exact endpoint depends on the UniFi controller version.
  // Common patterns:
  //   UniFi OS / Network Application >= 7.x: POST /proxy/network/api/s/{site}/cmd/stamgr
  //   Legacy controller: POST /api/s/{site}/cmd/stamgr
  // The body is: { cmd: "authorize-guest", mac: "AABBCCDDEEFF", minutes: 1440 }
  try {
    const url = `${controllerUrl.replace(/\/+$/, "")}/proxy/network/api/s/${siteId}/cmd/stamgr`;
    const formattedMac = clientMac.replace(/(.{2})(?=.)/g, "$1:").toLowerCase();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKeyOrToken,
        Authorization: `Bearer ${apiKeyOrToken}`,
      },
      body: JSON.stringify({
        cmd: "authorize-guest",
        mac: formattedMac,
        minutes: 1440, // 24 hours
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `UniFi API returned ${res.status}: ${text}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `UniFi request failed: ${(err as Error).message}` };
  }
}

async function authorizeClient(
  db: ReturnType<typeof supabaseAdmin>,
  storeId: string,
  clientMac: string | null,
  sessionId: string
): Promise<boolean> {
  // Fetch store config
  const { data: store } = await db
    .from("stores")
    .select("unifi_controller_url, unifi_api_key_or_token, unifi_site_id")
    .eq("id", storeId)
    .maybeSingle();

  if (!store?.unifi_controller_url || !store?.unifi_api_key_or_token) {
    await db
      .from("captive_sessions")
      .update({ status: "failed", fail_reason: "UNIFI_NOT_CONFIGURED" })
      .eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "session",
      entity_id: sessionId,
      action: "fail",
      meta: { reason: "UNIFI_NOT_CONFIGURED" },
    });
    return false;
  }

  if (!clientMac) {
    await db
      .from("captive_sessions")
      .update({ status: "failed", fail_reason: "NO_MAC_ADDRESS" })
      .eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "session",
      entity_id: sessionId,
      action: "fail",
      meta: { reason: "NO_MAC_ADDRESS" },
    });
    return false;
  }

  const siteId = store.unifi_site_id || "default";
  const result = await authorizeClientOnUnifi(
    store.unifi_controller_url,
    store.unifi_api_key_or_token,
    siteId,
    clientMac
  );

  if (result.ok) {
    await db
      .from("captive_sessions")
      .update({ status: "authorized", authorized_at: new Date().toISOString() })
      .eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "session",
      entity_id: sessionId,
      action: "authorize",
      meta: { mac: clientMac },
    });
    return true;
  } else {
    await db
      .from("captive_sessions")
      .update({ status: "failed", fail_reason: result.error })
      .eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "session",
      entity_id: sessionId,
      action: "fail",
      meta: { reason: result.error, mac: clientMac },
    });
    return false;
  }
}

// ========== Route Handlers ==========

async function handleBootstrap(url: URL): Promise<Response> {
  const storeSlug = url.searchParams.get("store");
  if (!storeSlug) return errorResponse("Missing 'store' parameter");

  const db = supabaseAdmin();

  const { data: store } = await db
    .from("stores")
    .select("id, slug, name, city, is_active")
    .eq("slug", storeSlug)
    .maybeSingle();

  if (!store) return errorResponse("Store not found", 404);
  if (!store.is_active) return errorResponse("Esta loja está temporariamente indisponível.", 403);

  const { data: consent } = await db
    .from("consent_versions")
    .select("version, text")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return jsonResponse({
    store: { slug: store.slug, name: store.name, city: store.city },
    consent: consent || null,
    required_fields: {
      name: { required: true },
      email: { required: false },
      phone: { required: false },
      at_least_one_contact: true, // email OR phone
    },
  });
}

async function handleStart(req: Request): Promise<Response> {
  const body = await req.json();
  const { store_slug, client_mac, client_ip, ap_mac, ssid, user_agent, redirect_url } = body;

  if (!store_slug) return errorResponse("Missing store_slug");

  const db = supabaseAdmin();

  const { data: store } = await db
    .from("stores")
    .select("id, is_active")
    .eq("slug", store_slug)
    .maybeSingle();

  if (!store) return errorResponse("Store not found", 404);
  if (!store.is_active) return errorResponse("Store is inactive", 403);

  const { data: session, error } = await db
    .from("captive_sessions")
    .insert({
      store_id: store.id,
      client_mac: normalizeMac(client_mac),
      client_ip,
      ap_mac: normalizeMac(ap_mac),
      ssid,
      user_agent: user_agent || req.headers.get("user-agent"),
      redirect_url,
      status: "started",
    })
    .select("id")
    .single();

  if (error) return errorResponse("Failed to create session: " + error.message, 500);

  await db.from("audit_logs").insert({
    store_id: store.id,
    entity: "session",
    entity_id: session.id,
    action: "create",
    meta: { client_mac: normalizeMac(client_mac), client_ip },
  });

  return jsonResponse({ session_id: session.id });
}

async function handleSubmit(req: Request): Promise<Response> {
  // Rate limit by IP
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";

  if (isRateLimited(clientIp)) {
    return errorResponse("Rate limit exceeded. Please wait before trying again.", 429);
  }

  const body = await req.json();
  const { session_id, store_slug, name, email, phone, client_mac, consent_version } = body;

  // Validations
  if (!store_slug) return errorResponse("Missing store_slug");
  if (!name || !name.trim()) return errorResponse("Nome é obrigatório");
  if (!email && !phone) return errorResponse("Informe ao menos e-mail ou telefone");
  if (!consent_version) return errorResponse("Consentimento é obrigatório");

  const db = supabaseAdmin();

  // Validate store
  const { data: store } = await db
    .from("stores")
    .select("id, is_active")
    .eq("slug", store_slug)
    .maybeSingle();

  if (!store) return errorResponse("Store not found", 404);
  if (!store.is_active) return errorResponse("Store is inactive", 403);

  // Validate consent version
  const { data: consent } = await db
    .from("consent_versions")
    .select("version, text")
    .eq("version", consent_version)
    .maybeSingle();

  if (!consent) return errorResponse("Versão de consentimento inválida", 400);

  // Create lead
  const normalizedMac = normalizeMac(client_mac);
  const consentTextHash = consent.text
    ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(consent.text)).then((buf) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
      )
    : null;

  const { data: lead, error: leadError } = await db
    .from("leads")
    .insert({
      store_id: store.id,
      session_id: session_id || null,
      name: name.trim(),
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      client_mac: normalizedMac,
      consented_at: new Date().toISOString(),
      consent_version,
      consent_text_hash: consentTextHash,
      source: "captive_portal",
    })
    .select("id")
    .single();

  if (leadError) return errorResponse("Failed to save lead: " + leadError.message, 500);

  // Update session
  if (session_id) {
    await db
      .from("captive_sessions")
      .update({
        status: "submitted",
        submitted_at: new Date().toISOString(),
        client_mac: normalizedMac,
      })
      .eq("id", session_id);
  }

  // Audit log
  await db.from("audit_logs").insert({
    store_id: store.id,
    entity: "lead",
    entity_id: lead.id,
    action: "create",
    meta: { session_id, client_mac: normalizedMac },
  });

  // Attempt UniFi authorization
  let authorized = false;
  if (session_id && normalizedMac) {
    authorized = await authorizeClient(db, store.id, normalizedMac, session_id);
  }

  return jsonResponse({
    ok: true,
    authorized,
    lead_id: lead.id,
    message: authorized
      ? "Acesso liberado! Você já pode navegar."
      : "Cadastro salvo com sucesso. A liberação do acesso pode levar alguns instantes.",
  });
}

// ========== Admin Endpoints ==========

async function requireAdmin(req: Request): Promise<{ db: ReturnType<typeof supabaseAdmin>; userId: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Unauthorized", 401);
  }

  const authClient = supabaseAuth(authHeader);
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await authClient.auth.getClaims(token);
  if (error || !data?.claims) {
    return errorResponse("Unauthorized", 401);
  }

  const userId = data.claims.sub as string;
  const db = supabaseAdmin();

  const { data: roleData } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleData) return errorResponse("Forbidden: admin role required", 403);

  return { db, userId };
}

async function handleAdminStores(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  if (req.method === "GET") {
    const { data, error } = await db
      .from("stores")
      .select("id, slug, name, city, is_active, unifi_site_id, unifi_controller_url, created_at, updated_at")
      .order("created_at", { ascending: false });
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data);
  }

  if (req.method === "POST") {
    const body = await req.json();
    const { data, error } = await db
      .from("stores")
      .insert({
        slug: body.slug,
        name: body.name,
        city: body.city || null,
        is_active: body.is_active ?? true,
        unifi_site_id: body.unifi_site_id || null,
        unifi_controller_url: body.unifi_controller_url || null,
        unifi_api_key_or_token: body.unifi_api_key_or_token || null,
      })
      .select("id, slug, name")
      .single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data, 201);
  }

  if (req.method === "PUT") {
    const body = await req.json();
    if (!body.id) return errorResponse("Missing store id");
    const updateData: Record<string, unknown> = {};
    if (body.slug !== undefined) updateData.slug = body.slug;
    if (body.name !== undefined) updateData.name = body.name;
    if (body.city !== undefined) updateData.city = body.city;
    if (body.is_active !== undefined) updateData.is_active = body.is_active;
    if (body.unifi_site_id !== undefined) updateData.unifi_site_id = body.unifi_site_id;
    if (body.unifi_controller_url !== undefined) updateData.unifi_controller_url = body.unifi_controller_url;
    if (body.unifi_api_key_or_token !== undefined) updateData.unifi_api_key_or_token = body.unifi_api_key_or_token;

    const { data, error } = await db.from("stores").update(updateData).eq("id", body.id).select("id, slug, name").single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data);
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminLeads(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const storeId = url.searchParams.get("store_id");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const offset = (page - 1) * limit;
  const format = url.searchParams.get("format"); // 'csv' for export

  let query = db
    .from("leads")
    .select("id, store_id, session_id, name, email, phone, client_mac, created_at, consented_at, consent_version, source, stores(slug, name)", { count: "exact" })
    .order("created_at", { ascending: false });

  if (storeId) query = query.eq("store_id", storeId);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  if (format === "csv") {
    // No pagination for CSV export, but cap at 10000
    query = query.limit(10000);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);

    const headers = ["id", "store_slug", "name", "email", "phone", "client_mac", "created_at", "consent_version"];
    const csvRows = [headers.join(",")];
    for (const lead of data || []) {
      const storeInfo = lead.stores as unknown as { slug: string; name: string } | null;
      csvRows.push(
        [
          lead.id,
          storeInfo?.slug || "",
          `"${(lead.name || "").replace(/"/g, '""')}"`,
          lead.email || "",
          lead.phone || "",
          lead.client_mac || "",
          lead.created_at,
          lead.consent_version,
        ].join(",")
      );
    }

    return new Response(csvRows.join("\n"), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="leads_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  query = query.range(offset, offset + limit - 1);
  const { data, count, error } = await query;
  if (error) return errorResponse(error.message, 500);

  return jsonResponse({ data, total: count, page, limit });
}

async function handleAdminConsent(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  if (req.method === "GET") {
    const { data, error } = await db
      .from("consent_versions")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data);
  }

  if (req.method === "POST") {
    const body = await req.json();
    if (!body.version || !body.text) return errorResponse("version and text are required");

    // Optionally deactivate previous versions
    if (body.deactivate_previous !== false) {
      await db.from("consent_versions").update({ is_active: false }).eq("is_active", true);
    }

    const { data, error } = await db
      .from("consent_versions")
      .insert({
        version: body.version,
        text: body.text,
        is_active: true,
      })
      .select()
      .single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data, 201);
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminSessions(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const storeId = url.searchParams.get("store_id");
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const offset = (page - 1) * limit;

  let query = db
    .from("captive_sessions")
    .select("*, stores(slug, name)", { count: "exact" })
    .order("started_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (storeId) query = query.eq("store_id", storeId);

  const { data, count, error } = await query;
  if (error) return errorResponse(error.message, 500);

  return jsonResponse({ data, total: count, page, limit });
}

// ========== Main Router ==========

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/captive-portal/, "");

  try {
    // Public portal endpoints
    if (path === "/bootstrap" && req.method === "GET") {
      return await handleBootstrap(url);
    }
    if (path === "/start" && req.method === "POST") {
      return await handleStart(req);
    }
    if (path === "/submit" && req.method === "POST") {
      return await handleSubmit(req);
    }

    // Admin endpoints
    if (path === "/admin/stores") {
      return await handleAdminStores(req);
    }
    if (path === "/admin/leads") {
      return await handleAdminLeads(req, url);
    }
    if (path === "/admin/consent") {
      return await handleAdminConsent(req);
    }
    if (path === "/admin/sessions") {
      return await handleAdminSessions(req, url);
    }

    return errorResponse("Not found", 404);
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse("Internal server error", 500);
  }
});
