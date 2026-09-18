import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(target));
    else if (/\.(?:ts|tsx|sql|json)$/.test(entry.name)) result.push(target);
  }
  return result;
}

test("public desktop sources contain no pair capsule, privileged key or private pair identity", async () => {
  const root = process.cwd();
  const files = (await Promise.all(["electron", "src", "supabase"].map(folder => sourceFiles(path.join(root, folder))))).flat();
  const source = (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");

  assert.doesNotMatch(source, /PAIR_RECOVERY_CAPSULES|SUPABASE_SERVICE(?:_ROLE)?_KEY/i);
  assert.doesNotMatch(source, /\bservice_role\b|\b(?:SUPABASE_)?MASTER_KEY\b/i);
  assert.doesNotMatch(source, /0674a441|9903f0d1|qkB5tAX/i);

  const configuredKey = /supabaseKey\s*=\s*"([^"]+)"/.exec(source)?.[1];
  assert.match(configuredKey ?? "", /^sb_publishable_[A-Za-z0-9_-]+$/);
});

test("database policies bind reads, writes and diagnostics transport to pair members", async () => {
  const sql = await readFile(path.join(process.cwd(), "supabase", "migrations", "001_family_bridge.sql"), "utf8");
  assert.match(sql, /auth\.uid\(\) = owner_id or auth\.uid\(\) = partner_id/);
  assert.match(sql, /sender_id = auth\.uid\(\)/);
  assert.match(sql, /recipient_id <> auth\.uid\(\)/);
  assert.match(sql, /partner_id is null[\s\S]*invite_hash = requested_invite_hash/);
});
