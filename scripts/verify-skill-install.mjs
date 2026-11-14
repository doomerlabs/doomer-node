// Exercise the published download and real skills CLI without touching user tools.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), 'doomer-real-install-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DOOMER_|CODEX_|CLAUDE_|npm_)/i.test(name)));
Object.assign(env, {
  HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
  CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
  DOOMER_HOME: join(home, 'manager'), DOOMER_BIN_DIR: join(home, 'bin'),
});
try {
  const { stdout } = await exec(process.execPath, [resolve('bin/doomer.js'), 'install', '--agent', 'codex', '--json'], {
    cwd: process.cwd(), env, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ready, true);
  assert.equal(result.capabilities.watchAgentHook, true);
  assert.equal(result.uploadApproved, false, 'rehearsal does not grant upload permission');
  const state = JSON.parse(await readFile(join(home, 'manager', 'state.json'), 'utf8'));
  assert.equal(state.native.version, '2026.11.13.1-beta.2');
  assert.match(await readFile(join(home, '.agents/skills/doomer/SKILL.md'), 'utf8'), /^name:\s*doomer\s*$/m);
  const hooks = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'));
  assert.ok(hooks.hooks.UserPromptSubmit.some(group => group.hooks.some(hook => hook.command.includes(' watch agent '))));
  console.log('Real isolated install passed: pinned Go CLI, pinned skill and Codex hooks; no upload approval.');
} finally {
  await rm(home, { recursive: true, force: true });
}
