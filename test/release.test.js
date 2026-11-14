import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { validateMetadata, completedEvidence, checkPublished, pack, verifyInitialRelease, packageFiles } from '../scripts/release.mjs';

const sha = 'a'.repeat(40);
const evidence = { schema: 1, commit: sha, name: '@doomerlabs/doomer', version: '0.0.2', integrity: 'sha512-' + 'A'.repeat(86) + '==' };
const checks = () => ['ci / package', 'agent-e2e / onboarding'].map((name, i) => ({
  id: i + 1, name, head_sha: sha, app: { slug: 'depot-code-access' }, status: 'completed', conclusion: 'success',
  output: { summary: `<!-- doomer-npm-package-v1\n${JSON.stringify(evidence)}\n-->` },
}));

test('release requires an exact stable SemVer tag and matching lockfile metadata', () => {
  const pkg = { name: '@doomerlabs/doomer', version: '0.0.2' };
  const lock = { ...pkg, packages: { '': pkg } };
  assert.deepEqual(validateMetadata(pkg, lock, '0.0.2'), pkg);
  for (const tag of ['v0.0.2', '0.0.3', '0.0.2-beta.1']) assert.throws(() => validateMetadata(pkg, lock, tag), /exact package version/);
  assert.throws(() => validateMetadata(pkg, { ...lock, version: '0.0.1' }, '0.0.2'), /must agree/);
  assert.throws(() => validateMetadata({ ...pkg, version: '2026.11.13.1' }, lock), /three-part SemVer/);
});

test('release waits for both trusted Depot checks on the exact source commit', () => {
  assert.deepEqual(completedEvidence(checks(), sha), evidence);
  assert.equal(completedEvidence([], sha), null);
  for (const field of ['head_sha', 'app']) {
    const other = checks(); other[0][field] = field === 'app' ? { slug: 'another-app' } : 'b'.repeat(40);
    assert.equal(completedEvidence(other, sha), null);
  }
  const pending = checks(); pending[1].status = 'in_progress';
  assert.equal(completedEvidence(pending, sha), null);
  const failed = checks(); failed[1].conclusion = 'failure';
  assert.throws(() => completedEvidence(failed, sha), /Depot check failed/);
  const retry = checks(); retry.push({ ...retry[0], id: 10, status: 'in_progress' });
  assert.equal(completedEvidence(retry, sha), null, 'a newer running attempt supersedes old success');
});

test('release rejects missing, duplicate and mismatched Depot integrity evidence', () => {
  for (const summary of ['', '<!-- doomer-npm-package-v1\n{}\n-->', checks()[0].output.summary.repeat(2)]) {
    const input = checks(); input[0].output.summary = summary;
    assert.throws(() => completedEvidence(input, sha));
  }
  const input = checks(); input[0].output.summary = input[0].output.summary.replace(sha, 'b'.repeat(40));
  assert.throws(() => completedEvidence(input, sha), /Invalid Depot/);
});

test('registry retries verify existing bytes without republishing or rolling latest back', () => {
  assert.equal(checkPublished(evidence, null, { version: '0.0.1' }), true);
  assert.equal(checkPublished(evidence, { dist: { integrity: evidence.integrity } }, { version: '0.0.3' }), false);
  assert.throws(() => checkPublished(evidence, { dist: { integrity: 'different' } }), /different bytes/);
  assert.throws(() => checkPublished(evidence, null, { version: '0.0.3' }), /latest backwards/);
});

test('npm tarball can be reproduced exactly and a different expected digest is rejected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doomer-release-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await pack(join(root, 'first'));
  const second = await pack(join(root, 'second'), first.evidence);
  assert.equal(second.evidence.integrity, first.evidence.integrity);
  await assert.rejects(pack(join(root, 'wrong'), { ...first.evidence, integrity: 'wrong' }), /differs from the package tested/);
});

function archive(files, modes = {}) {
  const entries = Object.entries(files).flatMap(([name, content]) => {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    header.write('package/' + name);
    const mode = modes[name] ?? (name.startsWith('bin/') ? 0o755 : 0o644);
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header[156] = 48;
    return [header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)];
  });
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test('initial release adoption preserves immutable bytes and runtime files, allowing only newer README text', () => {
  const original = archive({ 'package.json': '{"version":"0.0.1"}', 'bin/doomer.js': 'original CLI', 'README.md': 'original docs' });
  const receipt = { schema: 1, name: '@doomerlabs/doomer', version: '0.0.1', sourceCommit: sha, publication: 'manual', integrity: 'sha512-' + createHash('sha512').update(original).digest('base64'), files: packageFiles(original) };
  assert.equal(receipt.files['bin/doomer.js'].mode, 0o755);
  assert.doesNotThrow(() => verifyInitialRelease(original, original, receipt));
  const originalContents = { 'package.json': '{"version":"0.0.1"}', 'bin/doomer.js': 'original CLI', 'README.md': 'original docs' };
  assert.throws(() => verifyInitialRelease(archive(originalContents, { 'bin/doomer.js': 0o644 }), original, receipt), /file changed/);
  assert.throws(() => verifyInitialRelease(archive(originalContents, { 'README.md': 0o755 }), original, receipt), /file changed/);
  const docs = archive({ 'package.json': '{"version":"0.0.1"}', 'bin/doomer.js': 'original CLI', 'README.md': 'new CI instructions' });
  assert.doesNotThrow(() => verifyInitialRelease(docs, original, receipt));
  const changed = archive({ 'package.json': '{"version":"0.0.1"}', 'bin/doomer.js': 'changed CLI', 'README.md': 'original docs' });
  assert.throws(() => verifyInitialRelease(changed, original, receipt), /file changed/);
  assert.throws(() => verifyInitialRelease(docs, changed, receipt), /immutable publication receipt/);
  assert.throws(() => verifyInitialRelease(archive({ 'package.json': '{"version":"0.0.1"}' }), original, receipt), /file set changed/);
});
