import assert from "node:assert/strict";
import test from "node:test";
import { droppedReply, isKnownLegacyReply } from "../src/core/legacy-reply.js";
import type {StoredState} from "../electron/store.js";
import type {RemoteEnvelope} from "../src/core/supabase-transport.js";
const state = () => ({owner:"dima",remote:{pairId:"pair",peerExperienceVersion:"current"},ignoredConversationIds:[],completedIncoming:[],incomingDeliveries:{},conversationTranscripts:{c:{topic:"Topic",messages:[{from:"katya",text:"Question"},{from:"dima",text:"Our reply"}]}}}) as unknown as StoredState;
const row=(sequence:number,text:string,from="katya")=>({id:`m${sequence}`,conversation_id:"c",pair_id:"pair",sequence_number:sequence,sender_agent:from,status:"processed",created_at:"2026-09-09T12:00:00Z",payload:{kind:"dialogue",topic:"Topic",text,status:"continue"}}) as RemoteEnvelope<any>;
test("missing metadata is accepted only for a known current conversation from the peer",()=>{
  const s=state(),reply=row(3,"Next reply");
  assert.equal(isKnownLegacyReply(s,reply,"current"),true);
  for(const bad of [{...reply,conversation_id:"unknown"},{...reply,pair_id:"other"},{...reply,sender_agent:"dima"},{...reply,sequence_number:1},{...reply,payload:{...reply.payload,experienceVersion:"old"}}]) assert.equal(isKnownLegacyReply(s,bad as any,"current"),false);
  s.conversationResetAt="2026-09-10T00:00:00Z";assert.equal(isKnownLegacyReply(s,reply,"current"),false);
});
test("recovery restores only the next dropped reply, not historical or already processed messages",()=>{
  const s=state(),rows=[row(1,"Question"),row(2,"Our reply","dima"),row(3,"Next reply")];
  assert.equal(droppedReply(s,rows,"current")?.id,"m3");
  s.completedIncoming=["m3"];assert.equal(droppedReply(s,rows,"current"),undefined);
  s.completedIncoming=[];s.incomingDeliveries.m3={envelope:rows[2]};assert.equal(droppedReply(s,rows,"current"),undefined);
  s.incomingDeliveries={};rows[2].sequence_number=5;assert.equal(droppedReply(s,rows,"current"),undefined);
});
