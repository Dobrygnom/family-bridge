import assert from "node:assert/strict";
import test from "node:test";
import { createModelResolver } from "../src/core/codex-model.js";
import { codexExecutionModel } from "../src/core/codex-settings.js";

test("the default prefers account-visible Sol while auto and explicit choices keep their meaning", () => {
  assert.equal(codexExecutionModel(undefined), undefined);
  assert.equal(codexExecutionModel("gpt-5.6-sol"), undefined);
  assert.equal(codexExecutionModel("auto"), null);
  assert.equal(codexExecutionModel("gpt-5.6-luna"), "gpt-5.6-luna");
});

test("an explicit Sol preference is used only when visible, while account-aware mode leaves selection to Codex", async () => {
  assert.equal(await createModelResolver(async () => [{model:"gpt-5.6-sol"}], Date.now, "gpt-5.6-sol")("client"), "gpt-5.6-sol");
  assert.equal(await createModelResolver(async () => [{model:"gpt-5.6-sol",hidden:true}], Date.now, "gpt-5.6-sol")("client"), undefined);
  assert.equal(await createModelResolver(async () => [{model:"gpt-5.5"}], Date.now, "gpt-5.6-sol")("client"), undefined);
  assert.equal(await createModelResolver(async () => {throw new Error("offline");}, Date.now, "gpt-5.6-sol")("client"), undefined);
  assert.equal(await createModelResolver(async () => { throw new Error("catalog must not be needed"); })("client"), undefined);
});

test("parallel jobs share discovery; catalog and failures expire for subsequent jobs", async () => {
  let now=0, calls=0, fail=true;
  const resolve=createModelResolver(async () => {calls++;if(fail)throw new Error("offline");return [{model:"gpt-5.6-sol"}];},()=>now,"gpt-5.6-sol");
  assert.deepEqual(await Promise.all([resolve("client"),resolve("client")]), [undefined,undefined]);
  assert.equal(calls,1);
  now=30_001;fail=false;
  assert.equal(await resolve("client"),"gpt-5.6-sol");
  assert.equal(calls,2);
  await resolve("client");assert.equal(calls,2);
  now+=300_001;
  await resolve("client");assert.equal(calls,3);
  await resolve("other-client");assert.equal(calls,4);
});
