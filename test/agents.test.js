import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from './helpers.js';
import { detectInstalledAgents, selectAgents } from '../src/setup.js';

test('agent detection finds runnable PATH entries, including symlinks, without running them', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doomer-agents-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin with spaces');
  await mkdir(bin);
  const extension = process.platform === 'win32' ? '.CMD' : '';
  const target = join(bin, 'actual-codex');
  await writeFile(target, 'not a runnable program: detection must not execute this', { mode: 0o755 });
  await symlink(target, join(bin, `codex${extension}`));
  const env = { PATH: [join(home, 'missing'), bin, bin].join(delimiter), PATHEXT: '.CMD' };
  assert.deepEqual(await detectInstalledAgents(env), ['codex']);
  await writeFile(join(bin, `claude${extension}`), 'do not execute this', { mode: 0o755 });
  assert.deepEqual(await detectInstalledAgents(env), ['claude', 'codex']);
});

test('agent detection excludes stale config, directories, and non-executable files', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doomer-agents-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.codex'));
  await mkdir(join(home, '.claude'));
  assert.deepEqual(await detectInstalledAgents({ PATH: '', HOME: home }), []);
  await mkdir(join(home, 'codex'));
  if (process.platform !== 'win32') await writeFile(join(home, 'claude'), 'not executable', { mode: 0o644 });
  assert.deepEqual(await detectInstalledAgents({ PATH: home, PATHEXT: '.CMD' }), []);
});

test('explicit agent selections and standalone mode bypass interactive detection', async () => {
  assert.deepEqual(await selectAgents({ agent: 'codex,claude,codex' }), ['codex', 'claude']);
  assert.deepEqual(await selectAgents({ 'no-hooks': true }), []);
  await assert.rejects(selectAgents({ agent: 'unknown' }), /Supported agents/);
});


test('noninteractive setup selects detected agents, remembers prior choices, and supports no detected agents', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'doomer-agent-defaults-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bin = join(fixture, 'bin');
  await mkdir(bin);
  const env = { ...process.env, DOOMER_HOME: fixture, DOOMER_DEV_INSTALL: '0', PATH: bin };
  delete env.NODE_TEST_CONTEXT;
  const source = new URL('../src/setup.js', import.meta.url).href;
  const code = `import { selectAgents } from '${source}'; console.log(JSON.stringify(await selectAgents({json: true})))`;
  const selected = async () => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', code], { env })).stdout);
  assert.deepEqual(await selected(), []);
  const extension = process.platform === 'win32' ? '.CMD' : '';
  await writeFile(join(bin, `claude${extension}`), '', { mode: 0o755 });
  assert.deepEqual(await selected(), ['claude']);
  await writeFile(join(fixture, 'state.json'), JSON.stringify({ agents: ['codex'] }));
  assert.deepEqual(await selected(), ['codex']);
});
