import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctorService } from '../src/doctor-service.js';
import { formatDoctor } from '../src/doctor.js';
import { entry } from '../src/system.js';
import { exec } from './helpers.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'doomer-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace', 'project');
  await mkdir(cwd, { recursive: true });
  return { root, cwd, file: join(root, 'workspace', '.doomer.env') };
}

test('doctor uses directory production routing over inherited development settings', async t => {
  const { cwd, file } = await fixture(t);
  await writeFile(file, 'DOOMER_API_URL=https://doomer.ai/api\nDOOMER_TOKEN=private-token\n');
  const result = await doctorService({ cwd, saved: 'https://saved.example/api', env: { DOOMER_API_URL: 'http://localhost:3000/api' } });
  assert.deepEqual(result, { api: 'https://doomer.ai/api', apiSource: 'directory', apiConfigFile: file });
  assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('nearest file replaces parent settings and explicit URL takes precedence', async t => {
  const { root, cwd, file } = await fixture(t);
  await writeFile(file, 'DOOMER_API_URL=https://doomer.ai/api\n');
  const nearest = join(cwd, '.doomer.env');
  await writeFile(nearest, '# Local scope\r\nDOOMER_API_URL="http://localhost:3000/api"\r\n');
  const options = { cwd, env: {}, saved: 'https://saved.example/api' };
  assert.deepEqual(await doctorService(options), { api: 'http://localhost:3000/api', apiSource: 'directory', apiConfigFile: nearest });
  assert.deepEqual(await doctorService({ ...options, explicit: 'https://override.example/api/' }), { api: 'https://override.example/api', apiSource: 'flag' });
  // Resolve the real directory before searching, just like the native watcher.
  const link = join(root, 'linked-project');
  await symlink(cwd, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await doctorService({ ...options, cwd: link })).apiConfigFile, nearest);
  await writeFile(nearest, 'DOOMER_TOKEN=\n');
  assert.deepEqual(await doctorService(options), { api: 'https://saved.example/api', apiSource: 'saved' });
  assert.deepEqual(await doctorService({ ...options, env: { DOOMER_API_URL: 'http://127.0.0.1:3000/api' } }), { api: 'http://127.0.0.1:3000/api', apiSource: 'environment' });
});

test('doctor falls back to saved settings and the default without a directory URL', async t => {
  const { cwd, file } = await fixture(t);
  await writeFile(file, 'DOOMER_PROFILE=default\n');
  assert.deepEqual(await doctorService({ cwd, env: {}, saved: 'https://saved.example/api' }), { api: 'https://saved.example/api', apiSource: 'saved' });
  assert.deepEqual(await doctorService({ cwd, env: {} }), { api: 'https://doomer.ai/api', apiSource: 'default' });
});

test('doctor treats directory values as data and fails on malformed configuration', async t => {
  const { cwd, file } = await fixture(t);
  await writeFile(file, "DOOMER_TOKEN='$(touch should-not-exist)'\n");
  assert.equal((await doctorService({ cwd, env: {} })).apiSource, 'default');
  for (const text of ['export DOOMER_API_URL=x', 'UNKNOWN=x', 'DOOMER_TOKEN=a\nDOOMER_TOKEN=b', 'DOOMER_CONFIG_DIR=$HOME/config', 'DOOMER_TOKEN="unfinished', 'DOOMER_API_URL=', 'DOOMER_API_URL=http://unsafe.example/api', '#'.repeat(65537)]) {
    await writeFile(file, text);
    await assert.rejects(doctorService({ cwd, env: {} }));
  }
});

test('doctor CLI checks consent for its displayed service and honors --api-url without changing state', async t => {
  const { root, cwd, file } = await fixture(t);
  const state = { version: 1, agents: [], api: 'https://doomer.ai/api', grants: [{ scope: 'global', api: 'https://doomer.ai/api' }] };
  const stateFile = join(root, 'state.json');
  await writeFile(stateFile, JSON.stringify(state));
  await writeFile(file, 'DOOMER_API_URL=https://doomer.ai/api\nDOOMER_TOKEN=private-token\n');
  const env = { ...process.env, DOOMER_HOME: root, DOOMER_DEV_INSTALL: '0', DOOMER_API_URL: 'http://localhost:3000/api' };
  const run = async args => {
    // This isolated fixture deliberately has no installed CLI or hooks.
    const result = await exec(process.execPath, [entry, 'doctor', ...args], { cwd, env }).catch(error => error);
    assert.ok(!result.stdout.includes('private-token'));
    return result.stdout;
  };
  const production = JSON.parse(await run(['--json']));
  assert.equal(production.api, 'https://doomer.ai/api');
  assert.equal(production.apiSource, 'directory');
  assert.equal(production.uploadApproved, true);
  assert.ok(!production.issues.some(issue => issue.code === 'uploads_not_approved'));
  const local = JSON.parse(await run(['--api-url', 'http://localhost:3000/api', '--json']));
  assert.equal(local.apiSource, 'flag');
  assert.equal(local.uploadApproved, false);
  assert.match(local.issues.find(issue => issue.code === 'uploads_not_approved').command, /--api-url http:\/\/localhost:3000\/api/);
  const human = await run([]);
  assert.match(human, /Service\s+https:\/\/doomer.ai\/api \(directory:/);
  assert.equal(await readFile(stateFile, 'utf8'), JSON.stringify(state));
  assert.equal(formatDoctor(production, { color: false }).includes(file), true);
});
