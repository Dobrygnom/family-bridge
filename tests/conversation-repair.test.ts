import assert from "node:assert/strict";
import test from "node:test";
import { hasExplicitRoleBreak, repairCandidates } from "../src/core/conversation-repair.js";
import type { HistoryReport } from "../src/core/conversation-history.js";

test('repair is conservative, one-time, and limited to conversations predating the migration',()=>{
  assert.equal(hasExplicitRoleBreak('Мне не нравится, как это предложил агент по недвижимости.'),false);
  assert.equal(hasExplicitRoleBreak('Я представляю перспективу Катя, но не могу подтвердить.'),true);
  const report:HistoryReport={id:'root',topic:'Topic',completedAt:'2026-09-09T10:00:00Z',messages:[{from:'dima',text:'A question'},{from:'katya',text:'Мы говорим как агенты.'}]};
  assert.equal(repairCandidates([report],'2026-09-09T11:00:00Z').length,1);
  assert.equal(repairCandidates([report],'2026-09-09T09:00:00Z').length,0);
  assert.equal(repairCandidates([report,{...report,id:'new',parentReportId:'root',restarted:true}]).length,0);
});
