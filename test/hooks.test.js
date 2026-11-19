import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeHooks, hookCommand, installHooks, withoutOwnedHooks } from '../src/hooks.js';

test('hook repair is idempotent and preserves old Doomer, unrelated hooks, permissions and trust', () => {
  const original = { permissions: { deny: ['Bash(curl *)'] }, disableAllHooks: true, hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '/old/doomer agent-hook' }, { type: 'command', command: 'echo unrelated' }] }],
    PreToolUse: [{matcher:'.*',hooks:[{command:'node old hook --owner=doomer-node'},{command:'echo keep tool hook'}]}],
    PostToolUse: [{hooks:[{command:'node old hook --owner=doomer-node'}]}],
    PermissionDenied: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo unrelated denial' }] }],
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
  assert.deepEqual(next.hooks.PermissionDenied, [...original.hooks.PermissionDenied, {
    matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 5 }],
  }]);
  assert.deepEqual(withoutOwnedHooks(next).hooks.PermissionDenied, original.hooks.PermissionDenied);
  const codex = mergeHooks({}, 'codex', '/go/doomer');
  assert.ok(codex.hooks.Interrupt, 'Codex interrupted-turn cleanup installed');
  assert.equal(codex.hooks.SessionEnd, undefined);
  assert.equal(codex.hooks.PermissionDenied, undefined);
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

test('existing account profiles are diagnosed and repaired without enrolling empty profiles', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doomer-account-profiles-'));
  const names = ['HOME', 'DOOMER_HOME', 'CODEX_HOME', 'DOOMER_DEV_INSTALL'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(async () => {
    for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
    await rm(home, {recursive:true, force:true});
  });
  Object.assign(process.env, {HOME:home, DOOMER_HOME:join(home,'state'), DOOMER_DEV_INSTALL:'0'});
  delete process.env.CODEX_HOME;
  const root = join(home, 'Library', 'Application Support', 'Codex Accounts', 'profiles');
  const profile = join(root, 'account-one', 'home', 'hooks.json');
  const empty = join(root, 'unused', 'home', 'hooks.json');
  await mkdir(join(root, 'account-one', 'home'), {recursive:true});
  await mkdir(join(root, 'unused', 'home'), {recursive:true});
  const old = {disableAllHooks:true, trust:'preserve', hooks:{Stop:[{hooks:[{type:'command',command:"'/bin/doomer' agent-hook --managed-task-adapter"},{type:'command',command:'echo unrelated'}]}]}};
  await writeFile(profile, JSON.stringify(old));
  await writeFile(empty, '{}');
  const {checkHooks} = await import('../src/hooks.js');
  const diagnosis = await checkHooks('codex', '/bin/doomer');
  assert.equal(diagnosis.configured, false);
  assert.ok(diagnosis.profiles.some(p => p.file === profile && !p.configured));
  assert.equal(await readFile(profile,'utf8'), JSON.stringify(old), 'diagnosis is read-only');
  const result = await installHooks('codex','/bin/doomer');
  assert.equal(result.profiles.length,2);
  const repaired = JSON.parse(await readFile(profile,'utf8'));
  assert.equal(repaired.disableAllHooks,true);
  assert.equal(repaired.trust,'preserve');
  assert.deepEqual(repaired.hooks.Stop[0],old.hooks.Stop[0]);
  assert.match(repaired.hooks.UserPromptSubmit[0].hooks[0].command,/watch agent/);
  assert.equal(await readFile(empty,'utf8'),'{}');
  assert.equal((await installHooks('codex','/bin/doomer')).changed,false);
  assert.equal((await checkHooks('codex','/bin/doomer')).enabled,false);
  const state = JSON.parse(await readFile(join(home,'state','state.json'),'utf8'));
  assert.ok(state.hookFiles.includes(profile));
  process.env.CODEX_HOME = join(root,'account-one','home');
  assert.equal((await installHooks('codex','/bin/doomer')).profiles.length,2,'explicit profile and default are deduplicated');
});
