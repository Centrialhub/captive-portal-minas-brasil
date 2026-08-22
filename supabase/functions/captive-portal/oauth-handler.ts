
// ========== Authoritative OAuth Transaction Handler ==========

/**
 * Validates attempt tokens against the database.
 * Returns the captive parameters if valid and not expired/consumed.
 */
async function validateOAuthAttempt(
  db: ReturnType<typeof supabaseAdmin>,
  attemptId: string,
  token: string
): Promise<{
  valid: boolean;
  params?: AuthAuthorizeContext;
  error?: string;
  attempt?: any;
}> {
  if (!isValidUUID(attemptId) || !token) {
    return { valid: false, error: "Parâmetros de tentativa inválidos." };
  }

  // Tokens are stored hashed in DB
  const encoder = new TextEncoder();
  const tokenData = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", tokenData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const tokenHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const { data: attempt, error: fetchErr } = await db
    .from("captive_auth_attempts")
    .select("*")
    .eq("id", attemptId)
    .eq("resume_token_hash", tokenHash)
    .maybeSingle();

  if (fetchErr || !attempt) {
    return { valid: false, error: "Tentativa de login não encontrada ou expirada." };
  }

  if (attempt.status === 'expired' || new Date(attempt.expires_at) < new Date()) {
    if (attempt.status !== 'expired') {
      await db.from("captive_auth_attempts").update({ status: 'expired' }).eq("id", attemptId);
    }
    return { valid: false, error: "Esta tentativa de login expirou. Inicie o processo novamente." };
  }

  if (attempt.status === 'consumed') {
    return { valid: false, error: "Esta tentativa já foi concluída." };
  }

  const params: AuthAuthorizeContext = {
    clientMac: attempt.client_mac,
    apMac: attempt.ap_mac,
    ssid: attempt.ssid,
    storeHint: attempt.store_hint,
    captiveTimestamp: attempt.captive_timestamp,
    redirectUrl: attempt.original_url, // For audit/recovery
  };

  return { valid: true, params, attempt };
}

async function handleOAuthInit(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON");

  const rawParams = (body.params || {}) as Record<string, string>;
  const clientMac = normalizeMac(rawParams.id || rawParams.mac);
  
  if (!clientMac) {
    return errorResponse("Endereço MAC do dispositivo não identificado.");
  }

  // Rate limit by IP/MAC
  const rl = await checkRateLimitDb(db, `oauth-init:mac:${clientMac}`, 60, 5, 300);
  if (!rl.allowed) return errorResponse("Muitas tentativas. Aguarde alguns minutos.", 429);

  // Cryptographically strong random token (opaque)
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Hash it for DB storage
  const encoder = new TextEncoder();
  const tokenData = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", tokenData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const tokenHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

  const { data: attempt, error: insErr } = await db
    .from("captive_auth_attempts")
    .insert({
      resume_token_hash: tokenHash,
      client_mac: clientMac,
      ap_mac: normalizeMac(rawParams.ap),
      ssid: sanitizeString(rawParams.ssid, 64),
      store_hint: sanitizeString(rawParams.store, 64),
      captive_timestamp: sanitizeString(rawParams.t, 32),
      original_url: sanitizeString(body.original_url, 500),
      expires_at: expiresAt.toISOString(),
      status: 'created',
      metadata: { client_ip: clientIp }
    })
    .select("id")
    .single();

  if (insErr || !attempt?.id) {
    console.error("[oauth-init] insert failed:", insErr?.message);
    return errorResponse("Erro ao inicializar transação de login.", 500);
  }

  return jsonResponse({
    attempt_id: attempt.id,
    token: token
  });
}
