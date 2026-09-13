import assert from "node:assert/strict";
import test from "node:test";
import { bridgeWirePayload, DIALOGUE_PROTOCOL_VERSION } from "../src/core/dialogue-protocol.js";

test("wire contract accepts legacy and current messages but rejects malformed or future payloads", () => {
  assert.ok(bridgeWirePayload({ topic:"Тема", text:"Сообщение", status:"continue" }));
  assert.ok(bridgeWirePayload({ protocol:DIALOGUE_PROTOCOL_VERSION, kind:"dialogue", topic:"Тема", text:"Сообщение", status:"continue", sentAt:"2026-09-13T10:00:00Z" }));
  assert.ok(bridgeWirePayload({ protocol:2, kind:"topic", topic:"Тема", versionOnly:true }));
  assert.equal(bridgeWirePayload(null),undefined);
  assert.equal(bridgeWirePayload({ protocol:3, kind:"dialogue", topic:"Тема", text:"Сообщение", status:"continue" }),undefined);
  assert.equal(bridgeWirePayload({ protocol:2, kind:"dialogue", topic:"", text:"Сообщение", status:"continue" }),undefined);
  assert.equal(bridgeWirePayload({ protocol:2, kind:"dialogue", topic:"Тема", text:"", status:"continue" }),undefined);
  assert.equal(bridgeWirePayload({ protocol:2, kind:"topic", topic:"Тема", versionOnly:"yes" }),undefined);
});
