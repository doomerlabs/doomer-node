import { developmentInstall, paths, metadata } from './system.js';

export const shellQuote = value => /^[a-zA-Z0-9_./:@,=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function managerCommand(command, { agents = [], api, cliVersion, channel = metadata.version.includes('-beta.') ? 'beta' : 'latest' } = {}) {
  if (!['latest', 'beta'].includes(channel)) throw new Error('Invalid installer channel.');
  const args = ['npx', channel === 'beta' ? '@doomerlabs/doomer@beta' : '@doomerlabs/doomer', command, '--home', paths().home];
  if (agents.length) args.push('--agent', agents.join(','));
  if (cliVersion) args.push('--cli-version', cliVersion);
  if (api) args.push('--api-url', api);
  return `${developmentInstall() ? 'DOOMER_DEV_INSTALL=1 ' : ''}${args.map(shellQuote).join(' ')}`;
}

// Configuration, upload consent and native hook trust are separate decisions.
// A disk inspection cannot attest that a running agent has activated its hooks.
export function installationGuidance(result, { api, uploadApproved, localNative = false }) {
  const agents = result.hooks.map(h => h.agent);
  const issues = [];
  const add = (code, message, command, instruction) => issues.push({ code, message, ...(command ? { command } : {}), ...(instruction ? { instruction } : {}) });
  if (!result.cli || result.nativeStatus !== 'available' || !result.commandInstalled || result.skill !== 'installed') {
    add('installation_incomplete', 'The CLI or skill is missing or cannot run.', managerCommand('onboard', { agents, api }));
  } else if (agents.length && !result.automaticReviews) {
    if (developmentInstall() || localNative) {
      add('cli_incompatible', 'This local CLI does not support automatic review hooks.', null, `Build a current CLI yourself, set DOOMER_NATIVE_BINARY to that executable, then run ${managerCommand('onboard', { agents, api })}. The manager does not build development binaries.`);
    } else add('cli_incompatible', 'This CLI does not support automatic review hooks.', managerCommand('update'));
  }
  for (const hook of result.hooks) {
    if (hook.error) {
      const failures = (hook.profiles || []).filter(p => p.error);
      if (!failures.length) failures.push(hook);
      for (const profile of failures) add('hook_config_invalid', `${hook.agent} settings could not be read at ${profile.file}: ${profile.error}`, null, `Fix the settings file at ${profile.file}, then run ${managerCommand('install-hooks', { agents: [hook.agent] })}.`);
    }
    else if (!hook.configured) add('hooks_missing', `${hook.agent} hooks need repair in ${(hook.profiles || [hook]).filter(p => !p.configured).map(p => p.file).join(', ')}.`, managerCommand('install-hooks', { agents: [hook.agent] }));
    else if (!hook.enabled) add('hooks_disabled', `${hook.agent} hooks are disabled in agent settings.`, null, `Enable hooks in ${hook.agent}, then review and trust Doomer in /hooks.`);
  }
  if (result.codexReviewPolicy?.error) add('reviewer_policy_unavailable', result.codexReviewPolicy.error, managerCommand('onboard', { agents, api }));
  else if (result.codexReviewPolicy?.policies.some(p => p.state === 'declined')) {
    add('reviewer_policy_declined', 'Codex reviewer authorization was declined.', null, 'The saved decline is preserved. Revisit that decision explicitly before enabling automatic review authorization.');
  }
  if (!result.codexReviewPolicy?.error && result.codexReviewPolicy?.policies.some(p => !['configured', 'declined'].includes(p.state))) {
    add('reviewer_policy_missing', 'Codex reviewer authorization needs a separate decision.', managerCommand('onboard', { agents, api }), 'Display and review the returned policy for finding decisions, agreement flags, and repository-specific explanations before accepting it. Upload consent and hook trust remain separate.');
  }
  if (!uploadApproved) add('uploads_not_approved', 'Source uploads are not approved for this service. Automatic reviews will not run.', managerCommand('onboard', { agents, api }), 'Review the upload prompt and approve only if you want reviews. Declining keeps uploads off.');
  if (!result.onPath && result.commandInstalled) add('command_not_on_path', 'Your shell does not select this Doomer installation.', null, `Add ${result.globalCommand.slice(0, Math.max(result.globalCommand.lastIndexOf('/'), result.globalCommand.lastIndexOf('\\')))} to the front of PATH, or use ${shellQuote(result.globalCommand)} directly.`);
  const activation = agents.length ? 'unverified' : 'not_required';
  const next = issues.length ? `${issues[0].message} ${issues[0].command ? `Run: ${issues[0].command}. ` : ''}${issues[0].instruction || ''}`.trim()
    : agents.length ? 'Open /hooks in your agent and review and trust the Doomer hooks. Start a new session if needed, then give the agent a small coding task. A completed review verifies activation.'
    : 'Standalone Quick review is not supported. Configure a coding-agent hook to enable Quick review.';
  const enableAutomaticReviews = agents.length ? undefined : {
    command: managerCommand('onboard', { api }),
    instruction: 'Choose Codex, Claude Code, or both, review upload permission, then review and trust the hooks in your agent.',
  };
  const policyStates = result.codexReviewPolicy?.policies.map(p => p.state) || [];
  const reviewerAuthorization = {
    uploadConsent: uploadApproved ? 'approved' : 'not_approved',
    policy: !agents.includes('codex') ? 'not_required'
      : result.codexReviewPolicy?.error ? 'unverified'
      : policyStates.length && policyStates.every(state => state === 'configured') ? 'installed'
      : policyStates.some(state => !['configured', 'declined'].includes(state)) ? 'missing_or_outdated'
      : policyStates.includes('declined') ? 'declined' : 'unverified',
    activation: agents.includes('codex') ? 'unverified' : 'not_required',
  };
  return { issues, uploadApproved, activation, reviewerAuthorization, reviewConfigured: agents.length > 0 && result.ready && uploadApproved && !issues.some(i => i.code.startsWith('reviewer_policy_')), next, enableAutomaticReviews };
}

export class SetupError extends Error {
  constructor(step, cause, command) {
    super(`${step} failed: ${cause.message}`, { cause });
    this.code = 'setup_failed';
    this.recovery = { message: 'Fix the reported problem, then rerun setup. Completed steps can be reused.', command };
  }
}

export async function setupStep(step, command, action) {
  try { return await action(); }
  catch (error) { throw new SetupError(step, error, command); }
}
