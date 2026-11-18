import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { exec } from './helpers.js';
import { detectInstalledAgents, selectAgents } from '../src/setup.js';
import { pickAgents } from '../src/agent-picker.js';

const pickerChoices = [
  { agent: 'codex', label: 'Codex' },
  { agent: 'claude', label: 'Claude Code' },
];

function openAgentPicker(t, defaults) {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  output.on('data', chunk => { transcript += chunk.toString(); });
  const selected = pickAgents(pickerChoices, defaults, { input, output });
  t.after(() => { input.destroy(); output.destroy(); });
  return {
    selected,
    press: keys => input.write(keys),
    displayed: () => transcript,
  };
}

test('the agent picker starts on Continue and confirms both defaults with Enter', { timeout: 1000 }, async t => {
  const picker = openAgentPicker(t, ['codex', 'claude']);
  assert.match(picker.displayed(), /\[✓\] Codex\s+On/);
  assert.match(picker.displayed(), /\[✓\] Claude Code\s+On/);
  assert.match(picker.displayed(), /› Continue with both agents/);
  picker.press(' ');
  assert.doesNotMatch(picker.displayed(), /Agents selected:/);
  picker.press('\r');
  assert.deepEqual(await picker.selected, ['codex', 'claude']);
});

test('Enter and Space toggle a focused agent and only Continue submits', { timeout: 1000 }, async t => {
  const picker = openAgentPicker(t, ['codex', 'claude']);
  picker.press('\x1b[A\r');
  assert.match(picker.displayed(), /› \[ \] Claude Code\s+Off/);
  assert.match(picker.displayed(), /Continue with Codex/);
  picker.press(' ');
  assert.match(picker.displayed(), /› \[✓\] Claude Code\s+On/);
  picker.press(' \x1b[B\r');
  assert.deepEqual(await picker.selected, ['codex']);
});

test('the agent picker confirms an empty selection and supports cancellation', { timeout: 1000 }, async t => {
  const empty = openAgentPicker(t, []);
  assert.match(empty.displayed(), /› Continue without agent hooks/);
  empty.press('\r');
  assert.deepEqual(await empty.selected, []);

  const canceled = openAgentPicker(t, ['codex']);
  canceled.press('\x03');
  assert.equal(await canceled.selected, null);
});

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
