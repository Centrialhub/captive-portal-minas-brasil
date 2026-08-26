const required = [
  "CONCURRENCY_TEST_URL",
  "CONCURRENCY_TEST_PAYLOAD",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const EXPECTED_RELEASE_CONTRACT = "20260824211347";

for (const name of required) {
  if (!process.env[name]) {
    console.error(`FAIL: ${name} is required for the concurrency gate.`);
    process.exit(1);
  }
}

let payload;
try {
  payload = JSON.parse(process.env.CONCURRENCY_TEST_PAYLOAD);
} catch {
  console.error("FAIL: CONCURRENCY_TEST_PAYLOAD must be valid JSON.");
  process.exit(1);
}

if (!payload.attempt_id || !payload.resume_token || !payload.access_token) {
  console.error("FAIL: concurrency payload must contain attempt_id, resume_token, and access_token.");
  process.exit(1);
}

const endpoint = process.env.CONCURRENCY_TEST_URL;
const restHeaders = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
};
const restBase = process.env.SUPABASE_URL.replace(/\/$/, "");

// Fail before consuming the one-time attempt unless the forward-only migration
// chain reached the production contract expected by this release.
const contractResponse = await fetch(
  `${restBase}/rest/v1/rpc/production_release_contract`,
  {
    method: "POST",
    headers: { ...restHeaders, "content-type": "application/json" },
    body: "{}",
  },
);
const contractVersion = await contractResponse.json().catch(() => null);
if (!contractResponse.ok || contractVersion !== EXPECTED_RELEASE_CONTRACT) {
  console.error(
    `FAIL: expected database release contract ${EXPECTED_RELEASE_CONTRACT}; got ${JSON.stringify(contractVersion)}. Apply all migrations in homologation first.`,
  );
  process.exit(1);
}

const requests = Array.from({ length: 20 }, async () => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
});

const responses = await Promise.all(requests);
const unexpectedHttp = responses.filter(({ status }) => status < 200 || status >= 300);
if (unexpectedHttp.length) {
  console.error(`FAIL: ${unexpectedHttp.length} concurrent requests returned non-2xx responses.`);
  process.exit(1);
}

const primary = responses.filter(({ body }) => body.authorized && !body.replay);
const replayOrProcessing = responses.filter(({ body }) =>
  body.replay || body.processing || body.fail_reason === "PROCESSING_IN_PROGRESS"
);
if (primary.length !== 1 || replayOrProcessing.length !== 19) {
  console.error(`FAIL: expected 1 primary authorization and 19 processing/replay responses; got ${primary.length} and ${replayOrProcessing.length}.`);
  process.exit(1);
}

const attemptId = encodeURIComponent(payload.attempt_id);
const sessionResponse = await fetch(
  `${restBase}/rest/v1/captive_sessions?attempt_id=eq.${attemptId}&select=id`,
  { headers: restHeaders },
);
const sessions = await sessionResponse.json();
if (!sessionResponse.ok || !Array.isArray(sessions) || sessions.length !== 1) {
  console.error(`FAIL: expected exactly one captive_session; got ${Array.isArray(sessions) ? sessions.length : "invalid response"}.`);
  process.exit(1);
}

const sessionId = encodeURIComponent(sessions[0].id);
const auditResponse = await fetch(
  `${restBase}/rest/v1/audit_logs?entity=eq.session&entity_id=eq.${sessionId}&action=eq.authorize&select=id`,
  { headers: restHeaders },
);
const commands = await auditResponse.json();
if (!auditResponse.ok || !Array.isArray(commands) || commands.length !== 1) {
  console.error(`FAIL: expected exactly one persisted UniFi authorization command; got ${Array.isArray(commands) ? commands.length : "invalid response"}.`);
  process.exit(1);
}

console.log("OK: 20 requests = 1 captive_session = 1 UniFi command = 19 processing/replay responses.");
