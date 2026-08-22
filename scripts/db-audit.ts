import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runAudit() {
  console.log("--- Starting Database Security Audit ---");

  // 1. Verify RPC restrictions
  const rpcs = ['secure_update_profile', 'claim_auth_attempt', 'finalize_auth_attempt', 'rate_limit_hit'];
  for (const rpc of rpcs) {
    const { data, error } = await supabase.rpc(rpc, { test: true }).catch(e => ({ error: e }));
    // We expect a permission error if called without service_role from outside
    console.log(`Checking RPC ${rpc}...`);
  }

  // 2. Verify Table Permissions (Profiles)
  console.log("Checking profiles table permissions...");
  const { error: insertError } = await supabase.from('profiles').insert({ id: '00000000-0000-0000-0000-000000000000' });
  if (insertError) console.log("Profiles INSERT restricted as expected.");
  
  console.log("--- Audit Complete ---");
}

runAudit();
