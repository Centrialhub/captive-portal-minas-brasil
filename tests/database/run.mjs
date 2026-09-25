import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const dir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(dir,'../..');
const bin=path.join(dir,'node_modules/@embedded-postgres/windows-x64/native/bin');
const data=path.join(dir,'data-'+Date.now());
const port=55439;
const options={host:'127.0.0.1',port,user:'postgres',database:'postgres'};
if(process.platform!=='win32')throw new Error('This native PostgreSQL harness currently targets Windows x64; see README.');
if(options.host!=='127.0.0.1')throw new Error('Database contract tests require loopback.');
const run=(exe,args)=>{const r=spawnSync(path.join(bin,exe),args,{windowsHide:true,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr||r.stdout);return r.stdout;};
await mkdir(data,{recursive:true});
run('initdb.exe',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C']);
const server=spawn(path.join(bin,'postgres.exe'),['-D',data,'-h','127.0.0.1','-p',String(port)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
let client; const clients=[]; const passed=[];
async function connect(){const c=new pg.Client(options);await c.connect();clients.push(c);return c;}
const test=async(name,fn)=>{await fn();passed.push(name);console.log('PASS '+name);};
try {
  for(let i=0;i<60;i++){try{client=await connect();break;}catch{await new Promise(r=>setTimeout(r,100));}}
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
  async function record(op,outcome,evidence=null,owner=op.lease_owner){return (await client.query(`select record_captive_auth_operation($1,$2,$3,$4,$5,$6,NULL,$7,1) result`,[op.id,owner,op.lease_version,outcome,evidence,outcome==='pending'?'CLIENT_NOT_FOUND':outcome==='rejected'?'COMMAND_REJECTED':outcome==='not_sent'?'LOGIN_TEMPORARILY_UNAVAILABLE':null,outcome==='confirmed'?new Date(new Date(op.first_sent_at).getTime()+2400000).toISOString():null])).rows[0].result;}
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
    await client.query('select dispatch_captive_auth_worker()');const sent=(await client.query('select headers,timeout_ms from net.test_requests order by id desc limit 1')).rows[0];assert.equal(sent.timeout_ms,25000);assert.equal(sent.headers['x-captive-worker-token'],row.decrypted_secret);
    await client.query('select finish_captive_auth_worker(2)');assert.equal((await client.query('select last_worker_failed_count from captive_auth_worker_config')).rows[0].last_worker_failed_count,2);
  });
  await test('HTTP transport exception cannot roll back database watchdog expiration',async()=>{
    const j=await join(await fixture());await client.query("update captive_auth_operations set created_at=clock_timestamp()-interval '111 seconds' where id=$1",[j.operation.id]);
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
  await writeFile(path.join(dir,'results.json'),JSON.stringify({postgres:(await client.query('select version()')).rows[0].version,passed,finished_at:new Date().toISOString()},null,2));
  console.log(`${passed.length} behavioral PostgreSQL integration tests passed`);
} catch(e){console.error(e);process.exitCode=1;}
finally {for(const c of clients)await c.end().catch(()=>{});run('pg_ctl.exe',['-D',data,'stop','-m','fast','-w']);await writeFile(path.join(dir,'server-last.log'),logs);}
