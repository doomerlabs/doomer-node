import test from 'node:test';
import assert from 'node:assert/strict';
import { exec } from './helpers.js';
import { entry } from '../src/system.js';

test('manager help exposes setup commands without the removed review interface', async () => {
  const { stdout } = await exec(process.execPath, [entry, '--help']);
  assert.match(stdout, /install-hooks/);
  assert.doesNotMatch(stdout, /review \[get ID\]|Review options:|--approve-upload\s|--base|--show-diff/);
});

test('manager rejects review commands and review-only options', async () => {
  await assert.rejects(exec(process.execPath, [entry, 'review']), /Unknown command review/);
  for (const option of ['--base', '--repo', '--wait', '--timeout', '--approve-upload', '--show-diff']) {
    await assert.rejects(exec(process.execPath, [entry, 'doctor', option, 'value']), /Unknown option/);
  }
});


test('check cannot silently mutate installations through other commands', async () => {
  for (const command of ['install', 'onboard', 'uninstall', 'revoke', 'update', 'install-hooks']) {
    await assert.rejects(exec(process.execPath, [entry, command, '--check']), /--check is supported only by upgrade/);
  }
});
