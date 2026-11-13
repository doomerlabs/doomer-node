import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHooks, hookCommand } from '../src/hooks.js';

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
  assert.match(command, /watch agent-hook/);
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
  const prod = mergeHooks({}, 'codex', '/bin/doomer', '/workspace');
  process.env.DOOMER_DEV_INSTALL = '1';
  const both = mergeHooks(prod, 'codex', '/bin/doomer-dev', '/test-apps');
  assert.deepEqual(both.hooks.Stop[0], prod.hooks.Stop[0]);
  assert.match(both.hooks.Stop[1].hooks[0].command, /--owner=doomer-node-dev/);
  assert.match(both.hooks.Stop[1].hooks[0].command, /--watch-root='\/test-apps'/);
  assert.deepEqual(mergeHooks(both, 'codex', '/bin/doomer-dev', '/test-apps'), both);
  delete process.env.DOOMER_DEV_INSTALL;
  assert.deepEqual(mergeHooks(both, 'codex', '/bin/doomer', '/workspace'), both);
});
