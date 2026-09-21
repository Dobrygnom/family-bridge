import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export interface EnrollmentKeyPair {
  publicKey: string;
  privateKey: string;
}

const context = Buffer.from("family-bridge-compute-enrollment-v1", "utf8");

export function createEnrollmentKeyPair(): EnrollmentKeyPair {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

function sharedKey(privateKey: string, publicKey: string) {
  const secret = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.from(privateKey, "base64url"), type: "pkcs8", format: "der" }),
    publicKey: createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" }),
  });
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), context, 32));
}

export function sealEnrollmentPayload(value: unknown, privateKey: string, publicKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sharedKey(privateKey, publicKey), nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function openEnrollmentPayload<T>(payload: string, privateKey: string, publicKey: string): T {
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.length < 29) throw new Error("Некорректный ответ компьютера-помощника");
  const decipher = createDecipheriv("aes-256-gcm", sharedKey(privateKey, publicKey), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as T;
}

export function validEnrollmentPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    createPublicKey({ key: Buffer.from(value, "base64url"), type: "spki", format: "der" });
    return true;
  } catch { return false; }
}

export function validEnrollmentPrivateKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    createPrivateKey({ key: Buffer.from(value, "base64url"), type: "pkcs8", format: "der" });
    return true;
  } catch { return false; }
}
