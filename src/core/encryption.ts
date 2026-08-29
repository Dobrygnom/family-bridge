import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export function generateSharedSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteSecret(secret: string): string {
  return scryptSync(secret, "family-bridge-invite-v1", 32).toString("hex");
}

export function encryptPayload(value: unknown, sharedSecret: string): string {
  const key = scryptSync(sharedSecret, "family-bridge-message-v1", 32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, encrypted]).toString("base64url");
}

export function decryptPayload<T>(payload: string, sharedSecret: string): T {
  const bytes = Buffer.from(payload, "base64url");
  const nonce = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const encrypted = bytes.subarray(28);
  const key = scryptSync(sharedSecret, "family-bridge-message-v1", 32);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as T;
}
