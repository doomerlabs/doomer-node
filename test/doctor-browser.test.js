import assert from 'node:assert/strict';
import test from 'node:test';
import { doctorBrowserEndpoint, sendDoctorBrowserResult } from '../src/doctor-browser.js';

test('browser Doctor uses Doomer or the exact configured service origin', t => {
  const previous = process.env.DOOMER_API_URL;
  process.env.DOOMER_API_URL = 'http://[::1]:3040/api';
  t.after(() => {
    if (previous === undefined) delete process.env.DOOMER_API_URL;
    else process.env.DOOMER_API_URL = previous;
  });
  assert.equal(doctorBrowserEndpoint('https://doomer.ai').href, 'https://doomer.ai/api/docs/doctor-session');
  assert.equal(doctorBrowserEndpoint('http://[::1]:3040').href, 'http://[::1]:3040/api/docs/doctor-session');
  assert.equal(doctorBrowserEndpoint('https://configured.example', 'https://configured.example/api').origin, 'https://configured.example');
  for (const origin of ['https://unconfigured.example', 'https://doomer.ai:8080', 'http://[::1]:3041']) {
    assert.throws(() => doctorBrowserEndpoint(origin), /service configured/);
  }
});

test('browser Doctor delivers setup and runtime codes without messages or unknown values', async t => {
  const send = t.mock.method(globalThis, 'fetch', async () => Response.json({ received: true }));
  const code = 'example.session-code';
  await sendDoctorBrowserResult('https://doomer.ai/api/docs/doctor-session', code, {
    ready: false,
    issues: [
      { code: 'installation_incomplete', message: 'local path' },
      { code: 'command_not_on_path' },
      { code: 'uploads_not_approved' },
      { code: 'cli_incompatible' },
      { code: 'unknown' },
    ],
    runtime: { report: { checks: [{ code: 'review_failed' }, { code: 'review_failed' }] } },
  });
  const { body, redirect } = send.mock.calls[0].arguments[1];
  assert.equal(redirect, 'error');
  assert.equal(JSON.parse(body).code, code);
  assert.deepEqual(JSON.parse(body).result, {
    source: 'npm',
    ready: false,
    checks: ['review_failed', 'installation_incomplete', 'command_not_on_path', 'uploads_not_approved', 'cli_incompatible'],
  });
});
