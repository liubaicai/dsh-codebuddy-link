import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Git installs must not require TypeScript, devDependencies or build scripts.
// CI separately rebuilds dist and rejects any uncommitted output changes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/client.js', 'dist/acp.js', 'dist/acp-usage.js', 'dist/acp-cleanup.js', 'dist/prompt.js', 'dist/response.js', 'dist/json.js', 'dist/dsml.js', 'assets/workbuddy.webp', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json']) {
  assert.ok(existsSync(resolve(root, file)), `Missing published file: ${file}. Run npm ci && npm run build before packing.`);
}
assert.equal(pkg.main, './dist/index.js');
const { parseResponse } = await import('../dist/prompt.js');
assert.deepEqual(parseResponse('{"text":"package smoke","toolCalls":[]}', []), { text: 'package smoke', toolCalls: [] });
console.log(`Verified prebuilt package ${pkg.name}@${pkg.version}`);
