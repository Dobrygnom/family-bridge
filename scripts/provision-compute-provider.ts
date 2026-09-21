import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { durableAuthStorage } from "../electron/auth-storage.js";
import {
  createEnrollmentKeyPair,
  validEnrollmentPrivateKey,
  validEnrollmentPublicKey,
  type EnrollmentKeyPair,
} from "../electron/compute-enrollment-crypto.js";
import { SupabaseTransport } from "../src/core/supabase-transport.js";

const roaming = process.env.APPDATA;
if (!roaming) throw new Error("APPDATA is unavailable");
const computeRoot = path.join(roaming, "family-bridge", "compute-channel");

async function enrollmentKeys(): Promise<EnrollmentKeyPair> {
  const file = path.join(computeRoot, "enrollment-keys.json");
  try {
    const existing = JSON.parse(await readFile(file, "utf8")) as EnrollmentKeyPair;
    if (validEnrollmentPublicKey(existing.publicKey) && validEnrollmentPrivateKey(existing.privateKey)) return existing;
  } catch { /* provision a new durable identity below */ }

  await mkdir(computeRoot, { recursive: true });
  const created = createEnrollmentKeyPair();
  try {
    await writeFile(file, JSON.stringify(created), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = JSON.parse(await readFile(file, "utf8")) as EnrollmentKeyPair;
    if (!validEnrollmentPublicKey(winner.publicKey) || !validEnrollmentPrivateKey(winner.privateKey)) {
      throw new Error("Existing compute enrollment identity is invalid");
    }
    return winner;
  }
}

const transport = new SupabaseTransport(
  "https://knqaygvvqrwmtyqucbsz.supabase.co",
  "sb_publishable_igxXq8mdFjW-wKJGSKhtnA_iINygezS",
  "compute-enrollment-does-not-carry-message-content",
  durableAuthStorage(path.join(computeRoot, "enrollment")),
  false,
);

try {
  const providerId = await transport.identity();
  const keys = await enrollmentKeys();
  await transport.registerDefaultComputeProvider(keys.publicKey, true);
  process.stdout.write(`${providerId}\n`);
} finally {
  transport.dispose();
}
