import assert from "node:assert/strict";
import test from "node:test";
import { reconcileTopicQueue } from "../src/core/topic-queue.js";
test("selected topics missing from the queue recover without requeuing completed, active or renamed discussions",()=>{
  const approved=[{title:'Missing'},{title:'Completed'},{title:'Active'},{title:'Renamed',sourceTitles:['Original']}];
  const queue=reconcileTopicQueue(['family-bridge:version:x','Missing','completed'],approved,['Completed','Active','Original']);
  assert.deepEqual(queue,['Missing']);
  assert.deepEqual(reconcileTopicQueue(queue,approved,['Completed','Active','Original']),queue);
});
