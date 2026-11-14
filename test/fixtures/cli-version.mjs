import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installNative, upgradeNative } from '../../src/native.js';
import { hash, readState } from '../../src/system.js';
import { managerCommand } from '../../src/recovery.js';

await mkdir(process.env.DOOMER_BIN_DIR, { recursive: true });
const platform = `${process.platform}_${{ x64: 'amd64', arm64: 'arm64' }[process.arch]}`;
const requests = [];
let failure;
let reportedVersion;
globalThis.fetch = async address => {
  requests.push(address);
  assert.ok(!address.endsWith('stable.json'), 'pinned installations must never fall back to stable');
  const version = address.split('/releases/')[1].split('/')[0];
  if (failure === 'missing') return new Response('', { status: 404 });
  const binary = Buffer.from(`#!${process.execPath}\nconsole.log(process.argv.includes('--version') ? 'doomer ${reportedVersion || version}' : 'Watch recursively and review settled changes until stopped --manager-home --agent');\n`);
  const header = Buffer.alloc(512);
  header.write('doomer'); header.write(binary.length.toString(8).padStart(11, '0') + '\0', 124); header[156] = 48;
  const archive = gzipSync(Buffer.concat([header, binary, Buffer.alloc((512 - binary.length % 512) % 512), Buffer.alloc(1024)]));
  if (address.endsWith('release-manifest.json')) return new Response(JSON.stringify({
    schemaVersion: 1, version: failure === 'manifest' ? '2026.1.1.1' : version,
    artifacts: { [`doomer_${version}_${platform}.tar.gz`]: `sha256:${failure === 'checksum' ? '0'.repeat(64) : hash(archive)}` },
  }));
  assert.equal(address, `https://downloads.doomer.ai/cli/releases/${version}/doomer_${version}_${platform}.tar.gz`);
  return new Response(archive);
};
const version = '2026.11.3-beta.1';
const installed = await installNative({ version });
assert.equal(installed.version, version);
assert.equal(installed.source, 'pinned');
assert.equal(requests.length, 2);
await installNative();
assert.equal(requests.length, 2, 'repeat installation reuses the verified pin');
await installNative({ update: true });
assert.equal(requests.length, 4, 'manager updates retain the pin');
assert.match(managerCommand('onboard', { cliVersion: version }), /--cli-version 2026.11.3-beta.1/);
await assert.rejects(upgradeNative(), /CLI is pinned/);
const before = await readState();
const bytes = await readFile(installed.executable);
for (const [mode, pattern] of [['missing', /HTTP 404/], ['manifest', /No valid native CLI release/], ['checksum', /checksum mismatch/]]) {
  failure = mode;
  await assert.rejects(installNative({ version: '2026.11.13.1-beta.2' }), pattern);
  assert.deepEqual(await readState(), before);
  assert.deepEqual(await readFile(installed.executable), bytes);
}
failure = undefined;
reportedVersion = '2026.11.13.1-beta.20';
await assert.rejects(installNative({ version: '2026.11.13.1-beta.2' }), /version does not match/);
assert.deepEqual(await readState(), before);
assert.deepEqual(await readFile(installed.executable), bytes);
reportedVersion = undefined;
const switched = await installNative({ version: '2026.11.14.1-beta.1' });
assert.equal(switched.version, '2026.11.14.1-beta.1');
assert.equal(switched.source, 'pinned');
