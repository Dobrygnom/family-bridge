import assert from "node:assert/strict";
import test from "node:test";
import { decryptPayload, encryptPayload, generateSharedSecret } from "../src/core/encryption.js";

test("transport payload encryption round-trips without plaintext leakage", () => {
  const secret = generateSharedSecret();
  const input = { private: "sensitive text", sequence: 4 };
  const encrypted = encryptPayload(input, secret);
  assert.equal(encrypted.includes("sensitive text"), false);
  assert.deepEqual(decryptPayload(encrypted, secret), input);
});
