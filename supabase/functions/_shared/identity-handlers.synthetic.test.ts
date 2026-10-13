import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { normalizeCPF, normalizeBrazilianPhone, isValidCPF, isValidBrazilianPhone, needsPhoneConfirmation, storedPhoneMatches } from "./identity.ts";
const source=fs.readFileSync(new URL("../captive-portal/index.ts",import.meta.url),"utf8");
const tree=ts.createSourceFile("edge.ts",source,ts.ScriptTarget.Latest,true);
const wanted=new Set(["handleIdentity","repairIncompleteIdentity","handleAuthorizeExisting","authorizeAuthenticatedUser"]);
const selected=tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&wanted.has(n.name?.text||""));
if(selected.length!==wanted.size)throw Error("Incomplete extraction");
const compiled=ts.transpileModule(selected.map(n=>n.getText(tree)).join("\n"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;

function harness({provider="email",cpf="52998224725",phone="38987654321",admitted=false,lookupError=false,authError=false,admin=false,blocked=false}:any={}){
 const profile={id:"owner",full_name:"Synthetic",cpf_digits:cpf,phone_digits:phone,email:"test@example.invalid"};
 const rpc=vi.fn(async(name:string)=>name==="repair_captive_identity"?{data:{ok:true},error:null}:{data:{allowed:false,blocked_until:"future"},error:null});
 const updates=vi.fn();
 const db={rpc,from(table:string){const chain:any={select:()=>chain,eq:()=>chain,update:()=>{updates();return chain;},maybeSingle:async()=>({data:table==="profiles"?profile:admin?{user_id:"owner"}:null,error:lookupError?{code:"UNAVAILABLE"}:null})};return chain;}};
 const auth=vi.fn(async()=>({data:{user:authError?null:{id:"owner",email:"test@example.invalid",app_metadata:{provider}}},error:authError?{}:null}));
 const authorize=vi.fn(async()=>({authorized:false,processing:true,status:"queued",operation_id:"mock"}));
 const replay=vi.fn(async()=>Response.json({authorized:true,status:"confirmed"}));
 const deadline=vi.fn(async(f:()=>Promise<any>)=>f());
 const context=vm.createContext({Request,Response,Date,normalizeCPF,normalizeBrazilianPhone,needsPhoneConfirmation,storedPhoneMatches,
  Validators:{cpf:isValidCPF,phone:isValidBrazilianPhone},supabaseAdmin:()=>db,getPublicIp:()=>null,getTraceId:()=>"synthetic",safeParseJson:(r:Request)=>r.json(),
  getValidatedAuthContext:async()=>({ctx:{clientMac:"020000000001"},attemptId:"attempt",resumeToken:"capability"}),
  validateAuthAttempt:async()=>({status:"active",attempt:{user_id:null,auth_operation_id:admitted?"operation":null}}),
  readOperation:async()=>admitted?{operation_id:"operation"}:{},handleAttemptStatus:replay,
  createClient:()=>({auth:{getUser:auth}}),SUPABASE_URL:"https://example.invalid",SUPABASE_ANON_KEY:"not-a-key",
  getActiveUserBlock:async()=>blocked?{}:null,checkRateLimitDb:async()=>({allowed:true}),logEvent:()=>{},Logger:{error(){},warn(){},info(){}},
  withOperationDeadline:deadline,sha256Hex:async()=>"hash",rateLimitedResponse:()=>Response.json({code:"rate_limited"},{status:429}),
  detectStoreFromRequest:async()=>({store_slug:"povao",store_id:"store"}),authorizeDurably:authorize,DEFAULT_REDIRECT_URL:"https://example.invalid",
  jsonResponse:(b:any,s=200)=>Response.json(b,{status:s}),errorResponse:(error:string,s=400)=>Response.json({error},{status:s}),
 });vm.runInContext(compiled,context);
 const request=(body:any)=>new Request("https://example.invalid/test",{method:"POST",body:JSON.stringify(body)});
 return {rpc,auth,authorize,replay,updates,deadline,
  identify:(body:any)=>context.handleIdentity(request(body)) as Promise<Response>,
  existing:()=>context.handleAuthorizeExisting(request({access_token:"synthetic-owner-session-no-authority"})) as Promise<Response>,
  repair:(body:any)=>context.repairIncompleteIdentity(db,body,"52998224725","38987654321") as Promise<Response|null>,
 };
}
describe("published ingress identity barriers and legacy recovery",()=>{
 it.each(["email","apple","google"])("%s valid profile reaches authorization once",async provider=>{const h=harness({provider});expect((await h.existing()).status).toBe(200);expect(h.authorize).toHaveBeenCalledTimes(1);});
 for(const provider of ["email","apple","google"])it.each([
  {cpf:null},{cpf:"12345678900"},{phone:null},{phone:"abc38987654321"},
 ])(`${provider}: incomplete/invalid profile returns to identification`,async fields=>{const h=harness({provider,...fields});const r=await h.existing();expect(await r.json()).toMatchObject({authorized:false,status:"awaiting_identity",needs_login:true});expect(h.authorize).not.toHaveBeenCalled();expect(h.updates).not.toHaveBeenCalled();});
 it.each(["email","apple","google"])("%s admitted operation is recovered despite historical invalid profile",async provider=>{const h=harness({provider,admitted:true,cpf:null,phone:null});expect(await(await h.existing()).json()).toMatchObject({authorized:true});expect(h.replay).toHaveBeenCalledOnce();expect(h.authorize).not.toHaveBeenCalled();});
 it("profile outage never creates a new account or authorizes",async()=>{const h=harness({lookupError:true});expect((await h.existing()).status).toBe(503);expect(h.authorize).not.toHaveBeenCalled();});
 it.each([
  [{cpf:"12345678900",phone:"38987654321"},"invalid_cpf"],
  [{cpf:"abc52998224725",phone:"38987654321"},"invalid_cpf"],
  [{cpf:"52998224725",phone:"abc38987654321"},"invalid_phone"],
  [{cpf:"52998224725",phone:"38999999999"},"phone_confirmation_required"],
  [{cpf:"52998224725",phone:"38999999999",phone_confirmation:"31999999999"},"phone_confirmation_required"],
 ])("malformed/unconfirmed identity is rejected before admission",async(body,code)=>{const h=harness();const r=await h.identify(body);expect(r.status).toBe(400);expect((await r.json()).code).toBe(code);expect(h.rpc).not.toHaveBeenCalled();});
 it("explicitly confirmed repeated telephone passes validation without claiming ownership",async()=>{const h=harness();const r=await h.identify({cpf:"52998224725",phone:"38999999999",phone_confirmation:"+55 (38) 99999-9999"});expect(r.status).toBe(429);expect(h.rpc).toHaveBeenCalledWith("admit_captive_identity",expect.anything());});
 it("replayed identify does not revalidate identity or charge admission",async()=>{const h=harness({admitted:true});expect(await(await h.identify({cpf:"invalid",phone:"invalid"})).json()).toMatchObject({authorized:true});expect(h.rpc).not.toHaveBeenCalled();});
 it("repair never trusts a user id without an authenticated session",async()=>{const h=harness({cpf:null});expect(await h.repair({user_id:"owner"})).toBeNull();expect(h.rpc).not.toHaveBeenCalled();expect(h.auth).not.toHaveBeenCalled();});
 it("expired session cannot repair a profile but normal identification remains available",async()=>{const h=harness({authError:true,cpf:null});expect(await h.repair({access_token:"synthetic-expired-session-token"})).toBeNull();expect(h.rpc).not.toHaveBeenCalled();});
 it.each(["network rejection","deadline timeout"])("optional Auth %s skips repair safely",async failure=>{
  const h=harness({cpf:null});
  if(failure==="network rejection")h.auth.mockRejectedValueOnce(new Error("Network unavailable"));
  else h.deadline.mockRejectedValueOnce(new Error("IDENTITY_SESSION_LOOKUP_TIMEOUT"));
  expect(await h.repair({access_token:"synthetic-owner-session-token"})).toBeNull();
  expect(h.rpc).not.toHaveBeenCalled();expect(h.updates).not.toHaveBeenCalled();
 });
 it("identify still uses normal resolution after optional Auth timeout",async()=>{
  const h=harness();h.deadline.mockRejectedValueOnce(new Error("IDENTITY_SESSION_LOOKUP_TIMEOUT"));
  h.rpc.mockResolvedValueOnce({data:{allowed:true},error:null});
  h.rpc.mockResolvedValueOnce({data:[{resolution_status:"ambiguous"}],error:null} as any);
  const r=await h.identify({cpf:"52998224725",phone:"38987654321",access_token:"synthetic-owner-session-token"});
  expect(r.status).toBe(409);expect((await r.json()).code).toBe("identity_ambiguous");
  expect(h.rpc).toHaveBeenNthCalledWith(2,"resolve_portal_identity",{p_cpf_digits:"52998224725",p_phone_digits:"38987654321"});
  expect(h.rpc).toHaveBeenCalledTimes(2);expect(h.updates).not.toHaveBeenCalled();
 });
 it("verified owner can complete a missing field",async()=>{const h=harness({cpf:null});expect(await h.repair({access_token:"synthetic-owner-session-token"})).toBeNull();expect(h.rpc).toHaveBeenCalledWith("repair_captive_identity",{p_user_id:"owner",p_cpf:"52998224725",p_phone:"38987654321"});});
 it.each([{cpf:"12345678909",phone:null},{cpf:null,phone:"31987654321"}])("repair cannot overwrite a valid identifier on a shared browser",async fields=>{const h=harness(fields);expect(await h.repair({access_token:"synthetic-owner-session-token"})).toBeNull();expect(h.rpc).not.toHaveBeenCalled();});
 it.each([{admin:true},{blocked:true}])("privileged/blocked owner cannot use repair",async state=>{const h=harness({cpf:null,...state});expect((await h.repair({access_token:"synthetic-owner-session-token"}))?.status).toBe(403);expect(h.rpc).not.toHaveBeenCalled();});
});
