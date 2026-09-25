import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

// Execute the actual /ready branch. Only database results and time are mocked.
const source=fs.readFileSync(new URL("../captive-portal/index.ts",import.meta.url),"utf8");
const tree=ts.createSourceFile("edge.ts",source,ts.ScriptTarget.Latest,true);
const blocks:ts.Statement[]=[];
function visit(node:ts.Node) {
  if(ts.isIfStatement(node)&&node.expression.getText(tree)==='path === "/ready"') blocks.push(node.thenStatement);
  ts.forEachChild(node,visit);
}
visit(tree);
if(blocks.length!==1) throw Error("Readiness extraction incomplete");
const compiled=ts.transpileModule(`async function readiness() ${blocks[0].getText(tree)}`,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
}).outputText;
const origin=Date.parse("2026-09-25T12:00:00Z");
type Worker={enabled:boolean;sends_enabled:boolean;last_tick_at:string;last_dispatch_at:string|null;
  last_worker_finished_at:string|null;last_worker_failed_count:number|null;last_error_code:string|null};
const healthy=():Worker=>({enabled:true,sends_enabled:true,last_tick_at:new Date(Date.now()-1000).toISOString(),
  last_dispatch_at:null,last_worker_finished_at:null,last_worker_failed_count:null,last_error_code:null});
async function readiness(worker:Worker,active=0,overdue=0,recovery=0){
  const db={from(table:string){
    let overdueQuery=false;
    const query={
      select(){return query;},eq(){return query;},in(){return query;},or(){overdueQuery=true;return query;},
      result(){return {error:null,data:table==="global_settings"?{id:1}:table==="stores"?
        [{slug:"povao",unifi_controller_url:"https://controller.invalid/povao",unifi_site_id:"default"}]:
        table==="captive_auth_worker_config"?worker:null,
        count:table==="captive_auth_operations"?(overdueQuery?overdue:active):table==="captive_auth_recovery_failures"?recovery:null};},
      maybeSingle(){return Promise.resolve(query.result());},
      then(resolve:(v:ReturnType<typeof query.result>)=>unknown){return Promise.resolve(query.result()).then(resolve);},
    };return query;
  }};
  const context=vm.createContext({Date,Promise,Response,supabaseAdmin:()=>db,
    canonicalUnifiControllerUrl:()=>"https://controller.invalid/povao",UNIFI_USERNAME:"test",UNIFI_PASSWORD:"test",CRON_SECRET:"test",
    jsonResponse:(body:unknown,status=200)=>new Response(JSON.stringify(body),{status}),
  });
  vm.runInContext(compiled,context);
  return await context.readiness() as Response;
}
afterEach(()=>vi.useRealTimers());
describe("second audit: readiness detects failed recovery",()=>{
  it("allows a healthy idle worker without requiring artificial client traffic",async()=>{
    vi.useFakeTimers();vi.setSystemTime(origin);
    expect((await readiness(healthy())).status).toBe(200);
  });
  it("allows a newly dispatched worker time to start",async()=>{
    vi.useFakeTimers();vi.setSystemTime(origin);
    const worker={...healthy(),last_dispatch_at:new Date(origin-1000).toISOString()};
    expect((await readiness(worker,1)).status).toBe(200);
  });
  it("reports a stopped cron before authorization work exceeds its deadline",async()=>{
    vi.useFakeTimers();vi.setSystemTime(origin);
    expect((await readiness({...healthy(),last_tick_at:new Date(origin-36_000).toISOString()},1)).status).toBe(503);
  });
  it("reports isolated recovery diagnostics even after healthy work finishes",async()=>{
    vi.useFakeTimers();vi.setSystemTime(origin);
    expect((await readiness(healthy(),0,0,1)).status).toBe(503);
  });
  it("does not hide a worker that never acknowledges work when every cron dispatch replaces last_dispatch_at",async()=>{
    vi.useFakeTimers();vi.setSystemTime(origin);
    let response:Response|undefined;
    // One queued operation stays active for 90s (below its 110s expiry and
    // readiness's 120s overdue threshold). pg_net accepts every dispatch, but
    // the endpoint never completes, e.g. requests return 401/503 externally.
    // This is not a claim that the hosted worker is currently failing.
    for(let elapsed=10_000;elapsed<=90_000;elapsed+=10_000){
      vi.setSystemTime(origin+elapsed);
      response=await readiness({...healthy(),last_dispatch_at:new Date(Date.now()-1000).toISOString()},1);
    }
    const body=await response!.json();
    expect(response!.status,JSON.stringify({elapsed:90_000,...body})).toBe(503);
  });
});
