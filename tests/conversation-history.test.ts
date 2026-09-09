import assert from "node:assert/strict";
import test from "node:test";
import {resolveHistory,type HistoryReport} from "../src/core/conversation-history.js";
const report=(id:string,parentReportId?:string,texts=[id]):HistoryReport=>({id,parentReportId,topic:'Topic',completedAt:id,messages:texts.map(text=>({from:'dima',text}))});
test("even an old button resolves the latest continuation with the full history",()=>{
  const history=resolveHistory([report('3','2',['a','b','c']),report('1',undefined,['a']),report('2','1',['a','b'])],'1');
  assert.equal(history.latest.id,'3'); assert.deepEqual(history.history.map(m=>m.text),['a','b','c']);
});
test("matching titles do not merge independent conversations",()=>{
  assert.equal(resolveHistory([report('1'),report('2')],'1').latest.id,'1');
});
