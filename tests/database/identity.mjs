// Isolated real PostgreSQL. No remote URL accepted. Verify child PID and data
// directory before any writes; retain evidence and stop only our own process.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import { isValidCPF, isValidBrazilianPhone, normalizeBrazilianPhone } from '../../supabase/functions/_shared/identity.ts';
const dir=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(dir,'../..');
const out=path.join(root,'tmp/identity-fixes-20261013/database');await mkdir(out,{recursive:true});
const data=await mkdtemp(path.join(out,'pg-')),expectedData=await realpath(data);
const bin=path.join(dir,'node_modules/@embedded-postgres/windows-x64/native/bin');
const options={host:'127.0.0.1',port:55479,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};
const same=(a,b)=>path.resolve(a).replaceAll('\\','/').toLowerCase()===path.resolve(b).replaceAll('\\','/').toLowerCase();
const run=(exe,args)=>{const r=spawnSync(path.join(bin,exe),args,{windowsHide:true,encoding:'utf8'});if(r.error)throw r.error;if(r.status!==0)throw Error(r.stderr||r.stdout);};
let server,client,logs='';const clients=[],passed=[];
const alive=()=>server?.pid&&server.exitCode===null&&server.signalCode===null;
async function owned(){const p=(await readFile(path.join(data,'postmaster.pid'),'utf8')).split(/\r?\n/);return Number(p[0])===server.pid&&same(await realpath(p[1]),expectedData);}
async function connect(){const c=new pg.Client(options);await c.connect();if(!same(await realpath((await c.query('show data_directory')).rows[0].data_directory),expectedData)||!alive()||!await owned()){await c.end();throw Error('CLUSTER_MISMATCH');}clients.push(c);return c;}
async function test(name,fn){await fn();passed.push(name);console.log('PASS '+name);}
const validCPF='52998224725',phone='38987654321';
async function profile(cpf=null,tel=null){const id=randomUUID();await client.query('insert into profiles(id,cpf_digits,phone_digits) values($1,$2,$3)',[id,cpf,tel]);return id;}
async function repair(id,cpf=validCPF,tel=phone,c=client){return (await c.query('select repair_captive_identity($1,$2,$3) result',[id,cpf,tel])).rows[0].result;}
try{
 assert.equal(process.platform,'win32');assert.equal(options.host,'127.0.0.1');
 run('initdb.exe',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C']);
 server=spawn(path.join(bin,'postgres.exe'),['-D',data,'-h',options.host,'-p',String(options.port)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
 await new Promise((resolve,reject)=>{server.once('spawn',resolve);server.once('error',reject);});
 for(let i=0;i<60;i++){if(!alive())throw Error('Postgres stopped');try{client=await connect();break;}catch(e){if(e.message==='CLUSTER_MISMATCH')throw e;await new Promise(r=>setTimeout(r,100));}}
 assert.ok(client);
 await client.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA private;
 CREATE TABLE profiles(id uuid PRIMARY KEY,cpf_digits text UNIQUE,phone_digits text,cpf_required boolean DEFAULT true,full_name text);
 CREATE TABLE leads(id uuid PRIMARY KEY,cpf text,phone text,name text);
 CREATE TABLE user_roles(user_id uuid REFERENCES profiles(id),role text);
 GRANT ALL ON profiles,leads,user_roles TO service_role;`);
 const legacy=await profile('12345678900','abc38999999999');
 await client.query('insert into leads values($1,$2,$3,$4)',[legacy,'12345678900','bad','Legacy']);
 await client.query(await readFile(path.join(root,'supabase/migrations/20261013113423_enforce_portal_identity_integrity.sql'),'utf8'));
 const oldPlaceholder=await profile(null,'38999999999');
 await client.query('insert into leads(id,phone,name) values($1,$2,$3)',[oldPlaceholder,'38999999999','Historical']);
 await client.query(await readFile(path.join(root,'supabase/migrations/20261013154212_reject_placeholder_phones.sql'),'utf8'));
 const oldSequence=await profile(null,'38912345678');
 await client.query(await readFile(path.join(root,'supabase/migrations/20261014141322_reject_sequential_phone.sql'),'utf8'));
 await test('sequence policy preserves history and permits authenticated repair',async()=>{
  await client.query("update profiles set full_name='Sequence history' where id=$1",[oldSequence]);
  assert.equal((await client.query('select phone_digits from profiles where id=$1',[oldSequence])).rows[0].phone_digits,'38912345678');
  await client.query('begin');
  assert.equal((await repair(oldSequence,'01234567890')).ok,true);
  assert.equal((await client.query('select phone_digits from profiles where id=$1',[oldSequence])).rows[0].phone_digits,phone);
  await client.query('rollback');
 });
 await test('new policy preserves historical placeholders and unrelated updates',async()=>{
  await client.query("update profiles set full_name='Historical updated' where id=$1",[oldPlaceholder]);
  await client.query("update leads set name='Historical updated' where id=$1",[oldPlaceholder]);
  assert.equal((await client.query('select phone_digits from profiles where id=$1',[oldPlaceholder])).rows[0].phone_digits,'38999999999');
 });
 await test('owner repair can replace a newly disallowed historical placeholder',async()=>{
  await client.query('begin');
  assert.equal((await repair(oldPlaceholder,'01234567890')).ok,true);
  assert.equal((await client.query('select phone_digits from profiles where id=$1',[oldPlaceholder])).rows[0].phone_digits,phone);
  await client.query('rollback');
 });
 await test('migration preserves invalid legacy rows without rewriting or deleting',async()=>{assert.equal((await client.query('select cpf_digits from profiles where id=$1',[legacy])).rows[0].cpf_digits,'12345678900');});
 await test('unrelated updates of invalid historical fields still succeed',async()=>{await client.query("update profiles set full_name='Updated' where id=$1",[legacy]);await client.query("update leads set name='Updated' where id=$1",[legacy]);});
 for(const table of ['profiles','leads']){
  const cpfCol=table==='profiles'?'cpf_digits':'cpf',telCol=table==='profiles'?'phone_digits':'phone';
  for(const operation of ['insert','update']) await test(`${table}: ${operation} of placeholder telephone rejected`,async()=>{
   for(const x of ['38999999999','+55 (38) 90000-0000','38911111111','3833333333','38912345678','+55 (55) 91234-5678']){
    const sql=operation==='insert'?`insert into ${table}(id,${telCol}) values($1,$2)`:`update ${table} set ${telCol}=$2 where id=$1`;
    await assert.rejects(client.query(sql,[operation==='insert'?randomUUID():legacy,x]),{code:'23514'});
   }
  });
  await test(`${table}: invalid new CPF rejected`,()=>assert.rejects(client.query(`insert into ${table}(id,${cpfCol}) values($1,'12345678900')`,[randomUUID()]),{code:'23514'}));
  await test(`${table}: invalid changed CPF rejected atomically`,()=>assert.rejects(client.query(`update ${table} set ${cpfCol}='11111111111' where id=$1`,[legacy]),{code:'23514'}));
  await test(`${table}: letters and foreign/oversized telephone rejected`,async()=>{for(const x of ['abc38987654321','+91 98765-4321','(55) 98765-432100'])await assert.rejects(client.query(`insert into ${table}(id,${telCol}) values($1,$2)`,[randomUUID(),x]),{code:'23514'});});
  await test(`${table}: formatted identity canonicalized without truncation`,async()=>{const id=randomUUID();await client.query(`insert into ${table}(id,${cpfCol},${telCol}) values($1,'529.982.247-25','+55 (55) 98765-4321')`,[id]);const row=(await client.query(`select ${cpfCol} cpf,${telCol} phone from ${table} where id=$1`,[id])).rows[0];assert.deepEqual(row,{cpf:validCPF,phone:'55987654321'});await client.query(`delete from ${table} where id=$1`,[id]);});
 }
 await test('SQL/JavaScript CPF parity for 10,000 candidates plus malformed/NULL cases',async()=>{
  const values=Array.from({length:10000},(_,i)=>String(10000000000+i));values.push(null,'12345678909','01234567890','529.982.247-25','abc52998224725','00000000000');
  const rows=(await client.query('select value,coalesce(private.portal_cpf_valid(value),false) valid from unnest($1::text[]) value',[values])).rows;
  for(const row of rows)assert.equal(row.valid,isValidCPF(row.value),String(row.value));
 });
 await test('SQL/JavaScript phone parity preserves every DDD including 55',async()=>{
  const values=[null,'abc38987654321','+91 98765-4321','(55) 98765-432100','38999999999'];
  for(let d=0;d<=99;d++)for(const sub of ['987654321','23456789','56789012','876543210','999999998','912345678','912345679','912345677',...Array.from({length:10},(_,n)=>String(n).repeat(8)),...Array.from({length:10},(_,n)=>'9'+String(n).repeat(8))])for(const format of [`${d}${sub}`,`+55 (${d}) ${sub}`,`(${d}) ${sub}`])values.push(format);
  for(const r of (await client.query('select value,coalesce(private.portal_phone_valid(value),false) valid,private.portal_phone_normalize(value) normalized from unnest($1::text[]) value',[values])).rows){assert.equal(r.valid,isValidBrazilianPhone(r.value),String(r.value));if(r.value!==null)assert.equal(r.normalized,normalizeBrazilianPhone(r.value),r.value);}
 });
 await test('legacy invalid profile can be repaired by service without replacing the account',async()=>{assert.equal((await repair(legacy)).ok,true);assert.equal((await client.query('select cpf_required from profiles where id=$1',[legacy])).rows[0].cpf_required,false);});
 await test('repair retry is idempotent',async()=>assert.equal((await repair(legacy)).ok,true));
 await test('repair cannot replace valid CPF or valid phone',async()=>{assert.equal((await repair(legacy,'12345678909')).ok,false);assert.equal((await repair(legacy,validCPF,'31987654321')).ok,false);});
 await test('conflicting CPF does not partially modify a profile',async()=>{const id=await profile();assert.equal((await repair(id)).code,'IDENTITY_CONFLICT');assert.equal((await client.query('select cpf_digits from profiles where id=$1',[id])).rows[0].cpf_digits,null);});
 await test('new incomplete OAuth profiles remain representable',async()=>{await profile();});
 await test('service-only RPC refuses NULL/invalid identity and privileged account',async()=>{const id=await profile();await client.query("insert into user_roles values($1,'admin')",[id]);assert.equal((await repair(id,null)).code,'INVALID_IDENTITY');assert.equal((await repair(id,'12345678909')).code,'PRIVILEGED_ACCOUNT');});
 await test('anonymous/authenticated roles cannot execute repair or private helpers',async()=>{for(const role of ['anon','authenticated']){await client.query('begin');await client.query('set local role '+role);await assert.rejects(repair(legacy),{code:'42501'});await client.query('rollback');assert.equal((await client.query("select has_function_privilege($1,'private.portal_cpf_valid(text)','execute') allowed",[role])).rows[0].allowed,false);}});
 await test('service role has sufficient permissions for validation triggers and repairs',async()=>{const id=await profile(null,phone);await client.query('begin');await client.query('set local role service_role');assert.equal((await repair(id,'01234567890')).ok,true);await client.query('rollback');});
 await test('concurrent different repairs have one winner and cannot overwrite valid identity',async()=>{const id=await profile();const a=await connect(),b=await connect();const results=await Promise.all([repair(id,'12345678909',phone,a),repair(id,'01234567890',phone,b)]);assert.equal(results.filter(r=>r.ok).length,1);});
 await writeFile(path.join(out,'results.json'),JSON.stringify({passed,postgres:(await client.query('select version()')).rows[0].version,finishedAt:new Date().toISOString()},null,2));
 console.log(`${passed.length} identity database tests passed`);
}catch(e){console.error(e);process.exitCode=1;}
finally{for(const c of clients)await c.end().catch(()=>{});if(alive()&&await owned())run('pg_ctl.exe',['-D',data,'stop','-m','fast','-w']);await writeFile(path.join(out,'postgres.log'),logs);}
