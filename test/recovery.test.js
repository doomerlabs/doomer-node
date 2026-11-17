import test from 'node:test';
import assert from 'node:assert/strict';
import { installationGuidance, setupStep, shellQuote, managerCommand } from '../src/recovery.js';
import { formatSetup, formatDoctor } from '../src/doctor.js';

const installed = () => ({ cli: true, ready: true, nativeStatus: 'available', commandInstalled: true, skill: 'installed', automaticReviews: true, onPath: true, globalCommand: '/tmp/bin/doomer', executable: '/tmp/bin/doomer', agents: ['codex'], hooks: [{ agent: 'codex', file: '/tmp/hooks.json', configured: true, enabled: true }] });

test('configured hooks do not imply upload consent or activation', () => {
  const state = installed();
  const result = installationGuidance(state, { api: 'https://service.example/api', uploadApproved: false });
  assert.equal(result.activation, 'unverified');
  assert.equal(result.reviewConfigured, false);
  assert.equal(result.issues[0].code, 'uploads_not_approved');
  assert.match(result.issues[0].command, /--api-url https:\/\/service.example\/api/);
  assert.doesNotMatch(result.issues[0].command, /--approve-uploads/);
  const approved = installationGuidance(state, { uploadApproved: true });
  assert.equal(approved.reviewConfigured, true);
  assert.equal(approved.activation, 'unverified');
  const text = formatSetup({ ...state, ...approved, codexReload: { restartRequired: true } });
  assert.match(text, /set up for Codex/);
  assert.match(text, /open \/hooks/);
  assert.match(text, /start a new session/);
  assert.match(text, /completed review confirms activation/);
});

test('repair guidance distinguishes missing hooks, disabled hooks and invalid settings', () => {
  for (const [hook, code] of [
    [{ configured: false, enabled: true }, 'hooks_missing'],
    [{ configured: true, enabled: false }, 'hooks_disabled'],
    [{ configured: false, error: 'Invalid JSON' }, 'hook_config_invalid'],
  ]) {
    const state = installed();
    state.hooks = [{ agent: 'claude', file: '/tmp/settings.json', ...hook }];
    const issue = installationGuidance(state, { uploadApproved: true }).issues[0];
    assert.equal(issue.code, code);
    if (code === 'hooks_missing') assert.match(issue.command, /install-hooks .*--agent claude/);
    else assert.equal(issue.command, undefined, 'cannot silently repair invalid JSON or grant native trust');
  }
});

test('PATH collisions preserve working installation and suggest direct invocation', () => {
  const state = { ...installed(), onPath: false, globalCommand: "/tmp/a'b/doomer" };
  const issue = installationGuidance(state, { uploadApproved: true }).issues[0];
  assert.equal(issue.code, 'command_not_on_path');
  assert.equal(issue.command, undefined);
  assert.ok(issue.instruction.includes(shellQuote(state.globalCommand)));
});

test('setup failures retain their cause and offer a resumable action', async () => {
  const cause = new Error('download unavailable');
  await assert.rejects(setupStep('Installing the Go CLI', 'npx @doomerlabs/doomer onboard', async () => { throw cause; }), error => {
    assert.equal(error.cause, cause);
    assert.equal(error.code, 'setup_failed');
    assert.equal(error.recovery.command, 'npx @doomerlabs/doomer onboard');
    assert.match(error.message, /Installing the Go CLI failed: download unavailable/);
    return true;
  });
});


test('incompatible local binaries stay user-managed instead of looping through update', () => {
  const state = { ...installed(), automaticReviews: false, ready: false };
  const local = installationGuidance(state, { uploadApproved: true, localNative: true }).issues[0];
  assert.equal(local.code, 'cli_incompatible');
  assert.equal(local.command, undefined);
  assert.match(local.instruction, /Build a current CLI yourself/);
  assert.match(local.instruction, /DOOMER_NATIVE_BINARY/);
  assert.match(local.instruction, /onboard/);
  const release = installationGuidance(state, { uploadApproved: true, localNative: false }).issues[0];
  assert.match(release.command, /doomer@beta update/);
});


test('standalone setup offers opt-in automatic reviews without granting consent or selecting an agent', () => {
  for (const uploadApproved of [false, true]) {
    const state = { ...installed(), agents: [], hooks: [] };
    const guidance = installationGuidance(state, { api: 'https://service.example/api', uploadApproved });
    const action = guidance.enableAutomaticReviews;
    assert.match(action.command, /npx @doomerlabs\/doomer@beta onboard/);
    assert.match(action.command, /--home/);
    assert.match(action.command, /--api-url https:\/\/service.example\/api/);
    assert.doesNotMatch(action.command, /--approve-uploads|--agent|--no-hooks/);
    assert.equal(guidance.activation, 'not_required');
    assert.equal(guidance.reviewConfigured, false);
    if (uploadApproved) assert.match(guidance.next, /Standalone Quick review is not supported/);
    for (const format of [formatSetup, formatDoctor]) {
      const text = format({ ...state, ...guidance }, { color: false });
      assert.ok(text.includes('Enable automatic reviews:\n' + action.command));
      assert.match(text, /review upload permission/);
      assert.doesNotMatch(text, /set up for manual reviews/);
    }
  }
  assert.equal(installationGuidance(installed(), { uploadApproved: true }).enableAutomaticReviews, undefined);
});


test('recovery commands preserve the selected installer channel', () => {
  assert.match(managerCommand('onboard'), /npx @doomerlabs\/doomer@beta onboard/);
  assert.match(managerCommand('onboard', { channel: 'latest' }), /npx @doomerlabs\/doomer onboard/);
  assert.match(managerCommand('install-hooks', { channel: 'beta' }), /npx @doomerlabs\/doomer@beta install-hooks/);
  assert.throws(() => managerCommand('onboard', { channel: 'invalid' }), /Invalid installer channel/);
});


test('reviewer diagnostics distinguish consent, installed policy and unverified activation', () => {
  for (const [state, policy, issue] of [['configured','installed',undefined], ['missing','missing_or_outdated','reviewer_policy_missing'], ['declined','declined','reviewer_policy_declined']]) {
    const result = installationGuidance({ ...installed(), codexReviewPolicy: { policies: [{state}], activation:'unverified' } }, {uploadApproved:true});
    assert.deepEqual(result.reviewerAuthorization, { uploadConsent:'approved', policy, activation:'unverified' });
    assert.equal(result.reviewConfigured, state === 'configured');
    assert.equal(result.issues[0]?.code, issue);
  }
});


test('mixed policy states preserve declines and offer repair for missing scopes',()=>{
 const result=installationGuidance({...installed(),codexReviewPolicy:{policies:[{state:'declined'},{state:'missing'}]}},{uploadApproved:true})
 assert.ok(result.issues.some(i=>i.code==='reviewer_policy_declined'&&!i.command))
 assert.ok(result.issues.some(i=>i.code==='reviewer_policy_missing'&&i.command.includes('onboard')))
 assert.equal(result.reviewerAuthorization.policy, 'missing_or_outdated')
 assert.match(result.issues.find(i=>i.code==='reviewer_policy_missing').instruction, /finding decisions, agreement flags, and repository-specific explanations/)
 assert.doesNotMatch(formatSetup({...installed(),...result}),/finding decisions and explanations approved/)
})

test('policy inspection errors do not infer missing scopes',()=>{
 const result=installationGuidance({...installed(),codexReviewPolicy:{error:'inspection failed',policies:[{state:'missing'}]}},{uploadApproved:true})
 assert.equal(result.reviewerAuthorization.policy, 'unverified')
 assert.deepEqual(result.issues.map(i=>i.code), ['reviewer_policy_unavailable'])
})


test('invalid profile diagnostics name every affected file', () => {
  const result=installationGuidance({...installed(),hooks:[{agent:'codex',file:'/default/hooks.json',error:'invalid',profiles:[{file:'/one/hooks.json',error:'one invalid'},{file:'/two/hooks.json',error:'two invalid'}]}]},{uploadApproved:true});
  const errors=result.issues.filter(i=>i.code==='hook_config_invalid');
  assert.equal(errors.length,2);
  assert.match(errors[0].instruction,/\/one\/hooks.json/);
  assert.match(errors[1].instruction,/\/two\/hooks.json/);
});


test('aggregate errors retain a diagnostic if no profile supplied an error', () => {
  const result=installationGuidance({...installed(),hooks:[{agent:'codex',file:'/default/hooks.json',error:'unreadable',profiles:[{file:'/one/hooks.json',configured:false}]}]},{uploadApproved:true});
  assert.equal(result.issues.filter(i=>i.code==='hook_config_invalid').length,1);
  assert.match(result.issues[0].message,/unreadable/);
});


test('failed policy inspection requests a diagnostic retry rather than reinstallation', () => {
  const result=installationGuidance({...installed(),codexReviewPolicy:{error:'network blocked',policies:[]}},{uploadApproved:true});
  const issue=result.issues.find(i=>i.code==='reviewer_policy_unavailable');
  assert.match(issue.command,/ doctor /);
  assert.match(issue.instruction,/unknown, not missing/);
  assert.doesNotMatch(issue.command,/onboard/);
});
