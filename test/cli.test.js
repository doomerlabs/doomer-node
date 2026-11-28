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
  for (const option of ['--base', '--wait', '--timeout', '--approve-upload', '--show-diff']) {
    await assert.rejects(exec(process.execPath, [entry, 'doctor', option, 'value']), /Unknown option/);
  }
});


test('check cannot silently mutate installations through other commands', async () => {
  for (const command of ['install', 'onboard', 'uninstall', 'revoke', 'update', 'install-hooks']) {
    await assert.rejects(exec(process.execPath, [entry, command, '--check']), /--check is supported only by upgrade/);
  }
});

test('exact CLI version is hidden and rejects unsupported use before setup', async () => {
  const { stdout } = await exec(process.execPath, [entry, '--help']);
  assert.doesNotMatch(stdout, /--cli-version/);
  for (const command of ['doctor', 'update', 'upgrade', 'install-hooks', 'uninstall']) {
    await assert.rejects(exec(process.execPath, [entry, command, '--cli-version', '2026.11.3-beta.1']), /supported only by install and onboard/);
  }
  for (const version of ['', '../main', 'https://example.test/cli', '2026.11.3-beta.1/extra']) {
    await assert.rejects(exec(process.execPath, [entry, 'install', '--cli-version', version]), /Invalid --cli-version/);
  }
  await assert.rejects(exec(process.execPath, [entry, 'install', '--cli-version', '2026.11.3-beta.1'], {
    env: { ...process.env, DOOMER_NATIVE_BINARY: '/unused/local/cli' },
  }), /cannot be combined with a local development CLI/);
});


test('reviewer decision flags fail before unrelated commands or agent setup', async () => {
  for (const command of ['doctor', 'upgrade', 'uninstall', 'update']) {
    await assert.rejects(exec(process.execPath, [entry, command, '--reviewer-policy-proposal', 'digest']), /requires a reviewer-policy decision/);
  }
  await assert.rejects(exec(process.execPath, [entry, 'onboard', '--reviewer-policy-proposal', 'digest']), /requires a reviewer-policy decision/);
  for (const selection of ['--no-hooks', '--agent=claude']) {
    await assert.rejects(exec(process.execPath, [entry, 'onboard', selection, '--reviewer-policy', 'allow', '--reviewer-policy-proposal', 'digest']), /requires selecting codex/);
  }
  assert.match((await exec(process.execPath, [entry, '--help', '--reviewer-policy', 'allow'])).stdout, /Usage:/);
  assert.match((await exec(process.execPath, [entry, '--version', '--reviewer-policy', 'allow'])).stdout, /^\d+\./);
});

test('local skill source only applies to setup and must be an absolute checkout', async () => {
  for (const command of ['doctor', 'update', 'upgrade', 'install-hooks', 'uninstall']) {
    await assert.rejects(exec(process.execPath, [entry, command, '--skill-source', '/tmp/source']), /supported only by install and onboard/);
  }
  for (const command of ['install', 'onboard']) {
    await assert.rejects(exec(process.execPath, [entry, command, '--agent', 'claude', '--skill-source', 'relative/source']), /absolute local checkout/);
  }
});


test('doctor repair flag is rejected for other commands', async () => {
  for (const command of ['install', 'update', 'uninstall']) {
    await assert.rejects(exec(process.execPath, [entry, command, '--fix']), /supported only by doctor/);
  }
});

test('Copilot checkout hooks require a compatible setup command and agent selection', async () => {
  await assert.rejects(exec(process.execPath, [entry, 'install', '--agent', 'codex,claude', '--copilot-project-hooks']), /requires selecting copilot/);
  await assert.rejects(exec(process.execPath, [entry, 'onboard', '--no-hooks', '--copilot-project-hooks']), /requires install or onboard with Copilot selected/);
  await assert.rejects(exec(process.execPath, [entry, 'update', '--copilot-project-hooks']), /requires install or onboard with Copilot selected/);
});
