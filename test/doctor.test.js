import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectNativeInstallation, formatDoctor } from '../src/doctor.js';

async function installation(t) {
  const root = await mkdtemp(join(tmpdir(), 'doomer-doctor-'));
  const previous = process.env.DOOMER_BIN_DIR;
  process.env.DOOMER_BIN_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.DOOMER_BIN_DIR;
    else process.env.DOOMER_BIN_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const binary = join(root, 'doomer-dev');
  await writeFile(binary, `#!${process.execPath}\nconsole.log('doomer dev (commit new)');\n`, { mode: 0o755 });
  await symlink(binary, join(root, 'doomer'));
  return { root, binary, state: { native: { path: binary, version: 'doomer dev (commit old)' } } };
}

test('doctor accepts rebuilt binaries and reports the running version', async t => {
  const { root, state } = await installation(t);
  const result = await inspectNativeInstallation(state, { PATH: root });
  assert.equal(result.nativeVersion, 'doomer dev (commit new)');
  assert.equal(result.recordedNativeVersion, 'doomer dev (commit old)');
  assert.equal(result.nativeStatus, 'available');
  assert.equal(result.commandInstalled, true);
  assert.equal(result.onPath, true);
});

test('doctor distinguishes missing, unusable, and replaced executables', async t => {
  const { root, binary, state } = await installation(t);
  await writeFile(binary, `#!${process.execPath}\nprocess.exit(1);\n`);
  assert.equal((await inspectNativeInstallation(state, { PATH: root })).nativeStatus, 'unusable');
  await writeFile(binary, `#!${process.execPath}\nconsole.log('not the Doomer CLI');\n`);
  assert.equal((await inspectNativeInstallation(state, { PATH: root })).nativeStatus, 'unusable');
  await rm(binary);
  assert.equal((await inspectNativeInstallation(state, { PATH: root })).nativeStatus, 'missing');
  await rm(join(root, 'doomer'));
  await writeFile(join(root, 'doomer'), 'some other program', { mode: 0o755 });
  assert.equal((await inspectNativeInstallation(state, { PATH: root })).commandStatus, 'different');
});

test('doctor identifies another doomer earlier on PATH', async t => {
  const { root, state } = await installation(t);
  const other = join(root, 'other');
  await mkdir(other);
  await writeFile(join(other, 'doomer'), 'another installation', { mode: 0o755 });
  const result = await inspectNativeInstallation(state, { PATH: `${other}:${root}` });
  assert.equal(result.commandInstalled, true);
  assert.equal(result.onPath, false);
  assert.equal(result.resolvedCommand, join(other, 'doomer'));
});

test('doctor formatting labels both versions and supports plain text and color', () => {
  const result = { cli: true, ready: true, nativeStatus: 'available', nativeVersion: 'doomer dev (commit new)', recordedNativeVersion: 'old', commandStatus: 'available', globalCommand: '/bin/doomer', onPath: true, skill: 'installed', automaticReviews: true, hooks: [{ agent: 'codex', configured: true, enabled: true }], next: 'Review hook trust.' };
  const plain = formatDoctor(result, { color: false });
  assert.match(plain, /Manager/);
  assert.match(plain, /Go CLI\s+doomer dev \(commit new\)/);
  assert.match(plain, /Binary updated since installation/);
  assert.match(plain, /activation unverified/);
  assert.doesNotMatch(plain, /\u001b\[/);
  assert.match(formatDoctor(result, { color: true }), /\u001b\[/);
});
