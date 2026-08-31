import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SupabaseTransport, type AuthStorage } from "../src/core/supabase-transport.js";

const userData = process.argv[2];
if (!userData) throw new Error("Usage: configure-local-pair.ts <user-data-directory>");
await mkdir(userData, { recursive: true });

const authFile = path.join(userData, "supabase-auth.json");
const readAuth = async (): Promise<Record<string, string>> => {
  try { return JSON.parse(await readFile(authFile, "utf8")) as Record<string, string>; }
  catch { return {}; }
};
const storage: AuthStorage = {
  getItem: async (key) => (await readAuth())[key] ?? null,
  setItem: async (key, value) => {
    const data = await readAuth();
    data[key] = value;
    await writeFile(authFile, JSON.stringify(data), "utf8");
  },
  removeItem: async (key) => {
    const data = await readAuth();
    delete data[key];
    if (Object.keys(data).length) await writeFile(authFile, JSON.stringify(data), "utf8");
    else await rm(authFile, { force: true });
  },
};

const transport = new SupabaseTransport(
  "https://knqaygvvqrwmtyqucbsz.supabase.co",
  "sb_publishable_igxXq8mdFjW-wKJGSKhtnA_iINygezS",
  "",
  storage,
);
const invite = await transport.createPair();
const state = {
  owner: "dima",
  autoStart: true,
  pendingTopics: [],
  blockedTopics: [],
  reports: [],
  remote: { pairId: invite.pairId, encryptionSecret: invite.encryptionSecret, inviteSecret: invite.inviteSecret },
};
const stateFile = path.join(userData, "state.json");
const temporary = `${stateFile}.tmp`;
await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
await rename(temporary, stateFile);
const encoded = Buffer.from(JSON.stringify(invite)).toString("base64url");
await writeFile(path.join(userData, "pairing-invite.txt"), encoded, "utf8");
console.log(JSON.stringify({ pairId: invite.pairId, inviteFile: path.join(userData, "pairing-invite.txt") }));
