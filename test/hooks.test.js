import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeHooks, hookCommand, installHooks } from '../src/hooks.js';

test('hook repair is idempotent and preserves old Doomer, unrelated hooks, permissions and trust', () => {
  const original = { permissions: { deny: ['Bash(curl *)'] }, disableAllHooks: true, hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '/old/doomer agent-hook' }, { type: 'command', command: 'echo unrelated' }] }],
    PreToolUse: [{matcher:'.*',hooks:[{command:'node old hook --owner=doomer-node'},{command:'echo keep tool hook'}]}],
    PostToolUse: [{hooks:[{command:'node old hook --owner=doomer-node'}]}],
  } };
  const next = mergeHooks(original, 'claude', '/private/with space/bin/doomer.js');
  assert.deepEqual(mergeHooks(next, 'claude', '/private/with space/bin/doomer.js'), next);
  assert.deepEqual(next.permissions, original.permissions);
  assert.equal(next.disableAllHooks, true);
  assert.equal(next.hooks.Stop.length, 2);
  assert.deepEqual(next.hooks.Stop[0], original.hooks.Stop[0]);
  assert.match(hookCommand('claude', "/a/quote'/cli.js"), /'"'"'/);
  assert.equal(original.hooks.Stop.length, 1);
  const command = next.hooks.Stop[1].hooks[0].command;
  assert.match(command, /watch agent --agent=/);
  assert.match(command, /--manager-home=/);
  assert.ok(!command.includes(process.execPath));
  assert.ok(!command.includes('hook.cjs'));
  assert.deepEqual(next.hooks.PreToolUse,[{matcher:'.*',hooks:[{command:'echo keep tool hook'}]}]);
  assert.equal(next.hooks.PostToolUse,undefined);
  assert.ok(next.hooks.SessionEnd, 'Claude cleanup hook installed');
  const codex = mergeHooks({}, 'codex', '/go/doomer');
  assert.ok(codex.hooks.Interrupt, 'Codex interrupted-turn cleanup installed');
  assert.equal(codex.hooks.SessionEnd, undefined);
});

test('rejects malformed settings before changing them', () => {
  for (const config of [[], { hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [{ hooks: [null] }] } }]) assert.throws(() => mergeHooks(config, 'codex'), /Invalid/);
});

test('production and development hook slots stay stable across reinstalls', t => {
  const previous = process.env.DOOMER_DEV_INSTALL;
  t.after(() => { if (previous === undefined) delete process.env.DOOMER_DEV_INSTALL; else process.env.DOOMER_DEV_INSTALL = previous; });
  delete process.env.DOOMER_DEV_INSTALL;
  const prod = mergeHooks({}, 'codex', '/bin/doomer');
  process.env.DOOMER_DEV_INSTALL = '1';
  const both = mergeHooks(prod, 'codex', '/bin/doomer-dev');
  assert.deepEqual(both.hooks.Stop[0], prod.hooks.Stop[0]);
  assert.match(both.hooks.Stop[1].hooks[0].command, /--owner=doomer-node-dev/);
  assert.doesNotMatch(both.hooks.Stop[1].hooks[0].command, /--watch-root/);
  assert.deepEqual(mergeHooks(both, 'codex', '/bin/doomer-dev'), both);
  delete process.env.DOOMER_DEV_INSTALL;
  assert.deepEqual(mergeHooks(both, 'codex', '/bin/doomer'), both);
});


test('hooks ignore workspace overrides and remove obsolete saved roots', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doomer-stable-hooks-'));
  const names = ['HOME', 'DOOMER_HOME', 'CODEX_HOME', 'DOOMER_HOOK_ROOT', 'DOOMER_DEV_INSTALL'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(async () => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
    }
    await rm(home, { recursive: true, force: true });
  });
  Object.assign(process.env, { HOME: home, DOOMER_HOME: join(home, 'state'), CODEX_HOME: join(home, 'codex'), DOOMER_DEV_INSTALL: '0' });
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  const settings = join(process.env.CODEX_HOME, 'hooks.json');
  await writeFile(settings, JSON.stringify({ trust: 'keep', permissions: { deny: ['dangerous'] } }));
  const native = join(home, 'fake-cli');
  await writeFile(native, `#!${process.execPath}\nconsole.log('{}');\n`, { mode: 0o755 });
  process.env.DOOMER_HOOK_ROOT = join(home, 'workspace-one');
  await mkdir(process.env.DOOMER_HOME, { recursive: true });
  await writeFile(join(process.env.DOOMER_HOME, 'state.json'), JSON.stringify({ hookRoot: '/obsolete' }));
  await installHooks('codex', native);
  const original = await readFile(settings, 'utf8');
  process.env.DOOMER_HOOK_ROOT = join(home, 'workspace-two');
  assert.equal((await installHooks('codex', native)).changed, false);
  assert.equal(await readFile(settings, 'utf8'), original);
  const state = JSON.parse(await readFile(join(process.env.DOOMER_HOME, 'state.json'), 'utf8'));
  assert.equal(state.hookRoot, undefined);
  assert.equal(JSON.parse(original).trust, 'keep');
  assert.doesNotMatch(JSON.parse(original).hooks.UserPromptSubmit[0].hooks[0].command, /watch-root|workspace-one|workspace-two/);
});
