import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { durableAuthStorage } from "../electron/auth-storage.js";
import { SupabaseTransport } from "../src/core/supabase-transport.js";

test("auth storage recovers interrupted writes and never treats corruption as a new installation",()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),"fb-auth-test-"));
 try{const store=durableAuthStorage(dir),file=path.join(dir,"supabase-auth.json");
 store.setItem("session","rotated-token");writeFileSync(file,"{");
 assert.equal(store.getItem("session"),"rotated-token");
 store.setItem("session","new-token");assert.equal(JSON.parse(readFileSync(file,"utf8")).session,"new-token");
 writeFileSync(file,"{");writeFileSync(`${file}.recovery`,"{");assert.throws(()=>store.getItem("session"),/не сброшены/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

function fake(preserve=true){
 const transport=new SupabaseTransport("https://example.test","test","secret",undefined,preserve);
 let created=0,rpc=0,refreshes=0;
 const auth={getSession:async()=>({data:{session:null as any},error:null as any}),getUser:async()=>({data:{user:null as any},error:{name:"AuthSessionMissingError"} as any}),refreshSession:async()=>{refreshes++;return {data:{session:null as any,user:null as any},error:null as any}},signInAnonymously:async()=>{created++;return {data:{user:{id:"new"}},error:null}}};
 (transport as any).client={auth,rpc:async()=>{rpc++;return {data:[{id:"pair",owner_id:"old",partner_id:"peer"}],error:null}}};
 return{transport,auth,counts:()=>({created,rpc,refreshes})};
}
test("paired clients never replace missing or temporarily unavailable identity",async()=>{
 const f=fake();await assert.rejects(f.transport.identity(),/новая учётная запись не создаётся/);
 f.auth.getSession=async()=>({data:{session:{user:{id:"old"}}},error:null});
 f.auth.getUser=async()=>({data:{user:null},error:{name:"AuthRetryableFetchError"}});
 (f.auth as any).refreshSession=async()=>({data:{session:null,user:null},error:{name:"AuthRetryableFetchError"}});
 await assert.rejects(f.transport.identity());assert.equal(f.counts().created,0);
});
test("an empty updater-time auth snapshot reloads the exact durable session",async()=>{
 const key="sb-example-auth-token",saved=JSON.stringify({access_token:"access",refresh_token:"refresh"});
 const storage={getItem:async(k:string)=>k===key?saved:null,setItem:async()=>{},removeItem:async()=>{}};
 const transport=new SupabaseTransport("https://example.test","test","secret",storage,true);
 let installed=false;
 (transport as any).client.auth={getSession:async()=>({data:{session:installed?{user:{id:"old"}}:null},error:null}),getUser:async()=>({data:{user:installed?{id:"old"}:null},error:installed?null:{name:"AuthSessionMissingError"}}),setSession:async(input:any)=>{assert.deepEqual(input,{access_token:"access",refresh_token:"refresh"});installed=true;return{data:{session:{user:{id:"old"}}},error:null}},refreshSession:async()=>({data:{session:null,user:null},error:null}),signInAnonymously:async()=>assert.fail("must not create identity")};
 assert.equal(await transport.identity(),"old");
});
test("expired persisted access token refreshes the same identity and coalesces concurrent recovery",async()=>{
 const f=fake();let refreshes=0;
 f.auth.getSession=async()=>({data:{session:{user:{id:"old"}}},error:null});
 f.auth.getUser=async()=>({data:{user:null},error:{name:"AuthApiError"}});
 (f.auth as any).refreshSession=async()=>{refreshes++;await new Promise(r=>setTimeout(r,5));return {data:{session:{user:{id:"old"}},user:{id:"old"}},error:null};};
 assert.deepEqual(await Promise.all([f.transport.identity(),f.transport.identity(),f.transport.identity()]),["old","old","old"]);
 assert.equal(refreshes,1);
 assert.equal(f.counts().created,0);
});
test("fresh installation may create identity, but a network failure may not",async()=>{
 const f=fake(false);assert.equal(await f.transport.identity(),"new");
 f.auth.getUser=async()=>({data:{user:null},error:{name:"AuthRetryableFetchError"}});
 await assert.rejects(f.transport.identity());assert.equal(f.counts().created,1);
});
test("pair RPC waits for session refresh and missing auth is not reported as deleted pair",async()=>{
 const f=fake();await assert.rejects(f.transport.pairState("pair"),/авторизации/);assert.equal(f.counts().rpc,0);
 let refreshed=false;
 f.auth.getSession=async()=>{await new Promise(r=>setTimeout(r,5));refreshed=true;return {data:{session:{user:{id:"old"}}},error:null}};
 assert.equal((await f.transport.pairState("pair")).id,"pair");assert.equal(refreshed,true);assert.equal(f.counts().created,0);
});
test("empty pair lookup refreshes existing credentials once and automatically restores access",async()=>{
 const f=fake();let attempts=0,refreshes=0;
 f.auth.getSession=async()=>({data:{session:{user:{id:"old"}}},error:null});
 (f.auth as any).refreshSession=async()=>{refreshes++;return {error:null}};
 (f.transport as any).client.rpc=async()=>({data:++attempts===1?[]:[{id:"pair"}],error:null});
 assert.equal((await f.transport.pairState("pair")).id,"pair");assert.equal(refreshes,1);assert.equal(f.counts().created,0);
});
test("persistent access denial does not create accounts or endlessly rotate refresh tokens",async()=>{
 const f=fake();let refreshes=0;
 f.auth.getSession=async()=>({data:{session:{user:{id:"wrong"}}},error:null});
 (f.auth as any).refreshSession=async()=>{refreshes++;return {error:null}};
 (f.transport as any).client.rpc=async()=>({data:[],error:null});
 await assert.rejects(f.transport.pairState("pair"),/не сброшено/);await assert.rejects(f.transport.pairState("pair"));
 assert.equal(refreshes,1);assert.equal(f.counts().created,0);
});
