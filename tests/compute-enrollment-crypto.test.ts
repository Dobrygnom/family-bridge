import assert from "node:assert/strict";
import test from "node:test";
import { createEnrollmentKeyPair, openEnrollmentPayload, sealEnrollmentPayload, validEnrollmentPrivateKey, validEnrollmentPublicKey } from "../electron/compute-enrollment-crypto.js";

test("compute enrollment seals channel secrets to the exact requester key", () => {
  const provider = createEnrollmentKeyPair(), requester = createEnrollmentKeyPair(), stranger = createEnrollmentKeyPair();
  assert.equal(validEnrollmentPublicKey(provider.publicKey), true);
  assert.equal(validEnrollmentPrivateKey(provider.privateKey), true);
  assert.equal(validEnrollmentPrivateKey(provider.publicKey), false);
  const payload = sealEnrollmentPayload({ inviteSecret: "private", encryptionSecret: "also-private" }, provider.privateKey, requester.publicKey);
  assert.doesNotMatch(payload, /private/);
  assert.deepEqual(openEnrollmentPayload(payload, requester.privateKey, provider.publicKey), { inviteSecret: "private", encryptionSecret: "also-private" });
  assert.throws(() => openEnrollmentPayload(payload, stranger.privateKey, provider.publicKey));
});
