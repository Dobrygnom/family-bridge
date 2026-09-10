import assert from 'node:assert/strict';
import test from 'node:test';
import {sharedHistory,messageOrigin} from '../src/core/continuation.js';
import {originLabel} from '../src/ui/message-origin.js';
test('only structured origins are preserved, with no raw human instruction or guessed legacy source',()=>{
  const input=[{from:'dima',text:'Filtered reply',origin:'owner-answer',instruction:'PRIVATE'},{from:'katya',text:'Older reply',origin:'FAKE_PRIVATE_SOURCE'}];
  const result=sharedHistory(input);
  assert.deepEqual(result,[{from:'dima',text:'Filtered reply',origin:'owner-answer'},{from:'katya',text:'Older reply'}]);
  assert.equal(messageOrigin('human'),undefined);
  assert.equal(originLabel(undefined,true,'ru'),undefined);
  assert.equal(originLabel('owner-answer',false,'ru'),'По ответу собеседника');
  assert.equal(originLabel('continuation',true,'ru'),'По вашему дополнению');
  for(const lang of ['ru','en','cs','fr'] as const)assert.ok(originLabel('agent',false,lang));
});
