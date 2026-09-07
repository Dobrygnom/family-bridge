import assert from "node:assert/strict";
import test from "node:test";
import { createModelResolver } from "../src/core/codex-model.js";

test("Astra is preferred only when visible in the client's available models", async () => {
  assert.equal(await createModelResolver(async () => [{model:"gpt-6-astra"}])("client"), "gpt-6-astra");
  assert.equal(await createModelResolver(async () => [{model:"gpt-6-astra",hidden:true}])("client"), undefined);
  assert.equal(await createModelResolver(async () => [{model:"gpt-5.5"}])("client"), undefined);
  assert.equal(await createModelResolver(async () => {throw new Error("offline");})("client"), undefined);
});

test("parallel jobs share discovery; catalog and failures expire for subsequent jobs", async () => {
  let now=0, calls=0, fail=true;
  const resolve=createModelResolver(async () => {calls++;if(fail)throw new Error("offline");return [{model:"gpt-6-astra"}];},()=>now);
  assert.deepEqual(await Promise.all([resolve("client"),resolve("client")]), [undefined,undefined]);
  assert.equal(calls,1);
  now=30_001;fail=false;
  assert.equal(await resolve("client"),"gpt-6-astra");
  assert.equal(calls,2);
  await resolve("client");assert.equal(calls,2);
  now+=300_001;
  await resolve("client");assert.equal(calls,3);
  await resolve("other-client");assert.equal(calls,4);
});
