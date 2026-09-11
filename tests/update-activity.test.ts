import assert from 'node:assert/strict';
import test from 'node:test';
import { UpdateActivity, ActivityMap, ActivitySet } from '../electron/update-activity.js';
import { sanitizeUpdateDiagnostics } from '../electron/support-report.js';

test('blockers retain actual start times, counts and oldest remaining operation',async()=>{
  let now=100; const activity=new UpdateActivity(()=>now);
  const map=new ActivityMap<string,number>(activity,'remote_workers'), set=new ActivitySet<string>(activity,'continuations');
  map.set('private conversation',1); now=200; map.set('other',2); set.add('private instruction');
  map.set('private conversation',3); now=500;
  assert.deepEqual(activity.snapshot()[0],{operation:'remote_workers',count:2,startedAt:100,elapsedMs:400});
  map.delete('private conversation'); assert.equal(activity.snapshot()[0].startedAt,200);
  activity.flag('context_check',true); now=600; activity.flag('context_check',true);
  assert.equal(activity.snapshot().find(row=>row.operation==='context_check')?.elapsedMs,100);
  assert.doesNotMatch(JSON.stringify(activity.snapshot()),/private|other/);
  map.clear(); set.clear(); activity.flag('context_check',false);
  await assert.rejects(activity.track('analysis_writes',Promise.reject(Error('test'))));
  assert.deepEqual(activity.snapshot(),[]);
});

test('remote updater diagnostics only contain known operations and IPC channels, never arbitrary text',()=>{
  const result=sanitizeUpdateDiagnostics({quiescing:true, drainStartedAt:10, secret:'private',gate:{phase:'background',checking:false,phaseStartedAt:10,elapsedMs:100,exception:'private'},
    blockers:[{operation:'remote_poll',count:1,startedAt:10,elapsedMs:100,topic:'private'},{operation:'private',startedAt:10,elapsedMs:100}],
    ipc:[{channel:'bridge:refresh-context-now',startedAt:5,elapsedMs:105,args:'private'},{channel:'bridge:private',startedAt:1,elapsedMs:109}]});
  assert.equal(result?.blockers.length,1); assert.equal(result?.ipc.length,1);
  assert.equal(result?.gate.phase,'background'); assert.doesNotMatch(JSON.stringify(result),/private|secret|args|exception/);
});
