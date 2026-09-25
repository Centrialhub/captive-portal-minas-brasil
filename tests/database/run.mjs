import assert from 'node:assert/strict';
import { readFile, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import pg from 'pg';
const dir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(dir,'../..');
const bin=path.join(dir,'node_modules/@embedded-postgres/windows-x64/native/bin');
const data=await mkdtemp(path.join(dir,'data-'));
const expectedData=await realpath(data);
const port=55439;
const options={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};
if(process.platform!=='win32')throw new Error('This native PostgreSQL harness currently targets Windows x64; see README.');
if(options.host!=='127.0.0.1')throw new Error('Database contract tests require loopback.');
const run=(exe,args)=>{const r=spawnSync(path.join(bin,exe),args,{windowsHide:true,encoding:'utf8'});if(r.error)throw r.error;if(r.status!==0)throw new Error(r.stderr||r.stdout||`${exe} exited ${r.status}`);return r.stdout;};
let server,serverError,serverExit,logs='';
const samePath=(a,b)=>path.resolve(a).replaceAll('\\','/').toLowerCase()===path.resolve(b).replaceAll('\\','/').toLowerCase();
const guardError=(code,message)=>Object.assign(new Error(`${code}: ${message}`),{code});
function ownProcessAlive(){
  if(!server?.pid||serverError||serverExit||server.exitCode!==null||server.signalCode!==null)return false;
  try{process.kill(server.pid,0);return true;}catch{return false;}
}
async function ownedPidFile(){
  const lines=(await readFile(path.join(data,'postmaster.pid'),'utf8')).split(/\r?\n/);
  return Number(lines[0])===server?.pid&&samePath(await realpath(lines[1]),expectedData);
}
async function assertOwnedConnection(c){
  // SHOW is read-only. Never apply a fixture to whatever happens to answer the port.
  const actual=(await c.query('SHOW data_directory')).rows[0].data_directory;
  if(!samePath(await realpath(actual),expectedData))throw guardError('HARNESS_CLUSTER_MISMATCH',`refusing PostgreSQL at ${actual}; expected ${expectedData}`);
  if(!ownProcessAlive())throw guardError('HARNESS_PROCESS_NOT_RUNNING','the PostgreSQL child created by this run is not alive');
  if(!await ownedPidFile())throw guardError('HARNESS_PID_MISMATCH','the new data directory does not belong to the PostgreSQL child');
  if(!ownProcessAlive())throw guardError('HARNESS_PROCESS_NOT_RUNNING','PostgreSQL exited during the identity check');
}
let client; const clients=[]; const passed=[]; const adversarialFailures=[]; const observations=[];
async function connect(){const c=new pg.Client(options);try{await c.connect();await assertOwnedConnection(c);clients.push(c);return c;}catch(error){await c.end().catch(()=>{});throw error;}}
const test=async(name,fn)=>{
  // Separate scenarios cannot consume one another's shared controller slots.
  // This is fixture reset between tests, never a state change within a scenario.
  await client.query("update captive_auth_work_due set due_at=clock_timestamp()+interval '1 hour';update captive_auth_operations set lease_expires_at=clock_timestamp()-interval '1 second' where lease_owner is not null;");
  await fn();passed.push(name);console.log('PASS '+name);
};
// Adversarial probes keep running after an invariant fails, then exit nonzero.
// A failure is evidence to investigate; it is not an expected-success assertion.
const adversarial=async(name,fn)=>{try{await test(name,fn);}catch(error){if(error.code==='PROBE_SETUP_ERROR')throw error;adversarialFailures.push({name,message:error.message,actual:error.actual,expected:error.expected});console.error('FAIL '+name+': '+error.message);}};
try {
  run('initdb.exe',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C']);
  server=spawn(path.join(bin,'postgres.exe'),['-D',data,'-h','127.0.0.1','-p',String(port)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout?.on('data',x=>logs+=x);server.stderr?.on('data',x=>logs+=x);
  server.once('error',error=>{serverError=error;});server.once('exit',(code,signal)=>{serverExit={code,signal};});
  await new Promise((resolve,reject)=>{server.once('spawn',resolve);server.once('error',reject);});
  for(let i=0;i<60;i++){
    if(!ownProcessAlive())throw guardError('HARNESS_PROCESS_NOT_RUNNING',`PostgreSQL child failed: ${serverError?.message||JSON.stringify(serverExit)}\n${logs}`);
    try{client=await connect();break;}catch(error){if(error.code?.startsWith('HARNESS_'))throw error;await new Promise(r=>setTimeout(r,100));}
  }
  if(!client)throw new Error('Postgres failed to start: '+logs);
  console.log((await client.query('select version()')).rows[0].version);
  await client.query(await readFile(path.join(dir,'fixture.sql'),'utf8'));
  const snapshot=JSON.parse(await readFile(path.join(dir,'catalog.json'),'utf8'));
  const cat=snapshot.constraints[0].jsonb_build_object;
  for(const c of cat.constraints.filter(x=>x.contype==='p'))await client.query(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT ${c.conname} ${c.definition}`);
  for(const c of cat.constraints.filter(x=>x.contype!=='p'))await client.query(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT ${c.conname} ${c.definition}`);
  for(const idx of cat.indexes.filter(x=>!cat.constraints.some(c=>c.conname===x.indexname)))await client.query(idx.indexdef);
  for(const t of snapshot.triggers){await client.query(t.function_definition);await client.query(t.trigger_definition);}
  await client.query(await readFile(path.join(root,'supabase/migrations/20260925164858_durable_captive_auth_operations.sql'),'utf8'));
  await client.query(await readFile(path.join(root,'supabase/migrations/20260925180605_harden_durable_auth_recovery_under_load.sql'),'utf8'));
  // Explicitly enable sends in isolated fixture; production migration defaults off.
  await client.query('update captive_auth_worker_config set sends_enabled=true');
  const store=randomUUID(), user=randomUUID();
  await client.query('insert into stores(id,slug,name) values($1,$2,$2)',[store,'povao']);
  await client.query('insert into auth.users(id) values($1)',[user]);
  let seq=0;
  async function fixture(overrides={}){
    const f={attempt:randomUUID(),user,store,token:randomUUID(),mac:'02AA0000'+(++seq).toString(16).padStart(4,'0').toUpperCase(),ap:'AABBCCDDEEFF',ssid:'Beta',...overrides};
    await client.query(`insert into captive_auth_attempts(id,resume_token_hash,client_mac,ap_mac,ssid,store_id,expires_at)
      values($1,encode(extensions.digest($2,'sha256'),'hex'),$3,$4,$5,$6,clock_timestamp()+interval '10 minutes')`,[f.attempt,f.token,f.mac,f.ap,f.ssid,f.store]);
    return f;
  }
  async function join(f,c=client,extra={}){
    const p={p_attempt_id:f.attempt,p_user_id:f.user,p_store_id:f.store,p_controller_key:'https://controller.test/povao',p_site_id:'default',p_client_mac:f.mac,p_ap_mac:f.ap,p_association_key:'assoc-'+f.mac,p_redirect_url:'https://example.test',p_command:{minutes:40,ssid:f.ssid},p_resume_token:f.token,p_session_id:null,p_session:{trace_id:'synthetic',auth_method:'identity'},...extra};
    const keys=Object.keys(p);return (await c.query(`select join_captive_auth_operation(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as result`,Object.values(p))).rows[0].result;
  }
  async function claim(id,owner='worker',c=client){return (await c.query('select * from claim_captive_auth_operations($1,1,$2,true)',[owner,id])).rows.map(x=>x.claim_captive_auth_operations);}
  async function record(op,outcome,evidence=null,owner=op.lease_owner,c=client,retryAfterSeconds=1){return (await c.query(`select record_captive_auth_operation($1,$2,$3,$4,$5,$6,NULL,$7,$8) result`,[op.id,owner,op.lease_version,outcome,evidence,outcome==='pending'?'CLIENT_NOT_FOUND':outcome==='rejected'?'COMMAND_REJECTED':outcome==='not_sent'?'LOGIN_TEMPORARILY_UNAVAILABLE':null,outcome==='confirmed'?new Date(new Date(op.first_sent_at).getTime()+2400000).toISOString():null,retryAfterSeconds])).rows[0].result;}
  const evidence=op=>({found:true,authorized:true,mac:op.client_mac,site_id:op.site_id,controller_key:op.controller_key,observed_at:new Date().toISOString(),...(op.command_accepted_at?{}:{validity_basis:'observed_only'})});
  await test('atomic join creates session, membership and durable due work',async()=>{
    const f=await fixture();const j=await join(f);assert.equal(j.disposition,'created');
    const r=(await client.query('select o.first_sent_at,o.verification_deadline,s.status,a.status as ast from captive_auth_operations o join captive_sessions s on s.auth_operation_id=o.id join captive_auth_attempts a on a.id=s.attempt_id where o.id=$1',[j.operation.id])).rows[0];
    assert.equal(r.first_sent_at,null);assert.equal(r.verification_deadline,null);assert.equal(r.status,'submitted');assert.equal(r.ast,'authorizing');
    const timeline=(await client.query('select form_submitted_at,params_received_at from captive_sessions where id=$1',[j.session_id])).rows[0];assert.ok(timeline.form_submitted_at);assert.ok(timeline.params_received_at);
    assert.equal((await client.query('select count(*)::int n from captive_auth_work_due where operation_id=$1',[j.operation.id])).rows[0].n,1);
  });
  await test('20 independent concurrent clients join one operation and one session',async()=>{
    const f=await fixture();const cs=await Promise.all(Array.from({length:20},()=>connect()));
    const rs=await Promise.all(cs.map(c=>join(f,c)));assert.equal(new Set(rs.map(x=>x.operation.id)).size,1);assert.equal(new Set(rs.map(x=>x.session_id)).size,1);
  });
  await test('distinct eligible attempts join; other user/context cannot join',async()=>{
    const f=await fixture();const first=await join(f);const second=await fixture({mac:f.mac});assert.equal((await join(second)).operation.id,first.operation.id);
    const otherUser=randomUUID();await client.query('insert into auth.users(id) values($1)',[otherUser]);
    const wrong=await fixture({mac:f.mac,user:otherUser});const result=await join(wrong);assert.equal(result.disposition,'context_conflict');
    assert.equal((await client.query('select user_id from captive_auth_attempts where id=$1',[wrong.attempt])).rows[0].user_id,null);
  });
  await test('concurrent leases emit exactly one send; expired lease only verifies',async()=>{
    const j=await join(await fixture());const c1=await connect(),c2=await connect();
    const rows=(await Promise.all([claim(j.operation.id,'w1',c1),claim(j.operation.id,'w2',c2)])).flat();assert.equal(rows.length,1);assert.equal(rows[0].action,'send');
    await client.query("update captive_auth_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[j.operation.id]);
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[j.operation.id]);
    const replacement=(await claim(j.operation.id,'w3'))[0];assert.equal(replacement.action,'verify');assert.equal(replacement.send_count,1);assert.ok(replacement.lease_version>rows[0].lease_version);
    assert.equal((await record(rows[0],'confirmed',evidence(rows[0]))).disposition,'stale_lease');
  });
  await test('accepted command stays recoverable and confirms all participants atomically',async()=>{
    const f=await fixture(),j=await join(f);await join(await fixture({mac:f.mac}));
    const op=(await claim(j.operation.id))[0];const actualSend=new Date().toISOString();const pending=await record(op,'accepted',{command_sent:true,command_sent_at:actualSend});assert.equal(pending.operation.status,'verifying');
    const sent=(await client.query('select command_dispatched_at from captive_auth_operations where id=$1',[op.id])).rows[0];assert.equal(sent.command_dispatched_at.toISOString(),actualSend);
    const timeline=(await client.query('select min(unifi_authorize_called_at) called from captive_sessions where auth_operation_id=$1',[op.id])).rows[0];assert.equal(timeline.called.toISOString(),actualSend);
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[op.id]);
    const next=(await claim(op.id))[0];assert.equal(next.action,'verify');
    const done=await record(next,'confirmed',evidence(next));assert.equal(done.operation.status,'confirmed');
    const r=(await client.query("select (select count(*)::int from captive_sessions where auth_operation_id=$1 and status='authorized') sessions,(select count(*)::int from captive_auth_attempts where auth_operation_id=$1 and status='authorized') attempts,(select count(*)::int from audit_logs where meta->>'operation_id'=$1::text) audits,(select count(*)::int from captive_auth_work_due where operation_id=$1) due",[op.id])).rows[0];assert.deepEqual(r,{sessions:2,attempts:2,audits:2,due:0});
    const read=(await client.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token])).rows[0].r;assert.equal(read.authorized,true);assert.equal(read.operation_id,op.id);assert.equal(read.user_id,user);
    assert.equal((await record(next,'confirmed',evidence(next))).disposition,'already_terminal');
  });
  await test('database error rolls back terminal operation, attempt, session and audit',async()=>{
    const j=await join(await fixture());const op=(await claim(j.operation.id))[0];
    await client.query("create function test_reject_audit() returns trigger language plpgsql as $$begin raise exception 'INJECTED'; end;$$; create trigger test_reject_audit before insert on audit_logs for each row execute function test_reject_audit();");
    await assert.rejects(()=>record(op,'confirmed',evidence(op)),/INJECTED/);
    assert.equal((await client.query('select status from captive_auth_operations where id=$1',[op.id])).rows[0].status,'sending');
    assert.equal((await client.query('select status from captive_sessions where auth_operation_id=$1',[op.id])).rows[0].status,'submitted');
    await client.query('drop trigger test_reject_audit on audit_logs; drop function test_reject_audit();');
    assert.equal((await record(op,'confirmed',evidence(op))).applied,true);
  });
  await test('missing, mismatched, stale evidence and expired lease cannot confirm',async()=>{
    const op=(await claim((await join(await fixture())).operation.id))[0];
    await assert.rejects(()=>record(op,'confirmed',null),/CONFIRMATION_EVIDENCE_REQUIRED/);
    await assert.rejects(()=>record(op,'confirmed',{...evidence(op),mac:'FFFFFFFFFFFF'}),/CONFIRMATION_EVIDENCE_REQUIRED/);
    await assert.rejects(()=>record(op,'confirmed',{...evidence(op),observed_at:'2000-01-01T00:00:00Z'}),/STALE_CONFIRMATION_EVIDENCE/);
    await client.query("update captive_auth_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[op.id]);
    assert.equal((await record(op,'confirmed',evidence(op))).disposition,'stale_lease');
  });
  await test('watchdog terminates abandoned work despite live lease and expired capability',async()=>{
    const f=await fixture(),j=await join(f);await claim(j.operation.id);
    await client.query("update captive_auth_operations set first_sent_at=clock_timestamp()-interval '130 seconds',verification_deadline=clock_timestamp()-interval '40 seconds' where id=$1",[j.operation.id]);
    await client.query("update captive_auth_attempts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '10 minutes' where id=$1",[f.attempt]);
    await client.query('select expire_stale_auth_attempts()');assert.equal((await client.query('select status from captive_auth_attempts where id=$1',[f.attempt])).rows[0].status,'authorizing');
    await client.query('select expire_captive_auth_operations()');assert.equal((await client.query('select status from captive_sessions where auth_operation_id=$1',[j.operation.id])).rows[0].status,'failed');
    assert.equal((await client.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token])).rows[0].r.disposition,'capability_expired');
  });
  await test('legacy accepted operation imports verify-only; terminal legacy attempt rejected',async()=>{
    const f=await fixture();await client.query("update captive_auth_attempts set status='authorizing',authorization_attempts=1,authorization_started_at=clock_timestamp() where id=$1",[f.attempt]);
    const j=await join(f);assert.equal((await claim(j.operation.id))[0].action,'verify');
    const old=await fixture();await client.query("update captive_auth_attempts set status='failed' where id=$1",[old.attempt]);await assert.rejects(()=>join(old),/ATTEMPT_TERMINAL/);
  });
  await test('rate-limit block survives window expiry and blocked polls do not extend it',async()=>{
    await client.query("select rate_limit_hit('test',60,1,300)");const r=(await client.query("select rate_limit_hit('test',60,1,300) r")).rows[0].r;
    await client.query("update rate_limits set window_start=clock_timestamp()-interval '61 seconds' where key='test'");
    const blocked=(await client.query("select rate_limit_hit('test',60,1,300) r")).rows[0].r;assert.equal(blocked.allowed,false);assert.equal(blocked.blocked_until,r.blocked_until);assert.equal(blocked.count,2);
  });
  await test('daily count deduplicates participants and rejects next new grant',async()=>{
    const f=await fixture(),j=await join(f),initial=(await claim(j.operation.id))[0];await record(initial,'accepted',{command_sent:true});
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[initial.id]);
    const op=(await claim(initial.id))[0];await record(op,'confirmed',evidence(op));
    const reused=await fixture({mac:f.mac});assert.equal((await join(reused,client,{p_command:{minutes:40,max_daily_accesses:1}})).disposition,'confirmed');
    await client.query("update captive_auth_operations set confirmed_at=clock_timestamp()-interval '31 seconds' where id=$1",[op.id]);
    const newer=await fixture({mac:f.mac});assert.equal((await join(newer,client,{p_command:{minutes:40,max_daily_accesses:1}})).disposition,'daily_limit');
  });
  await test('observed-only success has no fabricated expiry, no reuse, and receipt expires at 30s',async()=>{
    const f=await fixture(),j=await join(f),op=(await claim(j.operation.id))[0];const done=await record(op,'confirmed',evidence(op));assert.equal(done.operation.authorized_until,null);
    const newAttempt=await fixture({mac:f.mac});assert.notEqual((await join(newAttempt)).operation.id,op.id);
    await client.query("update captive_auth_operations set confirmed_at=clock_timestamp()-interval '31 seconds' where id=$1",[op.id]);
    assert.equal((await client.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token])).rows[0].r.disposition,'receipt_stale');
  });
  await test('five concurrent optional challenges issue only once',async()=>{
    const f=await fixture(),j=await join(f),op=(await claim(j.operation.id))[0];await record(op,'confirmed',evidence(op));
    const cs=await Promise.all(Array.from({length:5},()=>connect()));const values=await Promise.all(cs.map(async c=>(await c.query('select claim_captive_auth_challenge($1,$2) r',[f.attempt,f.token])).rows[0].r));
    assert.equal(values.filter(Boolean).length,1);assert.equal(values.find(Boolean),user);
  });
  await test('managed attempts reject late legacy writes without changing operation',async()=>{
    const f=await fixture(),j=await join(f);await assert.rejects(()=>client.query("update captive_auth_attempts set status='failed',fail_reason='RATE_LIMIT_HIT' where id=$1",[f.attempt]),/AUTH_OPERATION_STATE_MANAGED/);
    assert.equal((await client.query('select status from captive_auth_operations where id=$1',[j.operation.id])).rows[0].status,'queued');
    await assert.rejects(()=>client.query("update captive_sessions set status='authorized' where auth_operation_id=$1",[j.operation.id]),/AUTH_OPERATION_STATE_MANAGED/);
    const op=(await claim(j.operation.id))[0];await record(op,'confirmed',evidence(op));
    await assert.rejects(()=>client.query("update captive_sessions set unifi_last_verify_result='{}'::jsonb where auth_operation_id=$1",[j.operation.id]),/AUTH_OPERATION_WRITE_REQUIRES_RPC/);
    await assert.rejects(()=>client.query("update captive_sessions set authorized_at=clock_timestamp()-interval '1 hour',fail_reason='old' where auth_operation_id=$1",[j.operation.id]),/AUTH_OPERATION_WRITE_REQUIRES_RPC/);
    assert.equal((await client.query("select current_setting('captive.auth_operation_writer',true) value")).rows[0].value,'');
  });
  await test('admin and blocked users cannot obtain optional login challenge',async()=>{
    const f=await fixture(),j=await join(f),op=(await claim(j.operation.id))[0];await record(op,'confirmed',evidence(op));
    await client.query("insert into user_blocks(user_id,reason) values($1,'synthetic')",[user]);
    assert.equal((await client.query('select claim_captive_auth_challenge($1,$2) r',[f.attempt,f.token])).rows[0].r,null);
    await client.query('delete from user_blocks where user_id=$1',[user]);
    await client.query("insert into user_roles(user_id,role) values($1,'admin')",[user]);
    assert.equal((await client.query('select claim_captive_auth_challenge($1,$2) r',[f.attempt,f.token])).rows[0].r,null);
    await client.query('delete from user_roles where user_id=$1',[user]);
  });
  await test('capability status awaits identity; expired real authorization receipt is stale',async()=>{
    const f=await fixture();const idle=(await client.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token])).rows[0].r;assert.equal(idle.status,'awaiting_identity');assert.equal(idle.authorized,false);
    const j=await join(f),first=(await claim(j.operation.id))[0];await record(first,'accepted',{command_sent:true});
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[first.id]);
    const next=(await claim(first.id))[0];await record(next,'confirmed',evidence(next));
    await client.query("update captive_auth_operations set authorized_until=clock_timestamp()-interval '1 second' where id=$1",[next.id]);
    assert.equal((await client.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token])).rows[0].r.disposition,'receipt_stale');
  });
  await test('configured cron keeps secret out of job and dispatches only due work',async()=>{
    const r=(await client.query("select configure_captive_auth_worker('https://abcdefghijklmnopqrst.supabase.co/functions/v1/captive-portal/cron/auth-reconcile',true,true) r")).rows[0].r;assert.equal(r.configured,true);
    const row=(await client.query("select c.token_hash,v.decrypted_secret,j.command,j.schedule from captive_auth_worker_config c join vault.decrypted_secrets v on v.id=c.vault_secret_id cross join cron.job j")).rows[0];assert.ok(!row.command.includes(row.decrypted_secret));assert.equal(row.schedule,'10 seconds');
    assert.equal((await client.query('select authorize_captive_auth_worker($1) r',[row.decrypted_secret])).rows[0].r,true);
    assert.equal((await client.query("select authorize_captive_auth_worker('wrong') r")).rows[0].r,false);
    await join(await fixture());await client.query('select dispatch_captive_auth_worker()');const sent=(await client.query('select headers,timeout_ms from net.test_requests order by id desc limit 1')).rows[0];assert.equal(sent.timeout_ms,55000);assert.equal(sent.headers['x-captive-worker-token'],row.decrypted_secret);
    await client.query('select finish_captive_auth_worker(2)');assert.equal((await client.query('select last_worker_failed_count from captive_auth_worker_config')).rows[0].last_worker_failed_count,2);
  });
  await test('HTTP transport exception cannot roll back database watchdog expiration',async()=>{
    const j=await join(await fixture());await client.query("update captive_auth_operations set created_at=clock_timestamp()-interval '111 seconds' where id=$1",[j.operation.id]);
    await join(await fixture()); // Independent due work still requires dispatch after expiry.
    await client.query("create or replace function net.http_post(url text,body jsonb default '{}'::jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 2000) returns bigint language plpgsql as $$begin raise exception 'transport unavailable';end;$$");
    await client.query('update captive_auth_worker_config set last_dispatch_at=null');await client.query('select dispatch_captive_auth_worker()');
    assert.equal((await client.query('select status from captive_auth_operations where id=$1',[j.operation.id])).rows[0].status,'expired_unconfirmed');
    assert.match((await client.query('select last_error_code from captive_auth_worker_config')).rows[0].last_error_code,/WORKER_DISPATCH/);
  });
  await test('public roles have no operation reads or RPC execution',async()=>{
    await client.query('set role anon');await assert.rejects(()=>client.query('select * from captive_auth_operations'),/permission denied/);
    await assert.rejects(()=>client.query("select get_captive_auth_operation(gen_random_uuid(),'bad')"),/permission denied/);await client.query('reset role');
  });
  await test('rollback send switch still permits verification',async()=>{
    const queued=await join(await fixture());const working=await join(await fixture());const op=(await claim(working.operation.id))[0];await record(op,'unknown',{command_sent:true});
    await client.query('update captive_auth_worker_config set sends_enabled=false');
    assert.equal((await claim(queued.operation.id)).length,0);
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[op.id]);
    assert.equal((await claim(op.id))[0].action,'verify');
  });
  await test('proven unsent preparation retries within immutable budget then sends once',async()=>{
    await client.query('update captive_auth_worker_config set sends_enabled=true');
    const first=(await claim((await join(await fixture())).operation.id))[0];
    await record(first,'not_sent',{command_sent:false});
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[first.id]);
    const retry=(await claim(first.id))[0];assert.equal(retry.action,'send');assert.equal(retry.prepare_failures,1);assert.equal(retry.first_sent_at,first.first_sent_at);assert.equal(retry.deadline_at,first.deadline_at);
    await record(retry,'unknown',{command_sent:true});
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[first.id]);
    const recovery=(await claim(first.id))[0];assert.equal(recovery.action,'verify');
    await assert.rejects(()=>record(recovery,'not_sent',{command_sent:false}),/KNOWN_UNSENT_EVIDENCE_REQUIRED/);
  });
  await test('three proven unsent preparations terminate honestly without endless retries',async()=>{
    const j=await join(await fixture());let result;
    for(let i=0;i<3;i++){
      await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[j.operation.id]);
      const op=(await claim(j.operation.id))[0];result=await record(op,'not_sent',{command_sent:false});
    }
    assert.equal(result.operation.status,'rejected');assert.equal(result.operation.last_error_code,'AUTHORIZATION_PREPARATION_EXHAUSTED');assert.equal((await claim(j.operation.id)).length,0);
  });
  await test('unknown without actual-send evidence cannot invent command timeline',async()=>{
    const j=await join(await fixture()),op=(await claim(j.operation.id))[0];await record(op,'unknown',{command_sent:false});
    const s=(await client.query('select unifi_authorize_called_at,unifi_cmd_accepted_at from captive_sessions where auth_operation_id=$1',[op.id])).rows[0];assert.equal(s.unifi_authorize_called_at,null);assert.equal(s.unifi_cmd_accepted_at,null);
  });
  await test('historical repair requires unique matching user/AP/SSID evidence and is idempotent',async()=>{
    const repair=await readFile(path.join(root,'supabase/migrations/20260925165002_reconcile_proven_legacy_authorization_reuse.sql'),'utf8');
    const otherUser=randomUUID();await client.query('insert into auth.users(id) values($1)',[otherUser]);
    const cases=[];
    for(const kind of ['valid','user_mismatch','ap_mismatch','ssid_mismatch','duplicate']){
      const f=await fixture();const source=randomUUID(),target=randomUUID();
      await client.query("insert into captive_sessions(id,store_id,user_id,client_mac,ap_mac,ssid,status,authorized_at,unifi_confirmed_at) values($1,$2,$3,$4,$5,$6,'authorized','2026-09-24T12:00:00Z','2026-09-24T12:00:00Z')",[source,store,kind==='user_mismatch'?otherUser:user,f.mac,kind==='ap_mismatch'?'FFFFFFFFFFFF':f.ap,kind==='ssid_mismatch'?'Different':f.ssid]);
      if(kind==='duplicate')await client.query("insert into captive_sessions(store_id,user_id,client_mac,ap_mac,ssid,status,authorized_at,unifi_confirmed_at) values($1,$2,$3,$4,$5,'authorized','2026-09-24T12:00:01Z','2026-09-24T12:00:01Z')",[store,user,f.mac,f.ap,f.ssid]);
      await client.query("insert into captive_sessions(id,attempt_id,store_id,user_id,client_mac,ap_mac,ssid,status,submitted_at,trace_id) values($1,$2,$3,$4,$5,$6,$7,'submitted','2026-09-24T12:00:19Z','historical-test')",[target,f.attempt,store,user,f.mac,f.ap,f.ssid]);
      await client.query("update captive_auth_attempts set status='authorized',authorized=true,user_id=$2,authorization_finished_at='2026-09-24T12:00:20Z' where id=$1",[f.attempt,user]);
      cases.push({kind,source,target});
    }
    const operationsBefore=(await client.query('select count(*)::int n from captive_auth_operations')).rows[0].n;
    await client.query(repair);await client.query(repair);
    for(const c of cases){
      const actual=(await client.query('select status,unifi_confirmed_at,unifi_last_verify_result from captive_sessions where id=$1',[c.target])).rows[0];
      if(c.kind==='valid'){
        assert.equal(actual.status,'authorized');assert.equal(actual.unifi_confirmed_at.toISOString(),'2026-09-24T12:00:00.000Z');assert.equal(actual.unifi_last_verify_result.reused_from_session_id,c.source);
        assert.equal((await client.query("select count(*)::int n from audit_logs where entity_id=$1 and action='legacy_confirmed_reuse_reconciled'",[c.target])).rows[0].n,1);
      }else assert.equal(actual.status,'submitted',c.kind);
    }
    assert.equal((await client.query('select count(*)::int n from captive_auth_operations')).rows[0].n,operationsBefore);
  });
  await test('active roaming joins only between mapped APs in the same store and keeps original context',async()=>{
    const apA='AA1122334401',apB='AA1122334402',apOther='AA1122334403',otherStore=randomUUID();
    await client.query("insert into stores(id,slug,name) values($1,'other','Other')",[otherStore]);
    await client.query('insert into store_access_points(ap_mac,store_id) values($1,$2),($3,$2),($4,$5)',[apA,store,apB,apOther,otherStore]);
    const f=await fixture({ap:apA}),j=await join(f);
    const roaming=await fixture({mac:f.mac,ap:apB});assert.equal((await join(roaming)).operation.id,j.operation.id);
    const original=(await client.query('select ap_mac from captive_auth_operations where id=$1',[j.operation.id])).rows[0];assert.equal(original.ap_mac,apA);
    assert.equal((await client.query('select ap_mac from captive_sessions where attempt_id=$1',[roaming.attempt])).rows[0].ap_mac,apB);
    assert.equal((await join(await fixture({mac:f.mac,ap:apOther}))).disposition,'context_conflict');
    assert.equal((await join(await fixture({mac:f.mac,ap:'AA11223344FF'}))).disposition,'context_conflict');
    const op=(await claim(j.operation.id))[0];await record(op,'accepted',{command_sent:true});
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[op.id]);
    const verify=(await claim(op.id))[0];await record(verify,'confirmed',evidence(verify));
    assert.equal((await join(await fixture({mac:f.mac,ap:apB}))).disposition,'context_conflict');
  });
  await test('status RPC uses a single snapshot while another connection completes authorization',async()=>{
    const f=await fixture(),j=await join(f),op=(await claim(j.operation.id))[0];
    const sql=await readFile(path.join(root,'supabase/migrations/20260925164858_durable_captive_auth_operations.sql'),'utf8');
    const original=sql.match(/CREATE FUNCTION public\.get_captive_auth_operation[\s\S]+?\n\$\$;/)[0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
    const instrumented=original.replace('  SELECT * INTO o FROM public.captive_auth_operations WHERE id=a.auth_operation_id;','  PERFORM pg_catalog.pg_sleep(0.3);\n  SELECT * INTO o FROM public.captive_auth_operations WHERE id=a.auth_operation_id;');
    await client.query(instrumented);const reader=await connect();
    const reading=reader.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token]);
    let sleeping=false;
    for(let i=0;i<50;i++){sleeping=(await client.query("select wait_event='PgSleep' sleeping from pg_stat_activity where pid=$1",[reader.processID])).rows[0]?.sleeping;if(sleeping)break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(sleeping,true);await record(op,'confirmed',evidence(op));
    const result=(await reading).rows[0].r;assert.equal(result.disposition,'found');assert.equal(result.processing,true);
    await client.query(original);
    assert.equal((await client.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token])).rows[0].r.authorized,true);
  });
  await test('record rechecks wall clock after waiting for the operation row lock',async()=>{
    const op=(await claim((await join(await fixture())).operation.id))[0];
    await client.query("update captive_auth_operations set lease_expires_at=clock_timestamp()+interval '200 milliseconds' where id=$1",[op.id]);
    const blocker=await connect();await blocker.query('begin');await blocker.query('select 1 from captive_auth_operations where id=$1 for update',[op.id]);
    const waiting=record(op,'confirmed',evidence(op));
    await new Promise(r=>setTimeout(r,300));await blocker.query('commit');
    assert.equal((await waiting).disposition,'stale_lease');
  });
  await test('uncertain completion exposes only the remaining 30-second cooldown',async()=>{
    const f=await fixture(),j=await join(f);await client.query("update captive_auth_operations set created_at=clock_timestamp()-interval '111 seconds' where id=$1",[j.operation.id]);
    await client.query('select expire_captive_auth_operations()');
    await client.query("update captive_auth_operations set completed_at=clock_timestamp()-interval '20 seconds' where id=$1",[j.operation.id]);
    const status=(await client.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token])).rows[0].r;
    assert.equal(status.status,'expired_unconfirmed');assert.ok(status.retry_after_ms>9000&&status.retry_after_ms<=10000);
    const retry=await join(await fixture({mac:f.mac}));assert.equal(retry.disposition,'unconfirmed_cooldown');assert.ok(retry.retry_after_ms>9000&&retry.retry_after_ms<=10000);
  });
  // Everything below is synthetic fault injection against the applied SQL as-is.
  // No remote credentials, controller requests, or migration edits are involved.
  async function waitForLock(c){
    for(let i=0;i<100;i++){
      const row=(await client.query('select wait_event_type from pg_stat_activity where pid=$1',[c.processID])).rows[0];
      if(row?.wait_event_type==='Lock')return;
      await new Promise(r=>setTimeout(r,5));
    }
    throw guardError('PROBE_SETUP_ERROR','probe did not reach the expected PostgreSQL lock wait; no product invariant was measured');
  }
  async function acceptedConfirmed(f){
    const j=await join(f),send=(await claim(j.operation.id))[0];await record(send,'accepted',{command_sent:true});
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[send.id]);
    const verify=(await claim(send.id))[0];await record(verify,'confirmed',evidence(verify));return j;
  }
  await adversarial('24 simultaneous distinct contexts select one identity without partial sessions',async()=>{
    const common=await fixture(),groups=[];
    for(let i=0;i<4;i++){const id=randomUUID();await client.query('insert into auth.users(id) values($1)',[id]);groups.push({user:id,ap:'AB000000000'+i,ssid:'Context-'+i});}
    const fs=[];for(let i=0;i<24;i++)fs.push(await fixture({mac:common.mac,...groups[i%4]}));
    const cs=await Promise.all(fs.map(()=>connect()));
    const results=await Promise.all(fs.map((f,i)=>join(f,cs[i])));
    const joined=results.filter(r=>r.operation),rejected=results.filter(r=>r.disposition==='context_conflict');
    assert.equal(joined.length,6);assert.equal(rejected.length,18);assert.equal(new Set(joined.map(r=>r.operation.id)).size,1);
    assert.equal((await client.query('select count(*)::int n from captive_sessions where client_mac=$1',[common.mac])).rows[0].n,6);
    assert.equal((await client.query('select count(*)::int n from captive_auth_work_due where operation_id=$1',[joined[0].operation.id])).rows[0].n,1);
    await Promise.all(cs.map(c=>c.end()));
  });
  await adversarial('24 independent devices are claimed once across concurrent global batches',async()=>{
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()+interval '1 hour'");
    const ids=[];for(let i=0;i<24;i++)ids.push((await join(await fixture())).operation.id);
    const cs=await Promise.all([connect(),connect(),connect()]);
    const batches=await Promise.all(cs.map((c,i)=>c.query('select * from claim_captive_auth_operations($1,10,NULL,true)',['bulk-'+i])));
    const rows=batches.flatMap(r=>r.rows.map(x=>x.claim_captive_auth_operations));
    rows.push(...(await client.query("select * from claim_captive_auth_operations('fill-first-wave',16,NULL,true)")).rows.map(x=>x.claim_captive_auth_operations));
    assert.equal(rows.length,16);assert.equal((await client.query("select count(*)::int n from captive_auth_operations where controller_key='https://controller.test/povao' and site_id='default' and lease_expires_at>clock_timestamp()")).rows[0].n,16);
    for(const op of rows)await record(op,'confirmed',evidence(op));
    rows.push(...(await client.query("select * from claim_captive_auth_operations('second-wave',16,NULL,true)")).rows.map(x=>x.claim_captive_auth_operations));
    assert.equal(rows.length,24);assert.equal(new Set(rows.map(o=>o.id)).size,24);assert.ok(rows.every(o=>ids.includes(o.id)&&o.action==='send'));
    await Promise.all(cs.map(c=>c.end()));
  });
  await adversarial('duplicate concurrent acceptance records one event and leaves one recovery item',async()=>{
    const op=(await claim((await join(await fixture())).operation.id))[0],cs=await Promise.all([connect(),connect()]);
    const rs=await Promise.all(cs.map(c=>record(op,'accepted',{command_sent:true},op.lease_owner,c)));
    assert.equal(rs.filter(r=>r.applied).length,1);assert.equal(rs.filter(r=>r.disposition==='stale_lease').length,1);
    const r=(await client.query("select (select count(*)::int from captive_auth_operation_events where operation_id=$1 and event_key like 'lease:%') events,(select count(*)::int from captive_auth_work_due where operation_id=$1) due",[op.id])).rows[0];
    assert.deepEqual(r,{events:1,due:1});await Promise.all(cs.map(c=>c.end()));
  });
  await adversarial('concurrent conflicting terminal responses commit one coherent result',async()=>{
    const f=await fixture(),op=(await claim((await join(f)).operation.id))[0],cs=await Promise.all([connect(),connect()]);
    const rs=await Promise.all([record(op,'confirmed',evidence(op),op.lease_owner,cs[0]),record(op,'rejected',{explicit_rejection:true},op.lease_owner,cs[1])]);
    assert.equal(rs.filter(r=>r.applied).length,1);assert.equal(rs.filter(r=>r.disposition==='already_terminal').length,1);
    const r=(await client.query("select o.status,a.status attempt,s.status session,(select count(*)::int from audit_logs where meta->>'operation_id'=o.id::text) audits,(select count(*)::int from captive_auth_work_due where operation_id=o.id) due from captive_auth_operations o join captive_auth_attempts a on a.auth_operation_id=o.id join captive_sessions s on s.auth_operation_id=o.id where o.id=$1",[op.id])).rows[0];
    assert.equal(r.attempt,r.status==='confirmed'?'authorized':'failed');assert.equal(r.session,r.attempt);assert.equal(r.audits,1);assert.equal(r.due,0);await Promise.all(cs.map(c=>c.end()));
  });
  await adversarial('cancelled and invalid participants do not promote or poison eligible participants',async()=>{
    const f=await fixture(),j=await join(f),cancelled=await fixture({mac:f.mac}),invalid=await fixture({mac:f.mac});
    await join(cancelled);await join(invalid);const differentUser=randomUUID();await client.query('insert into auth.users(id) values($1)',[differentUser]);
    // Managed cancellation is deliberately rejected; inject impossible old state as DBA
    // to test recovery's documented skip behavior, not public API reachability.
    await assert.rejects(()=>client.query("update captive_auth_attempts set status='cancelled' where id=$1",[cancelled.attempt]),/AUTH_OPERATION_STATE_MANAGED/);
    await client.query('alter table captive_auth_attempts disable trigger guard_captive_auth_attempt_state');
    try{await client.query("update captive_auth_attempts set status='cancelled' where id=$1",[cancelled.attempt]);}
    finally{await client.query('alter table captive_auth_attempts enable trigger guard_captive_auth_attempt_state');}
    await client.query('update captive_auth_operation_members set user_id=$2 where attempt_id=$1',[invalid.attempt,differentUser]);
    const op=(await claim(j.operation.id))[0];await record(op,'confirmed',evidence(op));
    const rs=(await client.query('select id,status,authorized from captive_auth_attempts where id=any($1::uuid[])',[[f.attempt,cancelled.attempt,invalid.attempt]])).rows;
    assert.equal(rs.find(x=>x.id===f.attempt).status,'authorized');assert.equal(rs.find(x=>x.id===cancelled.attempt).status,'cancelled');assert.equal(rs.find(x=>x.id===invalid.attempt).authorized,false);
    for(const excluded of [cancelled,invalid]){
      assert.equal((await client.query('select get_captive_auth_operation($1,$2) r',[excluded.attempt,excluded.token])).rows[0].r.authorized,false);
      const joined=await join(excluded);assert.equal(joined.disposition,'state_inconsistent');assert.equal(joined.operation,null);
    }
  });
  await adversarial('block after accepted send preserves truthful Wi-Fi result but forbids login challenge',async()=>{
    const blockedUser=randomUUID();await client.query('insert into auth.users(id) values($1)',[blockedUser]);const f=await fixture({user:blockedUser}),j=await join(f),send=(await claim(j.operation.id))[0];
    await record(send,'accepted',{command_sent:true});await client.query("insert into user_blocks(user_id,reason) values($1,'synthetic after-send block')",[blockedUser]);
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[send.id]);
    const verify=(await claim(send.id))[0];await record(verify,'confirmed',evidence(verify));
    assert.equal((await client.query('select get_captive_auth_operation($1,$2) r',[f.attempt,f.token])).rows[0].r.authorized,true);
    assert.equal((await client.query('select claim_captive_auth_challenge($1,$2) r',[f.attempt,f.token])).rows[0].r,null);
  });
  await adversarial('failed creation rolls back identity, session, membership and outbox before safe retry',async()=>{
    const f=await fixture();
    await client.query("create function test_fail_creation() returns trigger language plpgsql as $$begin if NEW.event_key='created' then raise exception 'CREATION_STORAGE_FAILURE';end if;return NEW;end;$$; create trigger test_fail_creation before insert on captive_auth_operation_events for each row execute function test_fail_creation();");
    try{await assert.rejects(()=>join(f),/CREATION_STORAGE_FAILURE/);}finally{await client.query('drop trigger test_fail_creation on captive_auth_operation_events;drop function test_fail_creation();');}
    const a=(await client.query('select user_id,captive_session_id,auth_operation_id from captive_auth_attempts where id=$1',[f.attempt])).rows[0];assert.deepEqual(a,{user_id:null,captive_session_id:null,auth_operation_id:null});
    assert.equal((await client.query('select count(*)::int n from captive_sessions where attempt_id=$1',[f.attempt])).rows[0].n,0);
    assert.equal((await client.query('select count(*)::int n from captive_auth_operations where client_mac=$1',[f.mac])).rows[0].n,0);
    assert.equal((await join(f)).disposition,'created');
  });
  await adversarial('lease renewal refuses an owner whose lease expired during row-lock wait',async()=>{
    const op=(await claim((await join(await fixture())).operation.id))[0],blocker=await connect(),renewer=await connect();
    await client.query("update captive_auth_operations set lease_expires_at=clock_timestamp()+interval '1000 milliseconds' where id=$1",[op.id]);
    await blocker.query('begin');await blocker.query('select 1 from captive_auth_operations where id=$1 for update',[op.id]);
    const waiting=renewer.query('select renew_captive_auth_operation_lease($1,$2,$3) renewed',[op.id,op.lease_owner,op.lease_version]);
    try{await waitForLock(renewer);await new Promise(r=>setTimeout(r,1100));}finally{await blocker.query('commit');}
    const renewed=(await waiting).rows[0].renewed;observations.push({probe:'renew_after_lock_expiry',renewed});await blocker.end();await renewer.end();assert.equal(renewed,false);
  });
  await adversarial('join cannot reuse an authorization that expired while waiting on device lock',async()=>{
    const f=await fixture(),j=await acceptedConfirmed(f),fresh=await fixture({mac:f.mac}),blocker=await connect(),waiter=await connect();
    await client.query("update captive_auth_operations set authorized_until=clock_timestamp()+interval '1000 milliseconds' where id=$1",[j.operation.id]);
    await blocker.query('begin');await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[store+'|'+f.mac]);
    const waiting=join(fresh,waiter);try{await waitForLock(waiter);await new Promise(r=>setTimeout(r,1100));}finally{await blocker.query('commit');}
    const result=await waiting,status=(await client.query('select get_captive_auth_operation($1,$2) r',[fresh.attempt,fresh.token])).rows[0].r;
    observations.push({probe:'join_after_grant_expiry',join_disposition:result.disposition,join_authorized:result.operation?.authorized,status_disposition:status.disposition});await blocker.end();await waiter.end();
    assert.notEqual(result.operation?.authorized,true,'Join returned authorization even though its subsequent status is receipt_stale');
  });
  await adversarial('existing membership cannot bypass capability expiry during operation-lock wait',async()=>{
    const f=await fixture(),j=await join(f),blocker=await connect(),waiter=await connect();
    await client.query("update captive_auth_attempts set expires_at=clock_timestamp()+interval '1000 milliseconds' where id=$1",[f.attempt]);
    await blocker.query('begin');await blocker.query('select 1 from captive_auth_operations where id=$1 for update',[j.operation.id]);
    const waiting=join(f,waiter).then(result=>({result}),error=>({error:error.message}));
    try{await waitForLock(waiter);await new Promise(r=>setTimeout(r,1100));}finally{await blocker.query('commit');}
    const result=await waiting;observations.push({probe:'join_after_capability_expiry',disposition:result.result?.disposition,error:result.error});await blocker.end();await waiter.end();
    assert.match(result.error||'',/EXPIRED|NO_LONGER_ELIGIBLE/);
  });
  await adversarial('known-unsent retry cannot emit a fresh send after the verification deadline',async()=>{
    const first=(await claim((await join(await fixture())).operation.id))[0];await record(first,'not_sent',{command_sent:false});
    await client.query("update captive_auth_operations set first_sent_at=clock_timestamp()-interval '91 seconds',verification_deadline=clock_timestamp()-interval '1 second' where id=$1",[first.id]);
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[first.id]);
    const rows=await claim(first.id),remaining=rows[0]?new Date(rows[0].lease_expires_at)-Date.now():null;
    let accepted,acceptedError;
    if(rows[0]?.action==='send')try{accepted=await record(rows[0],'accepted',{command_sent:true});}catch(error){acceptedError=error.message;}
    observations.push({probe:'send_after_verification_deadline',actions:rows.map(o=>o.action),lease_remaining_ms:remaining,accepted_result_status:accepted?.operation.status,accepted_error:acceptedError});
    assert.ok(rows.every(o=>o.action!=='send'),'Expired preparation budget still permits an actual new POST');
  });
  await adversarial('late actual-send responses persist their effect and terminal projections atomically',async()=>{
    const cases=[];
    for(const outcome of ['accepted','unknown']){
      const initial=(await claim((await join(await fixture())).operation.id))[0];await record(initial,'not_sent',{command_sent:false});
      await client.query("update captive_auth_operations set first_sent_at=clock_timestamp()-interval '72 seconds',verification_deadline=clock_timestamp()+interval '18 seconds' where id=$1",[initial.id]);
      await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[initial.id]);
      const op=(await claim(initial.id))[0];assert.equal(op.action,'send');assert.ok(new Date(op.deadline_at)-Date.now()>=16000,'This send must be claimed with its full preparation budget');
      // Advance only this fixture by 17.5 seconds after the valid claim, keeping
      // the original deadline and lease offsets relative to its first intent.
      const shifted=(await client.query("update captive_auth_operations set first_sent_at=first_sent_at-interval '17.5 seconds',verification_deadline=verification_deadline-interval '17.5 seconds',lease_expires_at=lease_expires_at-interval '17.5 seconds' where id=$1 returning lease_expires_at",[op.id])).rows[0];
      // Real elapsed time: send was legitimately claimed before the deadline,
      // but its result arrives after that deadline and within the actual lease.
      await new Promise(r=>setTimeout(r,650));assert.ok(shifted.lease_expires_at>Date.now());
      let result,error;try{result=await record(op,outcome,{command_sent:true});}catch(e){error=e.message;}
      const state=(await client.query('select o.status,o.command_accepted_at,o.command_dispatched_at,a.status attempt,s.status session from captive_auth_operations o join captive_auth_attempts a on a.auth_operation_id=o.id join captive_sessions s on s.auth_operation_id=o.id where o.id=$1',[op.id])).rows[0];
      cases.push({outcome,error,applied:result?.applied,state});
    }
    observations.push({probe:'late_actual_send_guard_conflict',cases});
    assert.deepEqual(cases.map(c=>c.error||null),[null,null],'Terminal operation state conflicts with pre-projection attempt/session telemetry update');
    assert.ok(cases.every(c=>c.applied&&c.state.status==='expired_unconfirmed'&&c.state.attempt==='failed'&&c.state.session==='failed'&&c.state.command_dispatched_at));
  });
  await adversarial('one audit poison item cannot prevent claiming unrelated healthy work',async()=>{
    const poison=await join(await fixture()),expiredHealthy=await join(await fixture()),fresh=await join(await fixture());
    await client.query("update captive_auth_operations set created_at=clock_timestamp()-interval '115 seconds' where id=any($1::uuid[])",[[poison.operation.id,expiredHealthy.operation.id]]);
    await client.query(`create function test_poison_one_audit() returns trigger language plpgsql as $$begin if NEW.meta->>'operation_id'='${poison.operation.id}' then raise exception 'POISON_OPERATION_AUDIT'; end if; return NEW;end;$$; create trigger test_poison_one_audit before insert on audit_logs for each row execute function test_poison_one_audit();`);
    let rows,error;
    try{try{rows=await claim(fresh.operation.id);}catch(e){error=e.message;}
      const states=(await client.query('select status,count(*)::int n from captive_auth_operations where id=any($1::uuid[]) group by status',[[poison.operation.id,expiredHealthy.operation.id,fresh.operation.id]])).rows;
      observations.push({probe:'poison_watchdog_blocks_global_claim',error,states});
      const first=(await client.query('select failure_count,last_sqlstate,extract(epoch from(next_retry_at-last_failed_at))::int delay from captive_auth_recovery_failures where operation_id=$1',[poison.operation.id])).rows[0];
      assert.deepEqual(first,{failure_count:1,last_sqlstate:'P0001',delay:10});
      await client.query('select expire_captive_auth_operations(500)');
      assert.equal((await client.query('select failure_count from captive_auth_recovery_failures where operation_id=$1',[poison.operation.id])).rows[0].failure_count,1);
      await client.query("update captive_auth_recovery_failures set next_retry_at=clock_timestamp()-interval '1 second' where operation_id=$1",[poison.operation.id]);await client.query('select expire_captive_auth_operations(500)');
      assert.equal((await client.query('select extract(epoch from(next_retry_at-last_failed_at))::int delay from captive_auth_recovery_failures where operation_id=$1',[poison.operation.id])).rows[0].delay,20);
    }finally{
      await client.query('drop trigger test_poison_one_audit on audit_logs;drop function test_poison_one_audit();');
      await client.query("update captive_auth_recovery_failures set next_retry_at=clock_timestamp()-interval '1 second' where operation_id=$1",[poison.operation.id]);await client.query('select expire_captive_auth_operations(500)');
    }
    assert.equal(error,undefined,'Expiry of an unrelated poison operation aborted the healthy claim');assert.equal(rows?.length,1);
    assert.equal((await client.query('select count(*)::int n from captive_auth_recovery_failures where operation_id=$1',[poison.operation.id])).rows[0].n,0);
    assert.equal((await client.query('select status from captive_auth_operations where id=$1',[poison.operation.id])).rows[0].status,'expired_unconfirmed');
  });
  await test('existing join returns a stale receipt instead of reusing its expired authorization',async()=>{
    const f=await fixture(),j=await acceptedConfirmed(f);await client.query("update captive_auth_operations set authorized_until=clock_timestamp()-interval '1 second' where id=$1",[j.operation.id]);
    const retry=await join(f);assert.equal(retry.disposition,'receipt_stale');assert.equal(retry.operation,null);assert.equal(retry.authorized,false);
  });
  await test('confirmed candidate is rechecked after its row-lock wait before a new attempt joins',async()=>{
    const f=await fixture(),j=await acceptedConfirmed(f),fresh=await fixture({mac:f.mac}),blocker=await connect(),waiter=await connect();
    await client.query("update captive_auth_operations set authorized_until=clock_timestamp()+interval '1000 milliseconds' where id=$1",[j.operation.id]);
    await blocker.query('begin');await blocker.query('select 1 from captive_auth_operations where id=$1 for update',[j.operation.id]);
    const waiting=join(fresh,waiter);try{await waitForLock(waiter);await new Promise(r=>setTimeout(r,1100));}finally{await blocker.query('commit');}
    const joined=await waiting;assert.equal(joined.disposition,'created');assert.notEqual(joined.operation.id,j.operation.id);assert.equal(joined.operation.authorized,false);await blocker.end();await waiter.end();
  });
  await test('verification claims precede queued sends and use the nearest immutable deadline',async()=>{
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()+interval '1 hour'");
    const queued=await join(await fixture()),later=await join(await fixture()),sooner=await join(await fixture());
    for(const j of [later,sooner]){const op=(await claim(j.operation.id))[0];await record(op,'accepted',{command_sent:true});await client.query("update captive_auth_work_due set due_at=clock_timestamp()+interval '1 hour' where operation_id=$1",[op.id]);}
    await client.query("update captive_auth_operations set verification_deadline=clock_timestamp()+interval '35 seconds' where id=$1",[sooner.operation.id]);
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '2 seconds' where operation_id=any($1::uuid[])",[[later.operation.id,sooner.operation.id]]);
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 minute' where operation_id=$1",[queued.operation.id]);
    const op=(await client.query("select * from claim_captive_auth_operations('priority',1,NULL,true)")).rows[0].claim_captive_auth_operations;assert.equal(op.id,sooner.operation.id);assert.equal(op.action,'verify');
  });
  await test('fresh send is forbidden near deadline and known-unsent work finishes without extending time',async()=>{
    const op=(await claim((await join(await fixture())).operation.id))[0];await record(op,'not_sent',{command_sent:false});
    const before=(await client.query("update captive_auth_operations set first_sent_at=clock_timestamp()-interval '75 seconds',verification_deadline=clock_timestamp()+interval '15 seconds' where id=$1 returning first_sent_at,verification_deadline",[op.id])).rows[0];
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[op.id]);assert.equal((await claim(op.id)).length,0);
    const after=(await client.query('select first_sent_at,verification_deadline,status,last_error_code,command_dispatched_at from captive_auth_operations where id=$1',[op.id])).rows[0];
    assert.deepEqual(after.first_sent_at,before.first_sent_at);assert.deepEqual(after.verification_deadline,before.verification_deadline);assert.equal(after.status,'expired_unconfirmed');assert.equal(after.last_error_code,'AUTHORIZATION_PREPARATION_BUDGET_EXHAUSTED');assert.equal(after.command_dispatched_at,null);
  });
  await test('recovery diagnostics and expiration helper remain private to the trusted database writer',async()=>{
    await client.query('set role anon');try{await assert.rejects(()=>client.query('select * from captive_auth_recovery_failures'),/permission denied/);}finally{await client.query('reset role');}
    await client.query('set role service_role');try{
      await client.query('select * from captive_auth_recovery_failures');
      await assert.rejects(()=>client.query("insert into captive_auth_recovery_failures values(gen_random_uuid(),1,'P0001',now(),now(),now())"),/permission denied/);
      await assert.rejects(()=>client.query("select try_expire_captive_auth_operation(gen_random_uuid(),'test')"),/permission denied/);
    }finally{await client.query('reset role');}
    const bad=(await client.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('join_captive_auth_operation','claim_captive_auth_operations','renew_captive_auth_operation_lease','record_captive_auth_operation','expire_captive_auth_operations','sync_captive_auth_operation','try_expire_captive_auth_operation') and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or not coalesce(p.proconfig @> array['search_path=\"\"'],false))")).rows;
    assert.deepEqual(bad,[]);
  });
  await test('controller capacity includes targeted and cross-store claims but is independent across controllers',async()=>{
    const otherStore=randomUUID();await client.query("insert into stores(id,slug,name) values($1,'capacity-other-store','Capacity other store')",[otherStore]);
    const ids=[];for(let i=0;i<17;i++)ids.push((await join(await fixture({store:i%2?otherStore:store}))).operation.id);
    const claimed=[];for(let i=0;i<16;i++){const rows=await claim(ids[i],'targeted-'+i);assert.equal(rows.length,1);claimed.push(rows[0]);}
    assert.equal((await claim(ids[16],'targeted-over-cap')).length,0);
    const live=(await client.query("select count(*)::int n,count(distinct store_id)::int stores from captive_auth_operations where controller_key='https://controller.test/povao' and site_id='default' and lease_expires_at>clock_timestamp()")).rows[0];assert.deepEqual(live,{n:16,stores:2});
    const independent=await join(await fixture(),client,{p_controller_key:'https://independent-controller.test/default'});
    const independentClaim=(await client.query("select * from claim_captive_auth_operations('independent-global',1,NULL,true)")).rows.map(x=>x.claim_captive_auth_operations);
    assert.equal(independentClaim.length,1);assert.equal(independentClaim[0].id,independent.operation.id);
    // Release one slot with a known accepted command. Its due read must get the
    // slot before a targeted browser request can start a fresh send.
    await record(claimed[0],'accepted',{command_sent:true});await client.query("update captive_auth_work_due set due_at=clock_timestamp()-interval '1 second' where operation_id=$1",[claimed[0].id]);
    assert.equal((await claim(ids[16],'cannot-bypass-due-verify')).length,0);
    const verify=(await claim(claimed[0].id,'priority-read'))[0];assert.equal(verify.action,'verify');await record(verify,'confirmed',evidence(verify));
    assert.equal((await claim(ids[16],'after-verification')).length,1);
  });
  // Use the actual shipped coordinator/policy, not a copied scheduler model.
  const localRequire=createRequire(import.meta.url),typescript=localRequire(path.join(root,'node_modules/typescript'));
  const coordinatorSource=await readFile(path.join(root,'supabase/functions/_shared/durable-auth.ts'),'utf8');
  const coordinatorModule={exports:{}};
  runInNewContext(typescript.transpileModule(coordinatorSource,{compilerOptions:{module:typescript.ModuleKind.CommonJS,target:typescript.ScriptTarget.ES2022}}).outputText,
    {module:coordinatorModule,exports:coordinatorModule.exports,console,Date,setTimeout,clearTimeout,AbortController,performance,crypto:globalThis.crypto});
  const {drainAuthorization,AUTH_WORKER_POLICY}=coordinatorModule.exports;
  assert.equal(typeof drainAuthorization,'function');
  async function runBrowserlessLoad(size,alreadyAccepted=false){
    // Accelerate time by aging only these synthetic operations and their outbox.
    // The production RPC ordering, watchdog, leases and record functions are unchanged.
    await client.query("update captive_auth_work_due set due_at=clock_timestamp()+interval '1 hour'");
    const ids=[];for(let i=0;i<size;i++)ids.push((await join(await fixture())).operation.id);
    const ticks=[];let sent=0,verified=0,leaseRejected=0;
    // Second scenario: each request's inline pass completed its POST before all
    // browsers disappeared. There are no queued sends competing with recovery.
    if(alreadyAccepted){
      for(const id of ids){const op=(await claim(id))[0];await record(op,'accepted',{command_sent:true},op.lease_owner,client,2);sent++;await client.query("update captive_auth_work_due set due_at=clock_timestamp()+interval '1 hour' where operation_id=$1",[op.id]);}
      await client.query("update captive_auth_work_due set due_at=clock_timestamp()+interval '2 seconds' where operation_id=any($1::uuid[])",[ids]);
    }
    for(let tick=0;tick<24;tick++){
      const actions=[];
      const db={rpc:async(name,args)=>{
        assert.ok(['claim_captive_auth_operations','record_captive_auth_operation'].includes(name));
        const keys=Object.keys(args);try{
          const result=await client.query(`select ${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) r`,Object.values(args));
          const data=name==='claim_captive_auth_operations'?result.rows.map(r=>r.r):result.rows[0].r;
          if(Array.isArray(data))assert.ok(data.every(o=>ids.includes(o.id)));
          return {data,error:null};
        }catch(error){return {data:null,error:{message:error.message,code:error.code}};}
      }};
      const work=await drainAuthorization(db,{
        send:async op=>{sent++;actions.push('send');return {status:'accepted',command_sent:true,effective_mac:op.client_mac,command_sent_at:new Date().toISOString()};},
        verify:async op=>{verified++;actions.push('verify');return {state:'authorized',found:true,authorized:true,effective_mac:op.client_mac,evidence:evidence(op)};},
      },{owner:'capacity-'+tick});
      leaseRejected+=work.errors.filter(e=>e.includes('LEASE_BUDGET_EXHAUSTED')).length;
      assert.equal(work.errors.length,0,work.errors.join(','));
      ticks.push({tick,simulated_seconds:tick*10,actions,batches:work.batches});
      await client.query("update captive_auth_operations set created_at=created_at-interval '10 seconds',first_sent_at=first_sent_at-interval '10 seconds',command_dispatched_at=command_dispatched_at-interval '10 seconds',command_accepted_at=command_accepted_at-interval '10 seconds',verification_deadline=verification_deadline-interval '10 seconds',next_check_at=next_check_at-interval '10 seconds',lease_expires_at=lease_expires_at-interval '10 seconds',confirmed_at=confirmed_at-interval '10 seconds',authorized_until=authorized_until-interval '10 seconds',completed_at=completed_at-interval '10 seconds' where id=any($1::uuid[])",[ids]);
      await client.query("update captive_auth_work_due set due_at=due_at-interval '10 seconds' where operation_id=any($1::uuid[])",[ids]);
    }
    const states=(await client.query('select status,count(*)::int n from captive_auth_operations where id=any($1::uuid[]) group by status',[ids])).rows;
    const result={probe:'browserless_'+size+'_'+(alreadyAccepted?'accepted':'queued')+'_capacity',policy:AUTH_WORKER_POLICY,sent,verified,leaseRejected,states,ticks};observations.push(result);return result;
  }
  await adversarial('four browserless clients calibrate the accelerated real-SQL capacity probe',async()=>{
    const result=await runBrowserlessLoad(4);assert.equal(result.sent,4);assert.equal(result.verified,4);assert.equal(result.leaseRejected,0);assert.equal(result.states.find(s=>s.status==='confirmed')?.n,4);
  });
  await adversarial('40 browserless clients all confirm with bounded batches per ten-second cron tick',async()=>{
    const result=await runBrowserlessLoad(40);
    assert.equal(result.states.find(s=>s.status==='confirmed')?.n||0,40,'FIFO queued sends starved verification despite always-successful synthetic controller');
  });
  await adversarial('40 already-accepted browserless clients all confirm before recovery budget expires',async()=>{
    const result=await runBrowserlessLoad(40,true);
    assert.equal(result.states.find(s=>s.status==='confirmed')?.n||0,40,'Final accepted cohort cannot fit the minimum lease budget with bounded batches per ten-second cron tick');
  });
  await writeFile(path.join(dir,'results.json'),JSON.stringify({postgres:(await client.query('select version()')).rows[0].version,passed,adversarialFailures,observations,finished_at:new Date().toISOString()},null,2));
  console.log(`${passed.length} behavioral PostgreSQL integration tests passed; ${adversarialFailures.length} adversarial invariants failed`);
  if(adversarialFailures.length)process.exitCode=1;
} catch(e){console.error(e);process.exitCode=1;}
finally {
  for(const c of clients)await c.end().catch(()=>{});
  // Never stop a server by the shared port. Only this still-live child and its
  // matching fresh data directory can be targeted by pg_ctl; startup failures
  // without a matching pidfile are terminated through our ChildProcess handle.
  if(ownProcessAlive()){
    try{
      const matching=await ownedPidFile().catch(()=>false);
      if(matching&&ownProcessAlive())run('pg_ctl.exe',['-D',data,'stop','-m','fast','-w']);
      else if(ownProcessAlive())server.kill();
    }catch(error){console.error('Owned PostgreSQL cleanup failed:',error);process.exitCode=1;if(ownProcessAlive())server.kill();}
  }
  await writeFile(path.join(dir,'server-last.log'),logs);
}
