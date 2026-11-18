import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { enrollManaged, managedAgentConfig, managedCommand, parseManagedProfile } from '../src/mdm.js';

const key = 'doomer_mdm_' + 'A'.repeat(43);
const token = 'adv_cli_' + 'B'.repeat(43);
const client = { token, client_id: randomUUID(), expires_at: '2099-01-01T00:00:00Z' };
const profile = {
  ApiURL: 'https://pilot.example/api', WorkEmail: ' Jane@ACME.Example ',
  EnrollmentKey: key, Agents: ['codex', 'claude'],
  AuthorizeReviewUploads: true, AuthorizeReviewerCommands: true,
};
const input = name => async () => Buffer.from(JSON.stringify({ hook_event_name: name, session_id: 'managed-pilot' }));
const json = value => Buffer.from(JSON.stringify(value));

async function sandbox(t) {
  const home = await mkdtemp(join(tmpdir(), 'doomer-managed-test-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  return home;
}

test('first managed Codex hook performs the named exchange and installs the exact scoped policy', async t => {
  const home = await sandbox(t);
  const invocations = [];
  let configured = false;
  let enrollment = 0;
  const digest = 'd'.repeat(64);
  const readProfile = async () => profile;
  const request = async (url, options) => {
    enrollment++;
    assert.equal(url, 'https://pilot.example/api/v1/auth/mdm/enroll');
    assert.equal(options.headers.authorization, 'Bearer ' + key);
    assert.equal(options.redirect, 'error');
    const input = JSON.parse(options.body);
    assert.equal(input.email, 'jane@acme.example');
    assert.deepEqual(input.agents, ['claude', 'codex']);
    assert.match(input.installation_id, /^[a-f0-9-]{36}$/);
    return Response.json(client);
  };
  const execute = async (executable, args, options) => {
    assert.equal(executable, '/usr/local/libexec/doomer-mdm/doomer');
    invocations.push(args);
    assert.equal(options.env.DOOMER_TOKEN, undefined);
    if (args.includes('codex-policy')) {
      if (args.includes('--decision')) {
        assert.deepEqual(args.slice(-4), ['--proposal', digest, '--decision', 'allow']);
        configured = true;
      }
      return json({ policies: [configured ? { state: 'configured' } : { state: 'pending', install_command: [executable, '--proposal', digest] }] });
    }
    assert.equal(JSON.parse(options.input).session_id, 'managed-pilot');
    return json({ additionalContext: 'review ready' });
  };
  const config = { home, readProfile, request, execute, input: input('UserPromptSubmit') };
  assert.deepEqual(await managedCommand('mdm-hook', 'codex', config), { additionalContext: 'review ready' });
  assert.equal(invocations.filter(args => args.includes('agent')).length, 1);
  assert.equal(configured, true);
  assert.equal(enrollment, 1);
  const state = await readFile(join(home, 'state.json'), 'utf8');
  assert.equal(state.includes(key), false);
  assert.equal(state.includes(token), false);
  assert.equal(JSON.parse(state).grants[0].scope, 'global');
  const credentials = join(home, 'credentials', 'config.json');
  assert.equal((await stat(credentials)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(credentials, 'utf8')).auths['auth:v2:25:https://pilot.example/api:default'], client);
  assert.deepEqual(await managedCommand('mdm-hook', 'claude', { ...config, input: input('Stop') }), { additionalContext: 'review ready' });
  assert.equal(enrollment, 1);
});

test('managed denials and an unselected agent stay silent, with failure visible to IT only', async t => {
  const home = await sandbox(t);
  const logs = [];
  let enrollment = 0;
  const config = {
    home, readProfile: async () => ({ ...profile, Agents: ['claude'] }), input: input('UserPromptSubmit'),
    request: async () => { enrollment++; return Response.json({ error: 'enrollment_denied' }, { status: 403 }); },
    execute: async (executable, args) => { assert.equal(executable, '/usr/bin/logger'); logs.push(args.join(' ')); },
  };
  assert.deepEqual(await managedCommand('mdm-hook', 'codex', config), {});
  assert.equal(enrollment, 0);
  assert.deepEqual(await managedCommand('mdm-hook', 'claude', config), {});
  assert.equal(enrollment, 1);
  assert.deepEqual(logs, ['-t doomer-mdm Managed Doomer enrollment denied.']);
  await assert.rejects(readFile(join(home, 'state.json')), { code: 'ENOENT' });
  await assert.rejects(managedCommand('mdm-enroll', undefined, config), { message: 'Managed Doomer enrollment denied.' });
});

test('offline retry and renewal carry the same install ID, including after key rotation', async t => {
  const home = await sandbox(t);
  const managed = parseManagedProfile(profile);
  const observed = [];
  const now = Date.parse('2030-01-01T00:00:00Z');
  const request = async (_url, options) => {
    observed.push({ ...JSON.parse(options.body), bearer: options.headers.authorization });
    if (observed.length === 1) throw new Error('offline');
    return Response.json({ ...client, expires_at: '2030-01-01T00:20:00Z' });
  };
  await assert.rejects(enrollManaged(managed, { home, request, now }), /offline/);
  await enrollManaged(managed, { home, request, now });
  const rotated = { ...managed, key: 'doomer_mdm_' + 'R'.repeat(43) };
  await enrollManaged(rotated, { home, request, now });
  assert.equal(observed.length, 2);
  await enrollManaged(rotated, { home, request, now: now + 11 * 60 * 1000 });
  assert.equal(observed.length, 3);
  assert.equal(new Set(observed.map(request => request.installation_id)).size, 1);
  assert.equal(observed[2].bearer, 'Bearer ' + rotated.key);
  await assert.rejects(enrollManaged({ ...managed, email: 'new@acme.example' }, { home, request, now }), /assignment changed/);
});

test('generated hooks use managed command paths and only authorize the known review operations', () => {
  const codex = managedAgentConfig('codex');
  const claude = managedAgentConfig('claude');
  assert.deepEqual(Object.keys(codex.hooks), ['UserPromptSubmit', 'Stop', 'Interrupt']);
  assert.deepEqual(Object.keys(claude.hooks), ['UserPromptSubmit', 'Stop', 'SessionEnd']);
  assert.match(codex.hooks.Stop[0].hooks[0].command, /^\/usr\/local\/libexec\/doomer-mdm\/node .*mdm-hook --agent codex$/);
  assert.equal(claude.permissions.allow.length, 5);
  assert.ok(claude.permissions.allow.every(rule => rule.endsWith(' --control *)')));
  for (const permission of ['AuthorizeReviewUploads', 'AuthorizeReviewerCommands']) {
    assert.throws(() => parseManagedProfile({ ...profile, [permission]: false }), /profile is incomplete/);
  }
});

test('a first hook concurrent with launch enrollment reuses the same credential', async t => {
  const home = await sandbox(t);
  const managed = parseManagedProfile(profile);
  let exchanges = 0;
  const entering = Promise.withResolvers();
  const release = Promise.withResolvers();
  const request = async () => {
    exchanges++;
    entering.resolve();
    await release.promise;
    return Response.json(client);
  };
  const first = enrollManaged(managed, { home, request });
  await entering.promise;
  const second = enrollManaged(managed, { home, request });
  release.resolve();
  assert.deepEqual(await first, await second);
  assert.equal(exchanges, 1);
});

test('concurrent login enrollment and Codex hook install one policy before starting the watch', async t => {
  const home = await sandbox(t);
  let configured = false;
  let applied = 0;
  const entering = Promise.withResolvers();
  const release = Promise.withResolvers();
  const execute = async (executable, args) => {
    if (args.includes('codex-policy')) {
      if (args.includes('--decision')) {
        applied++;
        entering.resolve();
        await release.promise;
        configured = true;
      }
      return json({ policies: [configured ? { state: 'configured' } : { state: 'pending', install_command: [executable, '--proposal', 'd'.repeat(64)] }] });
    }
    assert.ok(configured);
    return json({ additionalContext: 'watch started' });
  };
  const config = { home, readProfile: async () => profile, request: async () => Response.json(client), execute, input: input('UserPromptSubmit') };
  const startup = managedCommand('mdm-enroll', undefined, config);
  await entering.promise;
  const hook = managedCommand('mdm-hook', 'codex', config);
  release.resolve();
  assert.equal((await startup).status, 'enrolled');
  assert.deepEqual(await hook, { additionalContext: 'watch started' });
  assert.equal(applied, 1);
});
