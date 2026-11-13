import { developmentInstall, paths } from './system.js';

export const shellQuote = value => /^[a-zA-Z0-9_./:@,=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function managerCommand(command, { agents = [], api } = {}) {
  const args = ['npx', '@doomerlabs/doomer', command, '--home', paths().home];
  if (agents.length) args.push('--agent', agents.join(','));
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
    if (hook.error) add('hook_config_invalid', `${hook.agent} settings could not be read: ${hook.error}`, null, `Fix the settings file at ${hook.file}, then run ${managerCommand('install-hooks', { agents: [hook.agent] })}.`);
    else if (!hook.configured) add('hooks_missing', `${hook.agent} hooks need repair.`, managerCommand('install-hooks', { agents: [hook.agent] }));
    else if (!hook.enabled) add('hooks_disabled', `${hook.agent} hooks are disabled in agent settings.`, null, `Enable hooks in ${hook.agent}, then review and trust Doomer in /hooks.`);
  }
  if (!uploadApproved) add('uploads_not_approved', 'Source uploads are not approved for this service. Automatic reviews will not run.', managerCommand('onboard', { agents, api }), 'Review the upload prompt and approve only if you want reviews. Declining keeps uploads off.');
  if (!result.onPath && result.commandInstalled) add('command_not_on_path', 'Your shell does not select this Doomer installation.', null, `Add ${result.globalCommand.slice(0, Math.max(result.globalCommand.lastIndexOf('/'), result.globalCommand.lastIndexOf('\\')))} to the front of PATH, or use ${shellQuote(result.globalCommand)} directly.`);
  const activation = agents.length ? 'unverified' : 'not_required';
  const next = issues.length ? `${issues[0].message} ${issues[0].command ? `Run: ${issues[0].command}. ` : ''}${issues[0].instruction || ''}`.trim()
    : agents.length ? 'Open /hooks in your agent and review and trust the Doomer hooks. Start a new session if needed, then give the agent a small coding task. A completed review verifies activation.'
    : `Run ${shellQuote(result.globalCommand)} review for a manual review. This command authorizes uploading the repository source.`;
  return { issues, uploadApproved, activation, reviewConfigured: result.ready && uploadApproved, next };
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
