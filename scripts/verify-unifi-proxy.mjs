const proxyOrigin = process.env.PRODUCTION_UNIFI_PROXY_ORIGIN ||
  "https://unifiproxy.minasbrasilwifi.com.br";
const timeoutMs = Number(process.env.PRODUCTION_VERIFY_TIMEOUT_MS || "15000");
const stores = (process.env.PRODUCTION_UNIFI_STORES ||
  "cintra,cula,dpedro,drive,hu,ibituruna,joao23,major,matriz,mestra,povao,shopping")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`OK: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL: ${name}: ${message}`);
  }
}

let origin;
try {
  origin = new URL(proxyOrigin);
  assert(origin.protocol === "https:", "PRODUCTION_UNIFI_PROXY_ORIGIN must use HTTPS");
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeout must be positive");
  assert(stores.length > 0, "at least one store must be configured");
  assert(stores.every((slug) => /^[a-z0-9_-]+$/.test(slug)), "store list contains an invalid slug");
} catch (error) {
  console.error(`FAIL: verifier configuration: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

await check("proxy health", async () => {
  const response = await fetch(new URL("/healthz", origin), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "minas-brasil-unifi-proxy-verifier/1.0" },
  });
  const text = await response.text();
  assert(response.ok, `${response.status} ${response.statusText}; body=${text.slice(0, 120)}`);
  const body = JSON.parse(text);
  assert(body.ok === true && body.service === "unifi-proxy", `unexpected body ${text.slice(0, 120)}`);
});

for (const store of stores) {
  await check(`controller route ${store}`, async () => {
    const response = await fetch(new URL(`/${store}/`, origin), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "minas-brasil-unifi-proxy-verifier/1.0" },
    });
    const text = await response.text();
    assert(response.status === 302, `expected HTTP 302, received ${response.status}; body=${text.slice(0, 120)}`);
    assert(response.headers.get("location") === "/manage", `unexpected Location ${JSON.stringify(response.headers.get("location"))}`);
    const cookie = response.headers.get("set-cookie") || "";
    assert(cookie.includes(`unifi_controller=${store}`), `routing cookie for ${store} is missing`);
  });
}

if (failures.length) {
  console.error(`UNIFI PROXY VERIFICATION FAILED (${failures.length}).`);
  process.exit(1);
}

console.log(`UNIFI PROXY VERIFIED: ${stores.length} store routes.`);
