import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, lstat, access, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { exec } from './helpers.js';
import { packageRoot, metadata } from '../src/system.js';

const candidate = process.env.DOOMER_TEST_NATIVE;
const legacyPackage = process.env.DOOMER_TEST_LEGACY_PACKAGE;
const legacyBinary = process.env.DOOMER_TEST_LEGACY_BINARY;
const skills = process.env.DOOMER_TEST_SKILLS;
const service = 'http://127.0.0.1:48125/api';
const skip = !candidate || !skills ? 'set DOOMER_TEST_NATIVE and DOOMER_TEST_SKILLS to exercise the packed installer' : false;

async function installerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'doomer-cutover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: root,
    DOOMER_NATIVE_BINARY: resolve(candidate),
    npm_config_cache: process.env.npm_config_cache || join(root, 'npm-cache'),
    npm_config_userconfig: '/dev/null',
    npm_config_ignore_scripts: 'true',
    npm_config_offline: process.env.npm_config_offline || 'false',
    DISABLE_TELEMETRY: '1', CI: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  };
  await exec('git', ['config', '--file', env.GIT_CONFIG_GLOBAL, `url.file://${resolve(skills)}.insteadOf`, 'https://github.com/doomerlabs/skills.git'], { env, cwd: root });
  const packed = JSON.parse((await exec('npm', ['pack', packageRoot, '--ignore-scripts', '--json', '--pack-destination', root], { cwd: root, env })).stdout);
  const archive = join(root, packed[0].filename);
  const doomer = (args, { pkg = archive, binary = candidate } = {}) => exec('npx', [
    '--yes', `--package=${pkg}`, '--', 'doomer', ...args, '--json',
  ], { cwd: root, env: { ...env, DOOMER_NATIVE_BINARY: resolve(binary) }, timeout: 120000 });
  const state = join(root, '.local', 'share', 'doomer-node', 'state.json');
  return { root, archive, doomer, state, env };
}

async function setup(t, legacy) {
  const f = await installerFixture(t);
  const { root, doomer, state } = f;
  const codex = join(root, '.codex', 'hooks.json');
  const claude = join(root, '.claude', 'settings.json');
  const credentials = join(root, 'fixture-credentials');
  await mkdir(join(root, '.codex'));
  await mkdir(join(root, '.claude'));
  await mkdir(credentials);
  await writeFile(join(root, '.doomer.env'), `DOOMER_API_URL=${service}\nDOOMER_CONFIG_DIR=${credentials}\n`);
  await writeFile(codex, '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo keep"}]}]},"unrelated":true}\n');
  await writeFile(claude, '{"permissions":{"allow":["Read"],"deny":["Bash(rm *)"]}}\n');
  if (!legacy) {
    if (legacyBinary) {
      await assert.rejects(doomer(['install', '--no-hooks'], { binary: legacyBinary }), /requires a Go CLI with installer support/);
      await assert.rejects(access(state), { code: 'ENOENT' });
    }
    await assert.rejects(doomer(['install', '--agent', 'codex,claude']), error => /upload approval is required/i.test(error.stderr));
    await assert.rejects(access(state), { code: 'ENOENT' });
  }
  const before = legacy ? { pkg: resolve(legacyPackage), binary: legacyBinary } : undefined;
  const install = JSON.parse((await doomer(['install', '--agent', 'codex,claude', '--approve-uploads', '--claude-review-permission', 'allow', '--skill-source', resolve(skills)], before)).stdout);
  assert.equal(install.ready, true);
  const raw = await readFile(state, 'utf8');
  const saved = JSON.parse(raw);
  assert.equal(saved.installer, legacy ? undefined : 'go');
  assert.equal(typeof saved.runtime, legacy ? 'string' : 'undefined');
  assert.deepEqual(saved.agents, ['codex', 'claude']);
  assert.equal(saved.credentialDirs[service], credentials);
  assert.match(saved.identities[service], /^doomer_anon_/);
  assert.equal(saved.grants.length, 1);
  assert.ok(await lstat(saved.executable));
  const codexBefore = await readFile(codex, 'utf8');
  const claudeBefore = await readFile(claude, 'utf8');
  const claudeSettings = JSON.parse(claudeBefore);
  assert.ok(claudeSettings.permissions.allow.includes('Read'));
  assert.ok(claudeSettings.permissions.deny.includes('Bash(rm *)'));
  assert.ok(claudeSettings.permissions.allow.includes(`Bash(${saved.executable} watch results --control *)`));
  assert.ok(JSON.parse(codexBefore).unrelated);

  const update = JSON.parse((await doomer(['update'])).stdout);
  assert.equal(update.ready, true);
  const rawUpdated = await readFile(state, 'utf8');
  const updated = JSON.parse(rawUpdated);
  assert.equal(updated.installer, 'go');
  assert.equal(updated.executable, saved.executable);
  assert.equal(updated.credentialDirs[service], credentials);
  assert.deepEqual(updated.identities, saved.identities);
  assert.deepEqual(updated.grants, saved.grants);
  const grantBytes = raw => raw.match(/"grants":\s*(\[[\s\S]*?\])/)[1];
  assert.equal(grantBytes(rawUpdated), grantBytes(raw));
  assert.equal(await readFile(codex, 'utf8'), codexBefore);
  assert.equal(await readFile(claude, 'utf8'), claudeBefore);
  if (legacy) assert.notEqual(updated.native.sha256, saved.native.sha256);
  const diagnosis = JSON.parse((await exec(updated.executable, ['watch', 'diagnose', '--manager-home', resolve(state, '..'), '--agent', 'codex'], { cwd: root, env: { PATH: process.env.PATH, HOME: root } })).stdout);
  assert.equal(diagnosis.upload_approved, true);
  assert.equal(diagnosis.credential_directory, credentials);

  const bob = 'https://other.example/api';
  await writeFile(join(root, '.doomer.env'), `DOOMER_API_URL=${bob}\nDOOMER_CONFIG_DIR=${credentials}\n`);
  assert.equal(JSON.parse((await doomer(['update'])).stdout).uploadApproved, false);
  assert.deepEqual(JSON.parse(await readFile(state, 'utf8')).grants, saved.grants);
  await doomer(['revoke', '--api-url', service]);
  assert.deepEqual(JSON.parse(await readFile(state, 'utf8')).grants, []);
  const removed = JSON.parse((await doomer(['uninstall'])).stdout);
  assert.equal(removed.removedData, true);
  await assert.rejects(access(state), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(codex, 'utf8')).unrelated, true);
  assert.deepEqual(JSON.parse(await readFile(claude, 'utf8')).permissions.allow, ['Read']);
}

test('packed npx fresh install and update preserve approval, hooks, identity and scoped permissions', { skip, timeout: 300000 }, async t => {
  await setup(t, false);
});

test('packed npx update adopts a real legacy install without rewriting its approval or trusted hook entries', {
  skip: skip || !legacyPackage || !legacyBinary, timeout: 300000,
}, async t => {
  await setup(t, true);
});

test('interactive npx flow respects cancel and confirms service-scoped browser consent before saving it', {
  skip: skip || process.platform === 'win32', timeout: 120000,
}, async t => {
  const { root, archive, state, env, doomer } = await installerFixture(t);
  const requests = [];
  let origin;
  const token = 'adv_cli_' + 'f'.repeat(43);
  const fixture = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/auth/device/code') {
      res.end(JSON.stringify({
        device_code: 'test-device', user_code: 'TEST-CODE', interval: 1, expires_in: 20,
        verification_uri_complete: `${origin}/cli/authorize?code=TEST-CODE`,
      }));
    } else if (req.url === '/api/v1/auth/device/token') {
      res.end(JSON.stringify({ token, scope: 'reviews:upload', client_id: 'fixture-cli', expires_at: '2099-01-01T00:00:00Z' }));
    } else if (req.url === '/api/v1/auth/whoami') {
      res.end(JSON.stringify({ id: 'fixture-account' }));
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise((resolve, reject) => fixture.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  origin = `http://127.0.0.1:${fixture.address().port}`;
  const credentials = join(root, 'browser-credentials');
  const mockBin = join(root, 'mock-bin');
  await mkdir(mockBin);
  await writeFile(join(mockBin, process.platform === 'darwin' ? 'open' : 'xdg-open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(root, '.doomer.env'), `DOOMER_API_URL=${origin}/api\nDOOMER_CONFIG_DIR=${credentials}\n`);
  const doomerTTY = (responses, agentArgs = ['--agent', 'codex']) => exec('python3', ['-c', String.raw`
import collections, errno, json, os, pty, select, subprocess, sys, time
responses = collections.deque(json.loads(sys.argv[1]))
master, slave = pty.openpty()
process = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
transcript = b''
deadline = time.monotonic() + 55
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            data = os.read(master, 4096)
        except OSError as exc:
            if exc.errno != errno.EIO: raise
            break
        if not data: break
        transcript += data
        while responses and responses[0][0].encode() in transcript:
            label, reply = responses.popleft()
            os.write(master, reply.encode())
    print(transcript.decode(errors='replace'))
    if responses:
        raise SystemExit("missing terminal prompt: " + responses[0][0])
    raise SystemExit(process.wait(timeout=1))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
`, JSON.stringify(responses), 'npx', '--yes', `--package=${archive}`, '--', 'doomer',
  'install', ...agentArgs, '--skill-source', resolve(skills), '--json'], {
    env: { ...env, PATH: `${mockBin}:${env.PATH}` }, cwd: root, timeout: 65000,
  });

  const cancelled = await doomerTTY([['No, exit setup', '\x1b[B\r']]);
  assert.match(cancelled.stdout, /"status":\s*"canceled"/);
  assert.deepEqual(requests, []);
  await assert.rejects(access(state), { code: 'ENOENT' });

  const approved = await doomerTTY([
    ['No, exit setup', '\r'],
    ['Allow Codex to handle Doomer reviews?', '\r'],
  ]);
  assert.match(approved.stdout, /"ready":\s*true/);
  assert.equal(requests.filter(req => req.url === '/api/v1/auth/device/code').length, 1);
  assert.equal(requests.find(req => req.url === '/api/v1/auth/device/code').body.review_uploads, true);
  assert.ok(requests.some(req => req.url === '/api/v1/auth/whoami' && req.auth === `Bearer ${token}`));
  const before = await readFile(join(credentials, 'config.json'), 'utf8');
  const policy = await readFile(join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(policy, /Doomer repository review authorization/);
  const updated = JSON.parse((await doomer(['update'])).stdout);
  assert.equal(updated.uploadApproved, true);
  assert.equal(updated.reviewerAuthorization.policy, 'installed');
  assert.equal(await readFile(join(credentials, 'config.json'), 'utf8'), before);
  assert.equal(await readFile(join(root, '.codex', 'config.toml'), 'utf8'), policy);
  assert.equal(requests.filter(req => req.url === '/api/v1/auth/device/code').length, 1);
});

test('packed npx install verifies a release archive and activates its versioned Go binary', {
  skip: skip || !process.env.DOOMER_TEST_RELEASE_ARCHIVE, timeout: 120000,
}, async t => {
  const { root, archive, state, env } = await installerFixture(t);
  const version = metadata.doomer.cliVersion;
  const folder = join(root, 'release');
  await mkdir(folder);
  await copyFile(candidate, join(folder, 'doomer'));
  const platform = `${process.platform}_${{ x64: 'amd64', arm64: 'arm64' }[process.arch]}`;
  const asset = `doomer_${version}_${platform}.tar.gz`;
  const artifact = join(folder, asset);
  await exec('tar', ['-czf', artifact, '-C', folder, 'doomer'], { env, cwd: root });
  const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
  const shim = join(root, 'fixture-download.mjs');
  await writeFile(shim, `
import { readFile } from 'node:fs/promises';
const fetch = globalThis.fetch;
const base = 'https://downloads.doomer.ai/cli/releases/${version}/';
globalThis.fetch = async (url, options) => {
  if (String(url) === base + 'release-manifest.json') {
    return Response.json({ schemaVersion: 1, version: ${JSON.stringify(version)}, artifacts: { ${JSON.stringify(asset)}: 'sha256:${digest}' } });
  }
  if (String(url) === base + ${JSON.stringify(asset)}) {
    const bytes = await readFile(${JSON.stringify(artifact)});
    if (process.env.DOOMER_FIXTURE_BAD_ARCHIVE) bytes[0] ^= 1;
    return new Response(bytes);
  }
  return fetch(url, options);
};
`);
  const { DOOMER_NATIVE_BINARY: _local, ...releaseEnv } = env;
  const install = bad => exec('npx', [
    '--yes', `--package=${archive}`, '--', 'doomer', 'install', '--no-hooks', '--json',
  ], {
    cwd: root,
    env: { ...releaseEnv, NODE_OPTIONS: `--import=${pathToFileURL(shim).href}`, ...(bad ? { DOOMER_FIXTURE_BAD_ARCHIVE: '1' } : {}) },
    timeout: 115000,
  });
  await assert.rejects(install(true), /checksum mismatch/);
  await assert.rejects(access(state), { code: 'ENOENT' });
  const result = JSON.parse((await install(false)).stdout);
  const receipt = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(result.ready, true);
  assert.equal(receipt.native.source, 'package-pinned');
  assert.equal(receipt.native.version, version);
  assert.equal(receipt.native.path, join(root, '.local', 'bin', `doomer-${version}`));
  assert.equal(receipt.executable, result.executable);
  assert.ok((await lstat(result.executable)).isSymbolicLink());
});
