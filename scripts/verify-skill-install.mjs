// Exercise the published download and real skills CLI without touching user tools.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pack } from './release.mjs';
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
  const artifactDirectory = process.argv[2] ? resolve(process.argv[2]) : join(home, 'artifact');
  const evidence = process.argv[2]
    ? JSON.parse(await readFile(join(artifactDirectory, 'evidence.json'), 'utf8'))
    : (await pack(artifactDirectory)).evidence;
  const metadata = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(evidence.name, metadata.name, 'artifact package must match this checkout');
  assert.equal(evidence.version, metadata.version, 'artifact version must match this checkout');
  const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD']);
  assert.equal(evidence.commit, commit.trim(), 'artifact commit must match this checkout');
  const tarball = join(artifactDirectory, `doomerlabs-doomer-${evidence.version}.tgz`);
  const actualIntegrity = 'sha512-' + createHash('sha512').update(await readFile(tarball)).digest('base64');
  assert.equal(actualIntegrity, evidence.integrity, 'rehearse exactly the recorded npm artifact');
  const prefix = join(home, 'candidate');
  await exec('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], {
    env, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  const executable = join(prefix, 'node_modules', '@doomerlabs', 'doomer', 'bin', 'doomer.js');
  const { stdout } = await exec(process.execPath, [executable, 'install', '--agent', 'codex', '--json'], {
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
  console.log('Packed-artifact isolated install passed: pinned Go CLI, pinned skill and Codex hooks; no upload approval.');
} finally {
  await rm(home, { recursive: true, force: true });
}
