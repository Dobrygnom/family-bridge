import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.ok(['win32', 'darwin'].includes(process.platform));
const payloads = process.platform === 'win32'
  ? [`Family-Bridge-${version}-x64.exe`]
  : ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `Family-Bridge-${version}-${arch}.${ext}`));
const files = [...payloads.flatMap(name => [name, name + '.blockmap']), process.platform === 'win32' ? 'latest.yml' : 'latest-mac.yml'].sort();
const checksums = [];
for (const name of files) {
  const bytes = await readFile('release/' + name);
  assert.ok(bytes.length > 0, `Empty artifact: ${name}`);
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await writeFile('release/build-SHA256SUMS.txt', checksums.join('\n') + '\n');
console.log(`Recorded checksums for ${files.length} ${process.platform} artifacts`);
