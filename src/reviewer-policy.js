import { realpath } from 'node:fs/promises';
import { paths, readState, run } from './system.js';
import { resolveAPI } from './api.js';
import { dirname } from 'node:path';
import { hookFiles } from './hooks.js';

export async function inspectReviewerPolicy(executable, options = {}, execute = run) {
  const state = await readState();
  const api = resolveAPI(options['api-url'], state.api);
  if (!state.grants.some(g => g.api === api)) return { policies: [], activation: 'not_required' };
  const result = JSON.parse((await execute(executable,
    ['--api-url', api, 'watch', 'codex-policy', '--manager-home', paths().home],
    { timeout: 30000, maxBytes: 1024 * 1024, ...(options.codexHome ? { env: { ...process.env, CODEX_HOME: options.codexHome } } : {}) })).toString());
  if (!Array.isArray(result.policies)) throw new Error('Go CLI does not support Codex reviewer policy setup; upgrade the native CLI.');
  return result;
}

// The Go CLI resolves credentials and owns policy scope, merges and declines.
// Never infer reviewer authorization from upload approval or hook trust.
async function configureSingleReviewerPolicy(executable, options, ask, execute = run) {
  const inspect = () => inspectReviewerPolicy(executable, options, execute);
  let result = await inspect();
  if (options['reviewer-policy'] && result.activation === 'not_required') throw new Error('Upload consent is required before deciding a reviewer policy; no decision was applied.');
  for (const policy of result.policies) {
    if (policy.state === 'configured' || policy.state === 'declined') continue;
    let decision = options['reviewer-policy'];
    if (!decision && process.stdin.isTTY) {
      console.error(`${policy.extra_policy}\nProposed changes:\n${policy.changes.join('\n')}`);
      const answer = await ask('Install this scoped Codex reviewer policy? [allow/not now/never] ');
      if (/^allow$/i.test(answer)) decision = 'allow';
      if (/^never$/i.test(answer)) decision = 'decline';
    }
    if (!decision) continue;
    if (options['reviewer-policy']) {
      const digest = policy.install_command?.[policy.install_command.indexOf('--proposal') + 1];
      if (!digest || options['reviewer-policy-proposal'] !== digest) throw new Error('Reviewer policy changed or has not been reviewed. Display the current proposal and pass its --reviewer-policy-proposal digest with the decision.');
    }
    // Only execute commands returned for the freshly inspected scope. The Go
    // command revalidates both consent and proposal before applying a decision.
    const command = decision === 'allow' ? policy.install_command : policy.decline_command;
    if (!Array.isArray(command) || await realpath(command[0]) !== await realpath(executable)) throw new Error('Invalid reviewer policy command.');
    await execute(command[0], command.slice(1), { timeout: 30000, maxBytes: 1024 * 1024, ...(options.codexHome ? { env: { ...process.env, CODEX_HOME: options.codexHome } } : {}) });
  }
  result = await inspect();
  return { ...result, action: 'Display pending proposals in full and obtain separate policy consent. An installed file is not proof of activation; reload the running Codex server and verify an ordinary permitted Doomer operation in that session.' };
}

export async function inspectReviewerPolicies(executable, options = {}, execute = run) {
  const profiles = [];
  for (const file of await hookFiles('codex')) {
    try {
      profiles.push({ file, ...await inspectReviewerPolicy(executable, { ...options, codexHome: dirname(file) }, execute) });
    } catch (error) {
      profiles.push({ file, policies: [], activation: 'unverified', error: error.message });
    }
  }
  return { policies: profiles.flatMap(p => p.policies), profiles, activation: 'unverified',
    ...(profiles.some(p => p.error) ? { error: profiles.filter(p => p.error).map(p => `${p.file}: ${p.error}`).join('; ') } : {}) };
}

export async function configureReviewerPolicy(executable, options, ask, execute = run) {
  const files = await hookFiles('codex');
  // A supplied digest authorizes one exact proposal, not every discovered home.
  // Inspect all homes before applying any decision so a stale digest changes none.
  let targets = files;
  if (options['reviewer-policy']) {
    const inspected = await inspectReviewerPolicies(executable, options, execute);
    if (inspected.profiles.every(p => p.activation === 'not_required')) throw new Error('Upload consent is required before deciding a reviewer policy; no decision was applied.');
    targets = inspected.profiles.filter(p => !p.error && p.policies.some(policy =>
      policy.install_command?.[policy.install_command.indexOf('--proposal') + 1] === options['reviewer-policy-proposal'])).map(p => p.file);
    if (!targets.length) throw new Error([inspected.error, 'No inspected proposal matched the supplied digest. Display the current proposal and pass its --reviewer-policy-proposal digest with the decision.'].filter(Boolean).join(' '));
  }
  for (const file of targets) {
    await configureSingleReviewerPolicy(executable, { ...options, codexHome: dirname(file) }, ask, execute);
  }
  return inspectReviewerPolicies(executable, options, execute);
}
