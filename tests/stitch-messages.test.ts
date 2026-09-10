import assert from 'node:assert/strict';
import test from 'node:test';
import {stitchMessages} from '../src/core/stitch-messages.js';
import {resolveHistory} from '../src/core/conversation-history.js';
import {conversationThreads} from '../src/core/conversation-threads.js';
test('mixed full snapshots and shortened legacy tails do not replay history in either UI or model context',()=>{
  const sequences=[[1,2,3,4],[1,2,3,4,5,6,7,8,9],[5,6,9,10,11,12,13,14,15],[5,6,9,10,11,12,13,14,15,16,17,18,19],[1,2,3,4,5,6,7,8,9,5,6,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]];
  const nodes=sequences.map((messages,i)=>({id:String(i),parentReportId:i?String(i-1):undefined,messages}));
  const before=JSON.stringify(nodes), stitched=stitchMessages(nodes,(a,b)=>a===b);
  assert.deepEqual(nodes.flatMap(n=>stitched.get(n.id)!.newMessages),Array.from({length:23},(_,i)=>i+1));
  const reports=nodes.map(n=>({...n,topic:'Topic',completedAt:n.id,messages:n.messages.map(m=>({from:'dima' as const,text:String(m)}))}));
  assert.equal(resolveHistory(reports,'0').history.length,23);
  const ui=reports.map(r=>({...r,summary:'',answerFrom:'',proposedBy:[],messageCount:r.messages.length,messages:r.messages.map(m=>({local:true,speaker:'Me',text:m.text}))}));
  assert.equal(conversationThreads({reportSummaries:ui,liveConversations:[]})[0].messageCount,23);
  assert.equal(JSON.stringify(nodes),before);
});
test('explicit context lengths preserve intentional repeated replies, restarts and unrelated histories',()=>{
  const nodes=[{id:'root',messages:['yes','no']},{id:'child',parentReportId:'root',messages:['yes','no','yes'],inheritedMessageCount:2},{id:'restart',parentReportId:'child',restarted:true,messages:['yes']},{id:'new',parentReportId:'restart',messages:['yes'],inheritedMessageCount:0}];
  const result=stitchMessages(nodes,(a,b)=>a===b);
  assert.deepEqual(result.get('child')!.newMessages,['yes']);
  assert.deepEqual(result.get('restart')!.history,['yes']);
  assert.deepEqual(result.get('new')!.history,['yes','yes']);
});
