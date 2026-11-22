import { homedir } from 'node:os';
import { join, dirname, delimiter, isAbsolute } from 'node:path';
import { stat, access, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pickAgents } from './agent-picker.js';
import { agents, hookFile, installHooks, checkHooks } from './hooks.js';
import { paths, metadata, nativePath, run, readState, readJSON, writeJSON, exists, hasInstaller, interactiveTerminal } from './system.js';
import { doctorService } from './doctor-service.js';
import { withNativeSetup, validateCLIVersion } from './native.js';
import { inspectReviewerPolicies } from './reviewer-policy.js';
import { SKILL_SOURCE } from './skill-source.js';
import { reloadCodexHooks } from './codex.js';
import { inspectNativeInstallation, inspectRuntimeDiagnostics } from './doctor.js';
import { installationGuidance, managerCommand, setupStep } from './recovery.js';

// Look for runnable agent commands, without launching them or treating leftover
// configuration directories as proof that an agent is installed.
export async function detectInstalledAgents(env = process.env) {
  const directories = (env.PATH || '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const detected = [];
  for (const agent of agents) {
    let found = false;
    for (const directory of directories) {
      for (const extension of extensions) {
        const file = join(directory, agent + extension);
        try {
          await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
          if ((await stat(file)).isFile()) { found = true; break; }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
        }
      }
      if (found) break;
    }
    if (found) detected.push(agent);
  }
  return detected;
}

export async function selectAgents(options) {
  if (options['no-hooks']) return [];
  if (options.agent !== undefined) {
    const selected = options.agent.split(',').map(agent => agent.trim()).filter(Boolean);
    if (!selected.length || selected.some(agent => !agents.includes(agent))) throw new Error('Supported agents: claude,codex. Use --no-hooks for standalone reviews.');
    return [...new Set(selected)];
  }

  const saved = (await readState()).agents.filter(agent => agents.includes(agent));
  const detected = await detectInstalledAgents();
  const defaults = saved.length ? saved : detected;
  const label = agent => agent === 'claude' ? 'Claude Code' : 'Codex';
  if (!interactiveTerminal()) {
    if (!options.json) console.error(defaults.length
      ? `Agents: ${defaults.map(label).join(', ')} (${saved.length ? 'previous selection' : 'detected'}).`
      : 'No supported agents detected.');
    return defaults;
  }

  return pickAgents(agents.toReversed().map(agent => ({ agent, label: label(agent) })), defaults);
}

export async function skillPresent(selected = []) {
  const canonical = join(homedir(), '.agents', 'skills', 'doomer', 'SKILL.md');
  const groups = selected.length ? selected.map(agent => agent === 'codex'
    ? [canonical, join(dirname(hookFile(agent)), 'skills', 'doomer', 'SKILL.md')]
    : [join(dirname(hookFile(agent)), 'skills', 'doomer', 'SKILL.md')]) : [[canonical]];
  for (const locations of groups) {
    let found = false;
    for (const file of locations) {
      try { if (/^name:\s*doomer\s*$/m.test(await readFile(file, 'utf8'))) { found = true; break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!found) return false;
  }
  return true;
}

export async function setup(options, mode) {
  validateCLIVersion(options['cli-version']);
  if (options['skill-source'] && (!isAbsolute(options['skill-source']) || !await exists(join(options['skill-source'], 'skills', 'doomer', 'SKILL.md')))) {
    throw new Error('--skill-source must be an absolute local checkout containing skills/doomer/SKILL.md.');
  }
  if (['claude-review-permission', 'reviewer-policy'].some(key => options[key])) {
    const selected = mode === 'update' ? (await readState()).agents
      : options['no-hooks'] ? [] : options.agent?.split(',').map(agent => agent.trim());
    if (selected && options['claude-review-permission'] && !selected.includes('claude')) throw new Error('--claude-review-permission requires selecting claude.');
    if (selected && options['reviewer-policy'] && !selected.includes('codex')) throw new Error('--reviewer-policy requires selecting codex.');
  }
  const retry = managerCommand(mode, { api: options['api-url'], cliVersion: options['cli-version'] });
  const failureFile = join(paths().home, 'last-install-failure.json');
  let stage = 'native binary preparation';
  let outcome;
  try {
    outcome = await setupStep('Running the Go installer', retry, () => withNativeSetup({ version: options['cli-version'] }, async native => {
      stage = 'agent setup';
      const args = [
        'npm-setup', '--mode', mode, '--manager-home', paths().home, '--executable', nativePath(),
        '--release-version', native.version, '--release-source', native.source, '--release-sha256', native.sha256,
        '--package-version', metadata.version, '--node', process.execPath,
        '--default-skill-source', SKILL_SOURCE, '--skills-npm-option', '--package=skills',
      ];
      if (process.env.npm_execpath) args.push('--npm', process.env.npm_execpath);
      for (const key of ['agent', 'api-url', 'skill-source', 'claude-review-permission', 'reviewer-policy', 'reviewer-policy-proposal']) {
        if (options[key] !== undefined) args.push(`--${key}=${options[key]}`);
      }
      for (const key of ['no-hooks', 'approve-uploads']) if (options[key]) args.push(`--${key}`);
      if (interactiveTerminal()) args.push('--interactive');
      return JSON.parse((await run(native.path, args, { stdio: ['inherit', 'pipe', 'inherit'], maxBytes: 1024 * 1024 })).toString());
    }));
  } catch (error) {
    // Keep failure context independent of installation rollback. Persist only
    // the stage and timestamp, never raw errors or command output.
    await writeJSON(failureFile, { stage, at: new Date().toISOString() }).catch(() => {});
    throw error;
  }
  if (['configured', 'canceled'].includes(outcome.status)) await rm(failureFile, { force: true }).catch(() => {});
  if (outcome.status === 'canceled') return null;
  if (outcome.status !== 'configured') throw new Error('Go installer did not report completion.');
  const result = await doctor({ apiURL: options['api-url'] });
  if (outcome.agents.includes('codex')) result.codexReload = await reloadCodexHooks();
  return { ...result, agents: outcome.agents, version: metadata.version };
}

export async function doctor({ policy, fix = false, apiURL, repo, runtime = false, verifyAccount = true } = {}) {
  let repairs;
  if (fix) {
    repairs = [];
    const before = await readState();
    const native = await inspectNativeInstallation(before);
    if (native.capabilities.watchAgentHook) {
      for (const agent of before.agents) repairs.push(await installHooks(agent, before.executable));
    }
  }
  const installFailure = runtime
    ? await readJSON(join(paths().home, 'last-install-failure.json'), null).catch(() => null)
    : undefined;
  let state;
  try {
    state = await readState();
    if (!Array.isArray(state.agents) || !Array.isArray(state.grants)) throw new Error('Invalid installer state');
  } catch (error) {
    if (!runtime) throw error;
    const issue = { code: 'installer_state_invalid', message: `Cannot read Doomer installer state at ${paths().state}.`,
      instruction: 'Check that the state file is readable and valid. If the executable runs, use doomer doctor --no-upload for runtime checks.' };
    return { schema: 1, ready: false, cli: false, nativeStatus: 'unknown', commandStatus: 'unknown',
      globalCommand: nativePath(), skill: 'unknown', hooks: [], issues: [issue], installFailure,
      runtime: { status: 'unavailable', code: 'native_diagnostics_unavailable', message: issue.instruction } };
  }
  const cli = await hasInstaller(state);
  const inspection = await inspectNativeInstallation(state);
  const automaticReviews = inspection.capabilities.watchAgentHook;
  const hooks = await Promise.all(state.agents.map(agent => checkHooks(agent, state.executable)));
  const skill = await skillPresent(state.agents);
  const ready = cli && inspection.nativeStatus === 'available' && automaticReviews && inspection.commandInstalled && skill && hooks.every(h => h.configured && h.enabled);
  const result = { ready, cli, ...(repairs ? { repairs } : {}), ...inspection, automaticReviews, version: state.cliVersion || null,
    claudeReviewPermission: state.claudeReviewPermission?.decision || 'unverified',
    executable: state.executable || null, skill: skill ? 'installed' : 'missing', hooks,
    uploadGrants: state.grants.map(({ scope, repo, api, agents }) => ({ scope: scope || 'repository', repo, api, agents })) };
  if (runtime) {
    result.schema = 1;
    result.runtime = await inspectRuntimeDiagnostics(state, inspection, repo);
    result.installFailure = installFailure;
  }
  let service;
  try { service = await doctorService({ explicit: apiURL, saved: state.api, cwd: repo }); }
  catch (error) {
    const issue = { code: 'service_config_invalid', message: error.message, instruction: 'Fix the service URL or nearest .doomer.env, then run doctor again. No upload authorization was verified.' };
    return { ...result, ready: false, uploadApproved: false, reviewConfigured: false,
      issues: [issue], next: `${issue.message} ${issue.instruction}`,
      reviewerAuthorization: { uploadConsent: 'unverified', policy: 'unverified', activation: 'unverified' } };
  }
  const { api, credentialDirectory: _credentialDirectory, ...routing } = service;
  // Inspect the current policy without applying decisions. Account verification
  // may require the service; report actual failures instead of inventing a missing policy.
  if (policy) result.codexReviewPolicy = policy;
  else if (verifyAccount && state.agents.includes('codex') && state.grants.some(g => g.api === api)) {
    result.codexReviewPolicy = await inspectReviewerPolicies(state.executable, { 'api-url': api, cwd: repo });
  }
  return { ...result, api, ...routing, ...installationGuidance(result, { api, localNative: state.native?.source === 'local', uploadApproved: state.grants.some(g => g.scope === 'global' && g.api === api) }) };
}
