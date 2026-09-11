import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodexAppHistoryClient, NativePipeClient} from '../src/core/codex-app-history.js';

async function endpoint(handler:(request:any,reply:(value:any)=>void)=>void) {
  const address=process.platform==='win32'?`\\\\.\\pipe\\fb-history-${randomUUID()}`:path.join(os.tmpdir(),`fb-history-${randomUUID()}.sock`);
  const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE(0)+4){
      const length=buffer.readUInt32LE(0),request=JSON.parse(buffer.subarray(4,length+4).toString());buffer=buffer.subarray(length+4);
      handler(request,value=>{const payload=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,...value}));const frame=Buffer.alloc(payload.length+4);frame.writeUInt32LE(payload.length);payload.copy(frame,4);socket.write(frame);});
    }});
  });
  await new Promise<void>(resolve=>server.listen(address,resolve));
  return {address,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
const capabilities={result:{tools:['list_threads','read_thread','list_projects'].map(name=>({name,namespace:'codex_app'}))}};
const response=(value:any,success=true)=>({result:{success,contentItems:[{type:'inputText',text:JSON.stringify(value)}]}});
const page=(text:string,cursor?:string)=>({turns:[{id:text,startedAt:1,items:[{id:text,type:'userMessage',content:[{type:'text',text}]}]}],page:{hasMore:Boolean(cursor),nextCursor:cursor}});

test('busy page retries the same cursor, completes the history, and never invokes browser endpoints',async()=>{
  let calls=0,browserCalls=0;const cursors:unknown[]=[],pauses:number[]=[];
  const app=await endpoint((r,reply)=>{
    if(r.method==='tools/list')return reply(capabilities);
    assert.equal(r.params.tool,'read_thread');calls++;cursors.push(r.params.arguments.cursor);
    if(calls===1)return reply(response({error:'reached concurrency limit'},false));
    reply(response(calls===2?page('first','older'):page('second')));
  });
  const browser=await endpoint((_r,reply)=>{browserCalls++;reply({error:{message:'No handler registered for method: tools/list'}});});
  try {
    const messages=await new CodexAppHistoryClient('caller',{transports:()=>[app.address,browser.address],pause:async ms=>{pauses.push(ms);}}).readUserMessages('source');
    assert.deepEqual(messages.map(m=>m.text),['first','second']);assert.deepEqual(cursors,[undefined,undefined,'older']);
    assert.deepEqual(pauses,[2000]);assert.equal(browserCalls,0);
  }finally{await app.close();await browser.close();}
});

test('a real reader failure is preserved instead of being replaced by a browser tools/list error',async()=>{
  let browserCalls=0;
  const app=await endpoint((r,reply)=>reply(r.method==='tools/list'?capabilities:response({error:'source temporarily unavailable'},false)));
  const browser=await endpoint((_r,reply)=>{browserCalls++;reply({error:{message:'No handler registered for method: tools/list'}});});
  try{await assert.rejects(new CodexAppHistoryClient('caller',{transports:()=>[app.address,browser.address]}).readUserMessages('source'),{code:'CODEX_HISTORY_READ_FAILED'});assert.equal(browserCalls,0);}
  finally{await app.close();await browser.close();}
});

test('persistent overload is bounded and malformed history never becomes an empty successful export',async()=>{
  let calls=0,busy=true;
  const app=await endpoint((r,reply)=>{if(r.method==='tools/list')return reply(capabilities);calls++;reply(busy?response({error:'Too many concurrent requests'},false):response({}));});
  try{
    const client=new CodexAppHistoryClient('caller',{transports:()=>[app.address],pause:async()=>{}});
    await assert.rejects(client.readUserMessages('source'),{code:'CODEX_DESKTOP_BUSY'});assert.equal(calls,4);
    busy=false;await assert.rejects(client.readUserMessages('source'),{code:'CODEX_DESKTOP_PROTOCOL'});
  }finally{await app.close();}
});

test('timed out calls send cancellation for globally unique IDs without cancelling another client',async()=>{
  const calls:string[]=[],cancelled:string[]=[];
  const app=await endpoint((r,reply)=>{if(r.method==='tools/cancel'){cancelled.push(r.id);return;}calls.push(r.id);if(r.params?.fast)reply({result:{ok:true}});});
  const slow=new NativePipeClient(app.address,40),fast=new NativePipeClient(app.address,1000);
  try{
    await Promise.all([slow.connect(),fast.connect()]);
    const waiting=assert.rejects(slow.request('tools/call'),{code:'CODEX_DESKTOP_TIMEOUT'});
    assert.deepEqual(await fast.request('tools/call',{fast:true}),{ok:true});await waiting;
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(new Set(calls).size,2);assert.ok(calls.every(id=>/^[a-f0-9-]{36}$/.test(id)));assert.deepEqual(cancelled,[calls[0]]);
  }finally{slow.close();fast.close();await app.close();}
});
