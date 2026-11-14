import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const repository = 'doomerlabs/doomer-node';
const marker = 'doomer-npm-package-v1';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(done => setTimeout(done, ms));

export function validateMetadata(pkg, lock, tag) {
  if (pkg.name !== '@doomerlabs/doomer' || !versionPattern.test(pkg.version)) throw new Error('Expected @doomerlabs/doomer with a stable three-part SemVer version.');
  if (lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version || lock.packages?.['']?.name !== pkg.name) throw new Error('package.json and package-lock.json must agree.');
  if (tag !== undefined && tag !== pkg.version) throw new Error('Release tag must be the exact package version.');
  return { name: pkg.name, version: pkg.version };
}

export function completedEvidence(checks, sha) {
  const trusted = checks.filter(c => c.app?.slug === 'depot-code-access' && c.head_sha === sha);
  const latest = name => trusted.filter(c => c.name === name).sort((a, b) => b.id - a.id)[0];
  const selected = ['ci / package', 'agent-e2e / onboarding'].map(latest);
  for (const check of selected) {
    if (check?.status === 'completed' && check.conclusion !== 'success') throw new Error(`Required Depot check failed: ${check.name} (${check.conclusion}).`);
  }
  if (selected.some(c => !c || c.status !== 'completed')) return null;
  const matches = [...(selected[0].output?.summary || '').matchAll(/<!-- doomer-npm-package-v1\n([^]*?)\n-->/g)];
  if (matches.length !== 1) throw new Error('Depot package check has no unique package integrity evidence.');
  const evidence = JSON.parse(matches[0][1]);
  if (evidence.schema !== 1 || evidence.commit !== sha || evidence.name !== '@doomerlabs/doomer' || !versionPattern.test(evidence.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(evidence.integrity)) throw new Error('Invalid Depot package integrity evidence.');
  return evidence;
}

export function checkPublished(expected, published, latest) {
  if (published && published.dist?.integrity !== expected.integrity) throw new Error('This npm version already exists with different bytes; never reuse or overwrite it.');
  if (published) return false;
  if (latest && versionPattern.test(latest.version)) {
    const a = latest.version.split('.').map(Number), b = expected.version.split('.').map(Number);
    const i = a.findIndex((n, index) => n !== b[index]);
    if (i >= 0 && a[i] > b[i]) throw new Error('Refusing to move latest backwards.');
  }
  return true;
}

// The first release was published manually. Its immutable receipt is not a
// permission to replace it: the original archive and every runtime file must
// still match. Only README documentation may differ in the new CI commit.
export function packageFiles(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 1024 * 1024 });
  const files = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().split('\0')[0];
    const sizeText = header.subarray(124, 136).toString().replace(/\0/g, '').trim();
    const modeText = header.subarray(100, 108).toString().replace(/\0/g, '').trim();
    if (!name.startsWith('package/') || !/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(modeText) || ![0, 48].includes(header[156])) throw new Error('Unexpected initial-release archive entry.');
    const path = name.slice(8), size = parseInt(sizeText, 8);
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..') || Object.hasOwn(files, path) || offset + 512 + size > tar.length) throw new Error('Invalid initial-release archive path or size.');
    files[path] = { sha256: createHash('sha256').update(tar.subarray(offset + 512, offset + 512 + size)).digest('hex'), mode: parseInt(modeText, 8) };
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function verifyInitialRelease(current, published, receipt) {
  if (receipt.schema !== 1 || receipt.name !== '@doomerlabs/doomer' || receipt.version !== '0.0.1' || receipt.publication !== 'manual' || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit) || integrity(published) !== receipt.integrity) throw new Error('Initial release does not match its immutable publication receipt.');
  const originalFiles = packageFiles(published), currentFiles = packageFiles(current);
  const names = Object.keys(receipt.files).sort();
  for (const files of [originalFiles, currentFiles]) {
    if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(names)) throw new Error('Initial-release file set changed.');
    for (const name of names) {
      const recorded = receipt.files[name], actual = files[name];
      if (actual.mode !== recorded.mode || (files === originalFiles || name !== 'README.md') && actual.sha256 !== recorded.sha256) throw new Error(`Initial-release file changed: ${name}`);
    }
  }
}

async function downloadPublished(published) {
  const url = new URL(published.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected npm tarball host.');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`npm tarball returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

async function metadata(tag) {
  return validateMetadata(JSON.parse(await readFile('package.json')), JSON.parse(await readFile('package-lock.json')), tag);
}

export async function pack(directory, expected) {
  const meta = await metadata();
  await mkdir(directory, { recursive: true });
  const [result] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
  if (result.filename !== basename(result.filename) || result.name !== meta.name || result.version !== meta.version) throw new Error('Unexpected npm tarball metadata.');
  for (const file of result.files) {
    if (!['package.json', 'README.md', 'LICENSE'].includes(file.path) && !/^(src|bin)\//.test(file.path)) throw new Error(`Unexpected published file: ${file.path}`);
  }
  const tarball = join(directory, result.filename);
  const evidence = { schema: 1, commit: git('rev-parse', 'HEAD'), ...meta, integrity: integrity(await readFile(tarball)) };
  if (evidence.integrity !== result.integrity) throw new Error('npm pack integrity does not match the tarball.');
  if (expected && Object.keys(evidence).some(key => evidence[key] !== expected[key])) throw new Error('Repacked release differs from the package tested by Depot.');
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  return { evidence, tarball };
}

async function registry(version) {
  const response = await fetch(`https://registry.npmjs.org/@doomerlabs%2fdoomer/${version}`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}.`);
  return response.json();
}

async function gate(directory) {
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_EVENT_NAME !== 'push') throw new Error('Release must run on a tag push in doomerlabs/doomer-node.');
  const meta = await metadata(process.env.GITHUB_REF_NAME);
  const sha = git('rev-parse', 'HEAD');
  git('merge-base', '--is-ancestor', sha, 'origin/main');
  if (!process.env.GH_TOKEN) throw new Error('A read-only GitHub token is required to check Depot results.');
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const checks = [];
    for (let page = 1; ; page++) {
      const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`GitHub checks returned HTTP ${response.status}.`);
      const data = await response.json(); checks.push(...data.check_runs);
      if (data.check_runs.length < 100) break;
      if (page >= 20) throw new Error('Too many checks to verify safely.');
    }
    const evidence = completedEvidence(checks, sha);
    if (evidence) {
      if (evidence.version !== meta.version) throw new Error('Depot tested a different package version.');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'expected.json'), JSON.stringify(evidence));
      console.log(`Depot verified ${meta.version} at ${sha}.`); return;
    }
    console.log('Waiting for the exact commit’s Depot package and onboarding checks.');
    await sleep(15000);
  }
  throw new Error('Timed out waiting for required Depot checks.');
}

async function main() {
  const [command, output] = process.argv.slice(2);
  if (!output) throw new Error('An output directory is required.');
  const directory = resolve(output);
  if (command === 'gate') return gate(directory);
  if (command === 'pack' || command === 'reproduce') {
    const expected = command === 'reproduce' ? JSON.parse(await readFile(join(directory, 'expected.json'))) : undefined;
    const { evidence, tarball } = await pack(directory, expected);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n<!-- ${marker}\n${JSON.stringify(evidence)}\n-->\nTested npm package: ${evidence.name}@${evidence.version}\n\nIntegrity: \`${evidence.integrity}\`\n`);
    if (expected) {
      const published = await registry(evidence.version);
      let publication = evidence;
      if (published && published.dist?.integrity !== evidence.integrity && evidence.version === '0.0.1') {
        const receipt = JSON.parse(await readFile('releases/0.0.1.json'));
        verifyInitialRelease(await readFile(tarball), await downloadPublished(published), receipt);
        publication = { ...evidence, integrity: receipt.integrity, originalSourceCommit: receipt.sourceCommit, publication: 'manual, verified by CI' };
        console.log('Verified the immutable manually published 0.0.1; no npm upload will be performed.');
      }
      const publish = checkPublished(publication, published, await registry('latest'));
      await writeFile(join(directory, 'publication.json'), JSON.stringify(publication, null, 2) + '\n');
      if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub step outputs.');
      await appendFile(process.env.GITHUB_OUTPUT, `tarball=${tarball}\npublish=${publish}\n`);
    }
    console.log(`Verified ${evidence.name}@${evidence.version}: ${evidence.integrity}`); return;
  }
  if (command === 'verify') {
    const expected = JSON.parse(await readFile(join(directory, 'publication.json')));
    for (let attempt = 0; attempt < 40; attempt++) {
      const published = await registry(expected.version);
      if (published) {
        if (published.dist?.integrity !== expected.integrity) throw new Error('Published integrity differs from the tested tarball.');
        if (integrity(await downloadPublished(published)) !== expected.integrity) throw new Error('Published npm tarball bytes do not match.');
        console.log(`Verified public npm tarball for ${expected.name}@${expected.version}.`); return;
      }
      await sleep(15000);
    }
    throw new Error('npm has not made the version downloadable; rerun this workflow to verify without overwriting it.');
  }
  throw new Error('Unknown release command.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
