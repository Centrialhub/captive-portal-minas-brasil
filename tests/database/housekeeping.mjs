// Native PostgreSQL retention tests. No URL/credentials for an external database
// are accepted. The child PID and fresh data directory are verified before writes.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import pg from 'pg';
const dir=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(dir,'../..');
const out=path.join(root,'tmp/post-audit-fixes-20260926/retention');
await mkdir(out,{recursive:true});
const data=await mkdtemp(path.join(out,'pg-')),expectedData=await realpath(data);
const bin=path.join(dir,'node_modules/@embedded-postgres/windows-x64/native/bin');
const options={host:'127.0.0.1',port:55469,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};
const samePath=(a,b)=>path.resolve(a).replaceAll('\\','/').toLowerCase()===path.resolve(b).replaceAll('\\','/').toLowerCase();
const run=(exe,args)=>{const r=spawnSync(path.join(bin,exe),args,{windowsHide:true,encoding:'utf8'});if(r.error)throw r.error;if(r.status!==0)throw new Error(r.stderr||r.stdout);};
let server,serverExit,serverError,logs='',client;const clients=[],passed=[];
const alive=()=>{if(!server?.pid||serverError||serverExit||server.exitCode!==null||server.signalCode!==null)return false;try{process.kill(server.pid,0);return true;}catch{return false;}};
async function ownedPid(){const p=(await readFile(path.join(data,'postmaster.pid'),'utf8')).split(/\r?\n/);return Number(p[0])===server.pid&&samePath(await realpath(p[1]),expectedData);}
async function connect(){const c=new pg.Client(options);await c.connect();const actual=(await c.query('show data_directory')).rows[0].data_directory;if(!samePath(await realpath(actual),expectedData)||!alive()||!await ownedPid()){await c.end();throw new Error('HARNESS_CLUSTER_MISMATCH');}clients.push(c);return c;}
const tables=['captive_identity_admissions','captive_auth_work_due','captive_auth_operation_events','captive_auth_operation_members','oauth_browser_handoffs','captive_verifications','leads','portal_events','captive_sessions','captive_auth_attempts','captive_auth_operations','rate_limits','audit_logs'];
async function snapshot(){const result={};for(const table of tables)result[table]=(await client.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') rows from public.${table} t`)).rows[0].rows;return result;}
async function test(name,fn){await client.query('TRUNCATE '+tables.map(t=>'public.'+t).join(',')+' CASCADE');await fn();passed.push(name);console.log('PASS '+name);}
const migration=name=>readFile(path.join(root,'supabase/migrations',name),'utf8');
try{
  assert.equal(process.platform,'win32');assert.equal(options.host,'127.0.0.1');
  run('initdb.exe',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C']);
  server=spawn(path.join(bin,'postgres.exe'),['-D',data,'-h',options.host,'-p',String(options.port)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);server.once('error',e=>serverError=e);server.once('exit',(code,signal)=>serverExit={code,signal});
  await new Promise((resolve,reject)=>{server.once('spawn',resolve);server.once('error',reject);});
  for(let i=0;i<60;i++){if(!alive())throw new Error('PostgreSQL child stopped');try{client=await connect();break;}catch(e){if(e.message==='HARNESS_CLUSTER_MISMATCH')throw e;await new Promise(r=>setTimeout(r,100));}}
  assert.ok(client,'owned PostgreSQL started');
  await client.query(await readFile(path.join(dir,'fixture.sql'),'utf8'));
  const catalog=JSON.parse(await readFile(path.join(dir,'catalog.json'),'utf8'));
  const cat=catalog.constraints[0].jsonb_build_object;
  for(const c of [...cat.constraints.filter(c=>c.contype==='p'),...cat.constraints.filter(c=>c.contype!=='p')])await client.query(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT ${c.conname} ${c.definition}`);
  for(const idx of cat.indexes.filter(x=>!cat.constraints.some(c=>c.conname===x.indexname)))await client.query(idx.indexdef);
  for(const trigger of catalog.triggers){await client.query(trigger.function_definition);await client.query(trigger.trigger_definition);}
  // The old coordinator fixture omitted these relations. Load their actual DDL,
  // rather than a reduced foreign-key mock, including the existing update triggers.
  const base=await migration('20260213133939_a698b03b-29fb-4d7b-a2e3-ce35193a5731.sql');
  await client.query(base.match(/CREATE TABLE public\.leads \([\s\S]*?\n\);/)[0]);
  await client.query(base.match(/CREATE OR REPLACE FUNCTION public\.normalize_lead_mac[\s\S]*?EXECUTE FUNCTION public\.normalize_lead_mac\(\);/)[0]);
  await client.query('CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()');
  await client.query('ALTER TABLE public.leads ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()');
  const otp=await migration('20260225125643_25c8326c-7bd3-4740-af79-65d20744d258.sql');
  await client.query(otp.slice(0,otp.indexOf('-- Enable RLS')));
  const handoff=await migration('20260826202326_harden_captive_flow_and_oauth_handoff.sql');
  await client.query(handoff.slice(handoff.indexOf('CREATE TABLE IF NOT EXISTS public.oauth_browser_handoffs'),handoff.indexOf('CREATE OR REPLACE FUNCTION public.claim_oauth_browser_handoff')));
  for(const name of ['20260925164858_durable_captive_auth_operations.sql','20260925180605_harden_durable_auth_recovery_under_load.sql','20260926180129_atomic_captive_housekeeping.sql','20260926180137_nat_safe_identity_admission.sql','20260926180635_preserve_authorized_attempt_retention.sql'])await client.query(await migration(name));
  const store=randomUUID(),user=randomUUID();await client.query('insert into stores(id,slug,name) values($1,\'povao\',\'Synthetic\');',[store]);await client.query('insert into auth.users(id) values($1)',[user]);
  let seq=0;
  const reference=new Date(),day=86400000,ago=d=>new Date(reference.getTime()-d*day).toISOString();
  async function fixture({age=181,status='failed',operation=true,opAge=age,existing=null,active=false}={}){
    const a=randomUUID(),s=randomUUID(),o=existing??(operation?randomUUID():null),mac='02AA'+(++seq).toString(16).padStart(8,'0').toUpperCase();
    await client.query('BEGIN');
    try{
      if(operation&&!existing)await client.query(`insert into captive_auth_operations(id,store_id,user_id,controller_key,site_id,client_mac,association_key,status,grant_seconds,created_at,completed_at,confirmed_at,authorized_until,evidence)
        values($1,$2,$3,'https://controller.test/povao','default',$4,$4,$5,2400,$6,$7,$8,$9,$10)`,[o,store,user,mac,active?'queued':status==='authorized'?'confirmed':'rejected',ago(opAge),active?null:ago(opAge),status==='authorized'?ago(opAge):null,status==='authorized'?ago(opAge-0.03):null,status==='authorized'?{found:true,authorized:true,mac}:null]);
      const op=operation?(await client.query('select client_mac,status from captive_auth_operations where id=$1',[o])).rows[0]:null;
      await client.query("select set_config('captive.auth_operation_writer',$1,true)",[o||'']);
      await client.query(`insert into captive_auth_attempts(id,resume_token_hash,client_mac,store_id,user_id,status,authorized,created_at,expires_at,auth_operation_id)
        values($1::uuid,repeat(replace($1::uuid::text,'-',''),2),$2,$3,$4,$5,$6,$7,$8,$9)`,[a,op?.client_mac||mac,store,user,active?'authorizing':status==='authorized'?'authorized':'failed',status==='authorized',ago(age),ago(age-0.01),o]);
      await client.query(`insert into captive_sessions(id,attempt_id,auth_operation_id,store_id,user_id,client_mac,status,started_at,submitted_at,authorized_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`,[s,a,o,store,user,op?.client_mac||mac,active?'submitted':status,ago(age),status==='authorized'?ago(age):null]);
      if(operation){await client.query('insert into captive_auth_operation_members(attempt_id,session_id,operation_id,user_id,joined_at) values($1,$2,$3,$4,$5)',[a,s,o,user,ago(age)]);if(!existing){await client.query("insert into captive_auth_operation_events(operation_id,event_key,created_at) values($1,'fixture',$2)",[o,ago(opAge)]);await client.query('insert into captive_auth_work_due(operation_id,due_at) values($1,$2)',[o,ago(opAge)]);}}
      await client.query('COMMIT');return {a,s,o};
    }catch(e){await client.query('ROLLBACK');throw e;}
  }
  const rpc=async({dry=false,size=100,actor=null,c=client}={})=>(await c.query('select public.captive_housekeeping($1,$2,$3) result',[dry,size,actor])).rows[0].result;
  const count=async table=>(await client.query(`select count(*)::integer n from public.${table}`)).rows[0].n;
  async function related(f){await client.query("insert into leads(store_id,session_id,name,consented_at,consent_version) values($1,$2,'Synthetic',now(),'fixture')",[store,f.s]);await client.query("insert into captive_verifications(session_id,phone,code_hash,status,created_at,expires_at) values($1,'000','fixture','verified',$2,$3)",[f.s,ago(181),ago(180)]);await client.query("insert into oauth_browser_handoffs(attempt_id,code_hash,created_at,expires_at) values($1,repeat('a',64),$2,$3)",[f.a,ago(181),ago(180)]);await client.query("insert into captive_identity_admissions(attempt_id,identity_hash,context_hash,created_at) values($1,repeat('b',64),repeat('c',64),$2)",[f.a,ago(181)]);}
  await test('service-only RPC and private helpers keep authorization guards and DML restrictions',async()=>{
    for(const role of ['anon','authenticated']){await client.query('SET ROLE '+role);await assert.rejects(()=>rpc(),e=>e.code==='42501');await assert.rejects(()=>client.query('select captive_internal.captive_housekeeping(false,100,null)'),e=>e.code==='42501');await client.query('RESET ROLE');}
    await client.query('SET ROLE service_role');assert.equal((await rpc({dry:true})).old_sessions,0);await assert.rejects(()=>client.query('delete from captive_auth_operations'),e=>e.code==='42501');await client.query('RESET ROLE');
    const f=await fixture();await assert.rejects(()=>client.query('update captive_auth_attempts set captive_session_id=null where id=$1',[f.a]),/AUTH_OPERATION_WRITE_REQUIRES_RPC/);await assert.rejects(()=>client.query('update captive_sessions set auth_operation_id=null where id=$1',[f.s]),/AUTH_OPERATION_LINK_IMMUTABLE/);
  });
  await test('failed 181d and authorized 366d graphs purge atomically with real FK and triggers',async()=>{
    const old=await fixture();await related(old);await fixture({age:366,status:'authorized'});await fixture({operation:false});const recent=await fixture({age:1});
    const before=await snapshot();const preview=await rpc({dry:true});assert.deepEqual(await snapshot(),before);const result=await rpc();assert.deepEqual(result,preview);assert.equal(result.old_sessions,3);assert.equal(result.old_auth_operations,2);assert.equal(await count('captive_identity_admissions'),0);assert.equal(await count('leads'),1);assert.equal((await client.query('select session_id from leads')).rows[0].session_id,null);assert.equal((await client.query('select id from captive_sessions')).rows[0].id,recent.s);
  });
  await test('strict 180d/365d boundaries preserve exact-boundary and inside-retention sessions',async()=>{
    const edgeFailed=await fixture({age:180}),edgeAuthorized=await fixture({age:365,status:'authorized'});const oldFailed=await fixture({age:180.001}),oldAuthorized=await fixture({age:365.001,status:'authorized'});
    const ids=(await client.query('select captive_internal.retirable_auth_operations($1) id',[reference.toISOString()])).rows.map(r=>r.id);assert.ok(!ids.includes(edgeFailed.o));assert.ok(!ids.includes(edgeAuthorized.o));assert.ok(ids.includes(oldFailed.o));assert.ok(ids.includes(oldAuthorized.o));
  });
  await test('shared operation with one recent member preserves every participant',async()=>{
    const old=await fixture();await fixture({age:1,existing:old.o});const before=await snapshot();assert.equal((await rpc()).old_sessions,0);assert.deepEqual(await snapshot(),before);
  });
  await test('active work and valid authorization receipts are never retention candidates',async()=>{
    for(const status of ['queued','sending','verifying']){const f=await fixture({age:400,active:true});await client.query('update captive_auth_operations set status=$2 where id=$1',[f.o,status]);}const valid=await fixture({age:400,status:'authorized'});await client.query("update captive_auth_operations set authorized_until=clock_timestamp()+interval '1 hour' where id=$1",[valid.o]);const before=await snapshot();assert.equal((await rpc()).old_sessions,0);assert.deepEqual(await snapshot(),before);
  });
  await test('recent telemetry and valid browser handoff preserve the associated old graph',async()=>{
    const telem=await fixture();await client.query("insert into portal_events(session_id,event_type,step) values($1,'synthetic','test')",[telem.s]);const hand=await fixture({operation:false});await client.query("insert into oauth_browser_handoffs(attempt_id,code_hash,expires_at) values($1,repeat('c',64),clock_timestamp()+interval '1 hour')",[hand.a]);const before=await snapshot();assert.equal((await rpc()).old_sessions,0);assert.deepEqual(await snapshot(),before);
  });
  await test('five-member operation drains in session batches without deleting remaining members',async()=>{
    const f=await fixture();for(let i=0;i<4;i++)await fixture({existing:f.o});assert.equal((await rpc({size:2})).old_sessions,2);assert.equal(await count('captive_sessions'),3);assert.equal(await count('captive_auth_operations'),1);assert.equal((await rpc({size:2})).old_sessions,2);assert.equal((await rpc({size:2})).old_sessions,1);assert.equal(await count('captive_auth_operations'),0);
  });
  await test('large event history drains in separate bounded batches and then removes its operation',async()=>{
    const f=await fixture();for(let i=0;i<4;i++)await client.query('insert into captive_auth_operation_events(operation_id,event_key,created_at) values($1,$2,$3)',[f.o,'extra'+i,ago(181)]);assert.equal((await rpc({size:2})).old_operation_events,2);assert.equal(await count('captive_auth_operations'),1);assert.equal((await rpc({size:2})).old_operation_events,2);assert.equal((await rpc({size:2})).old_operation_events,1);assert.equal(await count('captive_auth_operations'),0);
  });
  for(const table of ['captive_verifications','rate_limits','captive_sessions','captive_auth_attempts','captive_auth_operations','audit_logs','oauth_browser_handoffs'])await test(`injected ${table} deletion failure rolls back every table`,async()=>{
    const f=await fixture();await related(f);await client.query("insert into rate_limits(key,window_start,updated_at) values('expired',now()-interval '2 days',now()-interval '2 days')");await client.query("insert into audit_logs(entity,action,created_at) values('fixture','old',now()-interval '181 days')");const before=await snapshot();await client.query(`create function test_reject_delete() returns trigger language plpgsql as $$begin raise exception 'INJECTED_RETENTION_FAILURE'; end;$$;create trigger test_reject before delete on public.${table} for each row execute function test_reject_delete()`);await assert.rejects(()=>rpc(),/INJECTED_RETENTION_FAILURE/);assert.deepEqual(await snapshot(),before);await client.query(`drop trigger test_reject on public.${table};drop function test_reject_delete()`);
  });
  await test('admin audit insertion failure rolls back the otherwise successful purge',async()=>{
    await fixture();const before=await snapshot();await client.query("create function test_reject_audit() returns trigger language plpgsql as $$begin raise exception 'INJECTED_ADMIN_AUDIT';end;$$;create trigger test_reject before insert on audit_logs for each row execute function test_reject_audit()");await assert.rejects(()=>rpc({actor:user}),/INJECTED_ADMIN_AUDIT/);assert.deepEqual(await snapshot(),before);await client.query('drop trigger test_reject on audit_logs;drop function test_reject_audit()');const r=await rpc({actor:user});assert.equal(r.old_sessions,1);assert.equal(await count('audit_logs'),1);
  });
  await test('locked operation is skipped while an independent expired operation is cleaned',async()=>{
    const f=await fixture();await fixture();const blocker=await connect();await blocker.query('BEGIN');await blocker.query('select id from captive_auth_operations where id=$1 for update',[f.o]);try{const r=await rpc();assert.equal(r.old_sessions,1);assert.equal(await count('captive_sessions'),1);}finally{await blocker.query('ROLLBACK');}assert.equal((await rpc()).old_sessions,1);
  });
  await test('competing housekeeping pass reports busy with no mutation',async()=>{
    await fixture();const before=await snapshot(),blocker=await connect();await blocker.query('BEGIN');await blocker.query('select pg_advisory_xact_lock(726341,1)');try{await assert.rejects(()=>rpc(),/HOUSEKEEPING_BUSY/);assert.deepEqual(await snapshot(),before);}finally{await blocker.query('ROLLBACK');}
  });
  await test('blocked related lead returns bounded lock failure and rolls back the whole batch',async()=>{
    const f=await fixture();await related(f);const before=await snapshot(),blocker=await connect();await blocker.query('BEGIN');await blocker.query('select id from leads for update');const start=performance.now();try{await assert.rejects(()=>rpc(),e=>e.code==='55P03');assert.ok(performance.now()-start<3000);assert.deepEqual(await snapshot(),before);}finally{await blocker.query('ROLLBACK');}
  });
  await test('legacy stale attempts expire in bounded batches and preserve managed attempts',async()=>{
    for(let i=0;i<3;i++){const f=await fixture({age:1,operation:false});await client.query("update captive_auth_attempts set status='authorizing' where id=$1",[f.a]);await client.query("update captive_sessions set status='submitted' where id=$1",[f.s]);}await fixture({age:400,active:true});const r=await rpc({size:2});assert.equal(r.expired_auth_attempts,2);assert.equal(r.failed_stale_sessions,2);assert.equal((await client.query("select count(*)::integer n from captive_auth_attempts where auth_operation_id is not null and status='authorizing'")).rows[0].n,1);
  });
  await test('active long block and audit records inside 180d retention are preserved',async()=>{
    await client.query("insert into rate_limits(key,window_start,updated_at,blocked_until) values('active',now()-interval '2 days',now()-interval '2 days',now()+interval '1 hour'),('old',now()-interval '2 days',now()-interval '2 days',null)");await client.query("insert into audit_logs(entity,action,created_at) values('fixture','keep',now()-interval '179 days'),('fixture','old',now()-interval '181 days')");const r=await rpc();assert.equal(r.old_rate_limits,1);assert.equal(r.old_audit_logs,1);assert.equal((await client.query('select key from rate_limits')).rows[0].key,'active');
  });
  await test('abandoned attempts and admission receipts use the shared bounded retention budget',async()=>{
    for(let i=0;i<3;i++){const a=randomUUID();await client.query("insert into captive_auth_attempts(id,resume_token_hash,client_mac,status,created_at,expires_at) values($1::uuid,repeat(replace($1::uuid::text,'-',''),2),'02AA0000FFFF','created',$2,$3)",[a,ago(181),ago(180)]);await client.query("insert into captive_identity_admissions(attempt_id,identity_hash,context_hash,created_at) values($1,repeat('a',64),repeat('b',64),$2)",[a,ago(181)]);}
    const before=await snapshot(),preview=await rpc({dry:true,size:2});assert.deepEqual(await snapshot(),before);assert.equal(preview.old_auth_attempts,2);assert.deepEqual(await rpc({size:2}),preview);assert.equal(await count('captive_identity_admissions'),1);assert.equal((await rpc({size:2})).old_auth_attempts,1);assert.equal(await count('captive_identity_admissions'),0);
  });
  await test('orphan cleanup preserves valid capability, lease, recent attempt and authorized 181d history',async()=>{
    for(const mode of ['valid','lease','recent','authorized']){const a=randomUUID();await client.query("insert into captive_auth_attempts(id,resume_token_hash,client_mac,status,created_at,expires_at,lease_owner,lease_expires_at) values($1::uuid,repeat(replace($1::uuid::text,'-',''),2),'02AA0000FFFF',$2,$3,$4,$5,$6)",[a,mode==='authorized'?'authorized':'created',ago(mode==='recent'?1:181),mode==='valid'?ago(-1):ago(mode==='recent'?0.5:180),mode==='lease'?'synthetic':null,mode==='lease'?ago(-1):null]);}const before=await snapshot();assert.equal((await rpc()).old_auth_attempts,0);assert.deepEqual(await snapshot(),before);
  });
  await test('inconsistent durable membership is preserved without detaching or changing identity',async()=>{
    const f=await fixture();await client.query('delete from captive_auth_operation_members where attempt_id=$1',[f.a]);const before=await snapshot();assert.equal((await rpc()).old_sessions,0);assert.deepEqual(await snapshot(),before);
  });
  await test('legacy attempt with a missing back-link is cleaned using its session forward-link',async()=>{
    const f=await fixture({operation:false});await client.query('update captive_auth_attempts set captive_session_id=null where id=$1',[f.a]);assert.equal((await rpc()).old_auth_attempts,1);assert.equal(await count('captive_sessions'),0);assert.equal(await count('captive_auth_attempts'),0);
  });
  await test('legacy conflicting statuses preserve the longer authorized-attempt retention',async()=>{
    for(const evidence of ['status','boolean']){const f=await fixture({operation:false});await client.query("update captive_auth_attempts set status=$2,authorized=$3 where id=$1",[f.a,evidence==='status'?'authorized':'failed',evidence==='boolean']);}const before=await snapshot();assert.equal((await rpc()).old_sessions,0);assert.deepEqual(await snapshot(),before);
  });
  await test('orphan with authorized flag and legacy failed status also retains 365 days',async()=>{
    const a=randomUUID();await client.query("insert into captive_auth_attempts(id,resume_token_hash,client_mac,status,authorized,created_at,expires_at) values($1::uuid,repeat(replace($1::uuid::text,'-',''),2),'02AA0000FFFE','failed',true,$2,$3)",[a,ago(181),ago(180)]);assert.equal((await rpc()).old_auth_attempts,0);assert.equal(await count('captive_auth_attempts'),1);
  });
  await test('preview does not count attempts selected for deletion again as stale expiration',async()=>{
    const f=await fixture({operation:false});await client.query("update captive_auth_attempts set status='authorizing' where id=$1",[f.a]);await client.query("update captive_sessions set status='submitted' where id=$1",[f.s]);const a=randomUUID();await client.query("insert into captive_auth_attempts(id,resume_token_hash,client_mac,status,created_at,expires_at) values($1::uuid,repeat(replace($1::uuid::text,'-',''),2),'02AA0000FFFE','authorizing',$2,$3)",[a,ago(181),ago(180)]);const preview=await rpc({dry:true});assert.equal(preview.old_auth_attempts,2);assert.equal(preview.expired_auth_attempts,0);assert.deepEqual(await rpc(),preview);
  });
  const requireRoot=createRequire(path.join(root,'package.json')),ts=requireRoot('typescript');
  const source=await readFile(path.join(root,'supabase/functions/captive-portal/index.ts'),'utf8'),tree=ts.createSourceFile('edge.ts',source,ts.ScriptTarget.Latest,true);
  const wanted=new Set(['internalHousekeeping','previewHousekeeping','handleHousekeeping','handleCronHousekeeping']);
  const selected=tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&wanted.has(n.name?.text));assert.equal(selected.length,4);
  const compiled=ts.transpileModule(selected.map(n=>n.getText(tree)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  function handlerHarness(result){const calls=[],info=[],errors=[];const db={rpc:async(name,args)=>{calls.push({name,args});return typeof result==='function'?await result():result;}};const context=vm.createContext({Response,Date,Error,Number,Object,Array,String,CRON_SECRET:'synthetic',supabaseAdmin:()=>db,requireAdmin:async()=>({db,userId:user}),safeParseJson:r=>r.json(),Logger:{info:m=>info.push(m),error:m=>errors.push(m)},jsonResponse:(body,status=200)=>Response.json(body,{status}),errorResponse:(error,status=400)=>Response.json({error},{status})});vm.runInContext(compiled,context);return {calls,info,errors,cron:()=>context.handleCronHousekeeping(new Request('http://127.0.0.1/cron',{headers:{Authorization:'Bearer synthetic'}})),admin:(dry_run=false)=>context.handleHousekeeping(new Request('http://127.0.0.1/admin',{method:'POST',body:JSON.stringify({dry_run,confirmation:'EXCLUIR DADOS EXPIRADOS'})}))};}
  const healthy=Object.fromEntries(['expired_verifications','old_rate_limits','old_sessions','old_auth_attempts','old_auth_operations','old_operation_events','old_audit_logs','expired_oauth_handoffs','expired_auth_attempts','failed_stale_sessions'].map(k=>[k,1]));
  for(const scenario of [{error:{message:'23503 injected'},data:null},{error:null,data:null},{error:null,data:{...healthy,old_sessions:-1}}])await test('admin, preview and cron reject database failure or invalid count payload '+JSON.stringify(scenario.error||scenario.data),async()=>{for(const action of ['cron','admin','preview']){const h=handlerHarness(scenario),response=action==='preview'?await h.admin(true):await h[action]();assert.equal(response.status,503);assert.equal((await response.json()).ok,false);assert.equal(h.info.length,0);assert.equal(h.errors.length,1);}});
  await test('healthy admin and cron use the single atomic RPC and report its counts',async()=>{for(const action of ['cron','admin','preview']){const h=handlerHarness({error:null,data:healthy}),response=action==='preview'?await h.admin(true):await h[action]();assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.cleaned||body.would_remove,healthy);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'captive_housekeeping');assert.equal(h.calls[0].args.p_dry_run,action==='preview');assert.equal(h.calls[0].args.p_actor_user_id,action==='admin'?user:null);}});
  await test('lost response after committed purge reports uncertainty without success or automatic retry',async()=>{await fixture();const h=handlerHarness(async()=>{await rpc({actor:user});throw new Error('Synthetic connection lost after commit');});const response=await h.admin();assert.equal(response.status,503);assert.equal((await response.json()).ok,false);assert.equal(h.calls.length,1);assert.equal(h.info.length,0);assert.equal(await count('captive_sessions'),0);assert.equal(await count('audit_logs'),1);});
  await writeFile(path.join(out,'results.json'),JSON.stringify({postgres:(await client.query('select version()')).rows[0].version,passed,finishedAt:new Date().toISOString()},null,2)+'\n');
  console.log(`${passed.length} retention/handler tests passed`);
}catch(e){console.error(e);process.exitCode=1;}
finally{for(const c of clients)await c.end().catch(()=>{});if(alive()){try{if(await ownedPid())run('pg_ctl.exe',['-D',data,'stop','-m','fast','-w']);else if(alive())server.kill();}catch(e){console.error('Owned cluster cleanup failed',e);process.exitCode=1;if(alive())server.kill();}}await writeFile(path.join(out,'server-last.log'),logs);}
