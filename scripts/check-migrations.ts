import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const invariantMigration = readFileSync(
  join(root, "supabase/migrations/20260824200345_captive_auth_invariants.sql"),
  "utf8",
);
const policyMigration = readFileSync(
  join(root, "supabase/migrations/20260824200934_consolidate_read_policies.sql"),
  "utf8",
);
const releaseContractMigration = readFileSync(
  join(root, "supabase/migrations/20260824211347_production_release_contract.sql"),
  "utf8",
);
const adminContractMigration = readFileSync(
  join(root, "supabase/migrations/20260824211705_admin_configuration_contract.sql"),
  "utf8",
);
const adminOperationsMigration = readFileSync(
  join(root, "supabase/migrations/20260824215556_admin_operations_and_user_controls.sql"),
  "utf8",
);
const unifiHttpsMigration = readFileSync(
  join(root, "supabase/migrations/20260825115000_enforce_unifi_proxy_https.sql"),
  "utf8",
);
const unifiBridgeMigration = readFileSync(
  join(root, "supabase/migrations/20260825170953_route_unifi_through_local_proxy.sql"),
  "utf8",
);
const allStoresUnifiBridgeMigration = readFileSync(
  join(root, "supabase/migrations/20260825200944_route_all_unifi_stores_through_tls_proxy.sql"),
  "utf8",
);
const captiveHardeningMigration = readFileSync(
  join(root, "supabase/migrations/20260826202326_harden_captive_flow_and_oauth_handoff.sql"),
  "utf8",
);
const duplicateMigration = readFileSync(
  join(root, "supabase/migrations/20260822221520_cbf3ebe4-1d29-4c1a-83e3-818255bc0eb0.sql"),
  "utf8",
);
const edgeFunction = readFileSync(
  join(root, "supabase/functions/captive-portal/index.ts"),
  "utf8",
);
const concurrencyGate = readFileSync(
  join(root, "scripts/verify-concurrency.mjs"),
  "utf8",
);

const requirements: Array<[string, boolean]> = [
  ["authorizing is accepted by the status constraint", /CHECK\s*\(status IN \([\s\S]*'authorizing'/.test(invariantMigration)],
  ["claim hashes the required resume token", /digest\(p_resume_token,\s*'sha256'\)/.test(invariantMigration)],
  ["claim never compares a plaintext resume_token column", !/v_attempt\.resume_token\b/.test(invariantMigration)],
  ["terminal states are explicitly rejected", /status IN \('cancelled', 'expired', 'failed'\)/.test(invariantMigration)],
  ["has_role is an authenticated self-check", /SECURITY INVOKER/.test(invariantMigration) && /GRANT EXECUTE ON FUNCTION public\.has_role[^;]+TO authenticated;/.test(invariantMigration)],
  ["anonymous sessions are never exposed to authenticated users", !/user_id IS NULL/.test(policyMigration)],
  ["read policies combine owner and admin access", /Authenticated users can read permitted sessions/.test(policyMigration) && /Authenticated users can read permitted profiles/.test(policyMigration)],
  ["release contract is security-invoker and service-role-only", /SECURITY INVOKER/.test(releaseContractMigration) && /REVOKE ALL ON FUNCTION public\.production_release_contract\(\) FROM PUBLIC, anon, authenticated;/.test(releaseContractMigration) && /GRANT EXECUTE ON FUNCTION public\.production_release_contract\(\) TO service_role;/.test(releaseContractMigration)],
  ["concurrency gate verifies the applied release contract first", /EXPECTED_RELEASE_CONTRACT = "20260824211347"/.test(concurrencyGate) && concurrencyGate.indexOf("production_release_contract") < concurrencyGate.indexOf("Array.from({ length: 20")],
  ["duplicate sessions are detached instead of deleted", /SET attempt_id = NULL/.test(duplicateMigration) && !/DELETE FROM public\.captive_sessions/.test(duplicateMigration)],
  ["duplicate ordering uses the real started_at column", /s\.started_at DESC/.test(duplicateMigration) && !/a\.created_at/.test(duplicateMigration)],
  ["edge claim passes the resume token", /p_resume_token:\s*resumeToken/.test(edgeFunction)],
  ["lease ownership is unique per invocation", /const leaseOwner = `worker-\$\{crypto\.randomUUID\(\)\}`/.test(edgeFunction)],
  ["ambiguous controller errors remain recoverable", /isAmbiguous \? "PROCESSING_IN_PROGRESS"/.test(edgeFunction)],
  ["admin contract keeps operational settings in the captive backend", /ADD COLUMN IF NOT EXISTS session_duration_minutes/.test(adminContractMigration) && /CHECK \(session_duration_minutes BETWEEN 1 AND 43200\)/.test(adminContractMigration)],
  ["admin contract preserves lead acquisition timestamps", /ADD COLUMN IF NOT EXISTS first_seen_at/.test(adminContractMigration) && /ADD COLUMN IF NOT EXISTS last_seen_at/.test(adminContractMigration) && /ALTER COLUMN last_seen_at SET NOT NULL/.test(adminContractMigration)],
  ["admin settings updates are validated and audited", /Number\.isInteger\(duration\)/.test(edgeFunction) && /writeAdminAudit\(db, req, userId, "global_settings", "update"/.test(edgeFunction) && /session_duration_minutes: duration/.test(edgeFunction)],
  ["marketing exports are consent-aware and audited", /audience === "marketing"/.test(edgeFunction) && /lead\.consented_at/.test(edgeFunction) && /writeAdminAudit\(db, req, userId, "lead", "export_csv"/.test(edgeFunction)],
  ["marketing exports exclude sensitive network and identity fields", /\? \["nome", "email", "telefone", "loja"/.test(edgeFunction) && /query = query\.eq\("marketing_status", "eligible"\)/.test(edgeFunction) && /exportRows = \(data \|\| \[\]\)\.filter/.test(edgeFunction)],
  ["user blocks are RLS-protected and service-role-only", /CREATE TABLE IF NOT EXISTS public\.user_blocks/.test(adminOperationsMigration) && /ENABLE ROW LEVEL SECURITY/.test(adminOperationsMigration) && /REVOKE ALL ON TABLE public\.user_blocks FROM PUBLIC, anon, authenticated/.test(adminOperationsMigration)],
  ["lead marketing states are constrained and indexed", /leads_marketing_status_allowed/.test(adminOperationsMigration) && /'eligible', 'opted_out', 'blocked', 'anonymized'/.test(adminOperationsMigration) && /idx_leads_marketing_status_last_seen/.test(adminOperationsMigration)],
  ["admin user operations protect the operator and final admin", /targetUserId === actorUserId/.test(edgeFunction) && /Não é permitido remover o último administrador/.test(edgeFunction) && /inviteUserByEmail/.test(edgeFunction)],
  ["application access checks the immediate block registry", /getActiveUserBlock/.test(edgeFunction) && /code: "user_blocked"/.test(edgeFunction)],
  ["stores preserve operational history", /Exclusão definitiva de loja desabilitada/.test(edgeFunction)],
  ["stored UniFi controller URLs require HTTPS", /stores_unifi_controller_url_https/.test(unifiHttpsMigration) && /VALIDATE CONSTRAINT stores_unifi_controller_url_https/.test(unifiHttpsMigration)],
  ["legacy UniFi proxy URLs are normalized to public port 443", /https:\/\/rwificontroller\.drogariaminasbrasil\.com\.br'/.test(unifiHttpsMigration) && /8083\|8443/.test(unifiHttpsMigration)],
  ["matriz traffic is routed through the local TLS proxy", /https:\/\/unifiproxy\.minasbrasilwifi\.com\.br\/matriz/.test(unifiBridgeMigration) && /rwificontroller\\\.drogariaminasbrasil/.test(unifiBridgeMigration)],
  ["all managed stores are routed through the local TLS proxy", /https:\/\/unifiproxy\.minasbrasilwifi\.com\.br\/['"]?\s*\|\|\s*slug/.test(allStoresUnifiBridgeMigration) && ["cintra", "cula", "dpedro", "drive", "hu", "ibituruna", "joao23", "major", "matriz", "mestra", "povao", "shopping"].every((slug) => allStoresUnifiBridgeMigration.includes(`'${slug}'`))],
  ["controller URLs are bound to the canonical TLS proxy and store slug", /stores_unifi_controller_url_canonical/.test(captiveHardeningMigration) && /unifi_controller_url = 'https:\/\/unifiproxy\.minasbrasilwifi\.com\.br\/' \|\| slug/.test(captiveHardeningMigration)],
  ["browser handoffs are one-time, RLS protected, and service-role-only", /CREATE TABLE IF NOT EXISTS public\.oauth_browser_handoffs/.test(captiveHardeningMigration) && /claimed_at IS NOT NULL/.test(captiveHardeningMigration) && /ENABLE ROW LEVEL SECURITY/.test(captiveHardeningMigration) && /claim_oauth_browser_handoff\(TEXT, TEXT\)[\s\S]*TO service_role/.test(captiveHardeningMigration)],
  ["admin controller URLs are derived from the store slug", /canonicalUnifiControllerUrl\(slug\)/.test(edgeFunction) && /canonicalUnifiControllerUrl\(effectiveSlug\)/.test(edgeFunction)],
  ["UniFi idempotency is scoped by store and MAC", /unifi_auth:store:\$\{storeId\}:mac:\$\{clientMac\.toUpperCase\(\)\}/.test(edgeFunction) && /\.eq\("store_id", storeId\)/.test(edgeFunction)],
  ["authorization never sends a blind command for an absent station", /CLIENT_NOT_FOUND_ON_CONTROLLER/.test(edgeFunction) && /UNIFI_STATION_LOOKUP_FAILED/.test(edgeFunction)],
  ["store discovery caches only the controller-observed AP", /normalizeMac\(station\.ap_mac\)/.test(edgeFunction) && !/normalizeMac\(station\.ap_mac \|\| apMacHint\)/.test(edgeFunction)],
  ["troubleshooting exposes diagnostics, trace events, and audit", /handleAdminDiagnostics/.test(edgeFunction) && /portal_events/.test(edgeFunction) && /handleAdminAudit/.test(edgeFunction)],
  ["manual housekeeping is preview-first and explicitly confirmed", /body\.dry_run !== false/.test(edgeFunction) && /EXCLUIR DADOS EXPIRADOS/.test(edgeFunction) && /previewHousekeeping/.test(edgeFunction)],
  ["readiness reports degraded dependencies", /path === "\/ready"/.test(edgeFunction) && /ready \? 200 : 503/.test(edgeFunction)],
];

const failures = requirements.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

for (const [name] of requirements) console.log(`OK: ${name}`);
