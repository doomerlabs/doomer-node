import { isCancel, select } from '@clack/prompts';
import { realpath, readFile } from 'node:fs/promises';
import { paths, readState, otherState, changeState, exists, run, interactiveTerminal } from './system.js';
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

async function askReviewerPolicy(policy, pick) {
  console.error('Codex can submit assessments and finding decisions within your saved Doomer upload approval.');
  console.error('This adds a rule to Codex’s review settings and preserves your other rules.');
  if (policy.config_path) console.error(`Settings: ${policy.config_path}`);
  for (;;) {
    const choice = await pick({
      message: 'Allow Codex to handle Doomer reviews?',
      initialValue: 'allow',
      options: [
        { value: 'allow', label: 'Allow Doomer reviews' },
        { value: 'defer', label: 'Not now' },
        { value: 'decline', label: 'Don’t ask again' },
        { value: 'details', label: 'View exact changes' },
      ],
      output: process.stderr,
    });
    if (isCancel(choice) || choice === 'defer') return;
    if (choice !== 'details') return choice;
    console.error(policy.extra_policy);
    for (const change of policy.changes) console.error(change);
  }
}

// The Go CLI resolves credentials and owns policy scope, merges and declines.
// Never infer reviewer authorization from upload approval or hook trust.
async function configureSingleReviewerPolicy(executable, options, pick = select, execute = run) {
  const inspect = () => inspectReviewerPolicy(executable, options, execute);
  let result = await inspect();
  let installedPolicy = false;
  if (options['reviewer-policy'] && result.activation === 'not_required') throw new Error('Upload consent is required before deciding a reviewer policy; no decision was applied.');
  for (const policy of result.policies) {
    if (policy.state === 'configured' || policy.state === 'declined') continue;
    let decision = options['reviewer-policy'];
    if (!decision && interactiveTerminal()) decision = await askReviewerPolicy(policy, pick);
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
    if (decision === 'allow') installedPolicy = true;
  }
  result = await inspect();
  if (result.policies.some(policy => policy.state === 'configured') && installedPolicy) {
    await changeState(state => {
      state.codexPolicies ||= [];
      for (const policy of result.policies.filter(policy => policy.state === 'configured' && policy.config_path && policy.extra_policy)) {
        if (!state.codexPolicies.some(saved => saved.configPath === policy.config_path && saved.extraPolicy === policy.extra_policy)) {
          state.codexPolicies.push({ configPath: policy.config_path, extraPolicy: policy.extra_policy });
        }
      }
    });
  }
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

export async function configureReviewerPolicy(executable, options, pick = select, execute = run) {
  const files = await hookFiles('codex');
  // A supplied digest authorizes one exact proposal, not every discovered home.
  // Inspect all homes before applying any decision so a stale digest changes none.
  let targets = files;
  if (options['reviewer-policy']) {
    const inspected = await inspectReviewerPolicies(executable, options, execute);
    if (inspected.profiles.every(p => p.activation === 'not_required')) throw new Error('Upload consent is required before deciding a reviewer policy; no decision was applied.');
    targets = inspected.profiles.filter(p => !p.error && p.policies.some(policy =>
      policy.install_command?.[policy.install_command.indexOf('--proposal') + 1] === options['reviewer-policy-proposal'])).map(p => p.file);
    if (!targets.length) throw new Error([inspected.error, 'A matching reviewed proposal is required. Display the current proposal and pass its --reviewer-policy-proposal digest with the decision.'].filter(Boolean).join(' '));
  }
  for (const file of targets) {
    await configureSingleReviewerPolicy(executable, { ...options, codexHome: dirname(file) }, pick, execute);
  }
  return inspectReviewerPolicies(executable, options, execute);
}

// Teardown uses only locally recorded scopes; it must work after logout/offline.
export async function removeReviewerPolicies(state, execute = run) {
  const files = [...new Set([...(state.hookFiles || []).filter(file => file.endsWith('hooks.json')), ...(state.codexPolicies || []).map(policy => policy.configPath.replace(/config\.toml$/, 'hooks.json')), ...await hookFiles('codex')])];
  const results = [];
  const other = await otherState();
  const otherActive = other.runtime && await exists(other.runtime);
  const shared = Object.keys(state.credentialDirs || {}).filter(service =>
    otherActive && other.credentialDirs?.[service] === state.credentialDirs[service]);
  for (const file of files) {
    const config = file.replace(/hooks\.json$/, 'config.toml');
    if (!await exists(config) || !(await readFile(config, 'utf8')).includes('Doomer repository review authorization')) continue;
    if (!state.native?.path || !await exists(state.native.path)) throw new Error('Cannot remove Codex review permissions: installed CLI is missing. Installation retained.');
    const result = JSON.parse((await execute(state.native.path,
      ['watch', 'codex-policy', '--remove', '--manager-home', paths().home, ...shared.flatMap(service => ['--preserve-service', service])],
      { timeout: 30000, maxBytes: 1024 * 1024, env: { ...process.env, CODEX_HOME: dirname(file) } })).toString());
    if (result.removed !== true) throw new Error('CLI did not confirm Codex permission cleanup. Installation retained.');
    results.push({ file: config, ...result });
  }
  return results;
}
