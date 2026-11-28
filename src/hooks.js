import { homedir } from 'node:os';
import { basename, join, dirname, resolve, isAbsolute } from 'node:path';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { atomicWrite, quote, readJSON, readState, locked, paths, nativePath, changeState, developmentInstall, run } from './system.js';
import { supportsCopilot } from './native.js';

export const agentLabels = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot CLI' };
export const agents = Object.keys(agentLabels);
const copilotHookFilename = 'doomer-node.json';
const copilotTimeouts = { userPromptSubmitted: 45, preToolUse: 25, postToolUse: 10, agentStop: 60, sessionEnd: 15 };
export const events = ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd', 'PermissionDenied', 'PreToolUse'];
export const eventsFor = (agent, editTargets = false) => ['UserPromptSubmit', 'Stop',
  ...(agent === 'codex' ? ['Interrupt', ...(editTargets ? ['PreToolUse'] : [])] : ['SessionEnd', 'PermissionDenied'])];
const retiredEvents = ['PostToolUse', 'PostToolUseFailure'];
const timeouts = { UserPromptSubmit: 45, Stop: 60, Interrupt: 15, SessionEnd: 15, PermissionDenied: 5, PreToolUse: 25 };
const marker = () => developmentInstall() ? '--owner=doomer-node-dev' : '--owner=doomer-node';
export function hookFile(agent) {
  if (agent === 'claude') return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  if (agent === 'codex') return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json');
  if (agent === 'copilot') return join(copilotHome(), 'hooks', copilotHookFilename);
  throw new Error(`Unsupported agent ${agent}. Choose claude, codex or copilot.`);
}

const copilotHome = () => resolve(process.env.COPILOT_HOME || join(homedir(), '.copilot'));
export const agentSkillPath = agent => join(agent === 'copilot' ? copilotHome() : dirname(hookFile(agent)), 'skills', 'doomer');
// Update existing Codex Accounts profiles as well as the invoking environment.
// Empty profiles are not enrolled merely because their directory exists.
export async function hookFiles(agent) {
  const files = [hookFile(agent)];
  if (agent === 'copilot') {
    const { hookFiles: recorded = [] } = await readState();
    const copilot = recorded.filter(file => typeof file === 'string' && isAbsolute(file) &&
      basename(file) === copilotHookFilename && basename(dirname(file)) === 'hooks');
    return copilot.length ? [...new Set(copilot)] : files;
  }
  if (agent !== 'codex') return files;
  const candidates = [join(homedir(), '.codex', 'hooks.json')];
  const root = join(homedir(), 'Library', 'Application Support', 'Codex Accounts', 'profiles');
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(join(root, entry.name, 'home', 'hooks.json'));
  }
  for (const file of candidates) {
    if (files.includes(file)) continue;
    let content;
    try {
      if (!(await lstat(file)).isFile()) continue;
      content = await readFile(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // Include malformed existing Doomer files so diagnostics report them and
    // repair refuses to overwrite them, rather than silently skipping a profile.
    if (content.includes(marker()) || content.includes('--managed-task-adapter')) files.push(file);
  }
  return files;
}

async function requireIgnoredProjectHook(file) {
  const hooks = dirname(file);
  const github = dirname(hooks);
  if (basename(hooks) !== 'hooks' || basename(github) !== '.github' || basename(file) !== copilotHookFilename) return;
  for (const path of [github, hooks, file]) {
    try {
      const info = await lstat(path);
      if (path === file ? !info.isFile() : !info.isDirectory()) throw new Error(`Copilot project hooks require local directories and a regular file: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const relative = `.github/hooks/${copilotHookFilename}`;
  for (const path of [relative, relative + '.before-doomer-node-copy']) {
    try { await run('git', ['-C', dirname(github), 'check-ignore', '--quiet', '--', path]); }
    catch { throw new Error(`Git must ignore the local Copilot hook and its backups: ${file}`); }
  }
}

export function hookCommand(agent, executable = nativePath()) {
  if (process.platform === 'win32') {
    if (/["%\r\n]/.test(executable)) throw new Error('Unsupported characters in Windows installation path');
    if (/["%\r\n]/.test(paths().home)) throw new Error('Unsupported characters in state path');
    return `"${executable}" watch agent --agent=${agent} ${marker()} --manager-home="${paths().home}"`;
  }
  return `${quote(executable)} watch agent --agent=${agent} ${marker()} --manager-home=${quote(paths().home)}`;
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function validate(config, copilot = false) {
  if (!object(config) || (config.hooks !== undefined && !object(config.hooks))) throw new Error('Invalid hook settings; existing configuration was not changed.');
  if (copilot) {
    if (config.version !== undefined && config.version !== 1) throw new Error('Unsupported Copilot hook configuration version.');
    for (const event of Object.keys(copilotTimeouts)) {
      const entries = config.hooks?.[event];
      if (entries !== undefined && (!Array.isArray(entries) || entries.some(entry => !object(entry)))) throw new Error(`Invalid ${event} Copilot hooks.`);
    }
    return;
  }
  for (const event of [...events, ...retiredEvents]) {
    const groups = config.hooks?.[event] || [];
    if (!Array.isArray(groups) || groups.some(g => !object(g) || !Array.isArray(g.hooks) || g.hooks.some(h => !object(h)))) {
      throw new Error(`Invalid ${event} hook settings; existing configuration was not changed.`);
    }
  }
}
const owned = handler => typeof handler.command === 'string' && handler.command.split(/\s+/).includes(marker());

export function globalSkillPaths() {
  return [...new Set([join(homedir(), '.agents', 'skills', 'doomer'),
    ...['claude', 'codex'].map(agentSkillPath)])];
}

export function withoutOwnedHooks(config, copilot = false) {
  validate(config, copilot);
  const next = structuredClone(config);
  if (!next.hooks) return next;
  for (const event of copilot ? Object.keys(copilotTimeouts) : [...events, ...retiredEvents]) {
    if (!next.hooks[event]) continue;
    const kept = copilot ? next.hooks[event].filter(handler => !owned(handler))
      : next.hooks[event].map(group => ({...group, hooks:group.hooks.filter(handler => !owned(handler))})).filter(group => group.hooks.length);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export async function removeHooks(file) {
  // Read first: an absent configuration is a no-op, not a directory to create.
  let original;
  try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await requireIgnoredProjectHook(file);
  return locked(file, async () => {
    original = await readFile(file, 'utf8');
    const config = JSON.parse(original);
    const next = withoutOwnedHooks(config, basename(file) === copilotHookFilename);
    if (JSON.stringify(next) === JSON.stringify(config)) return false;
    await atomicWrite(`${file}.before-doomer-node-uninstall-${Date.now()}`, original);
    await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  });
}

export function mergeHooks(config, agent, executable = nativePath(), editTargets = false) {
  if (agent === 'copilot') {
    validate(config, true);
    const next = structuredClone(config);
    next.version = 1;
    next.hooks ??= {};
    for (const [event, timeoutSec] of Object.entries(copilotTimeouts)) {
      const existing = next.hooks[event] || [];
      const position = existing.findIndex(owned);
      const entries = existing.filter(handler => !owned(handler));
      entries.splice(position < 0 ? entries.length : position, 0,
        { type: 'command', command: `${hookCommand(agent, executable)} --event=${event}`, timeoutSec });
      next.hooks[event] = entries;
    }
    return next;
  }
  validate(config);
  const next = structuredClone(config);
  next.hooks ??= {};
  for (const event of [...events, ...retiredEvents]) {
    if (event === 'PreToolUse' && editTargets === null) continue;
    const kept = (next.hooks[event] || []).map(group => ({ ...group, hooks: group.hooks.filter(h => !owned(h)) })).filter(g => g.hooks.length);
    if (!eventsFor(agent, editTargets).includes(event)) {
      if (kept.length) next.hooks[event] = kept;
      else delete next.hooks[event];
      continue;
    }
    const handler = { type: 'command', command: hookCommand(agent, executable), timeout: timeouts[event] };
    if (agent === 'codex' && event !== 'PreToolUse') handler.statusMessage = `${developmentInstall() ? 'Doomer development' : 'Doomer'}: ${event === 'UserPromptSubmit' ? 'start watch' : 'stop watch'}`;
    // Keep production before development so reinstalling either profile does
    // not change the other's positional trust key in Codex.
    const other = developmentInstall() ? '--owner=doomer-node' : '--owner=doomer-node-dev';
    const otherIndex = kept.findIndex(group => group.hooks.some(h => typeof h.command === 'string' && h.command.split(/\s+/).includes(other)));
    const index = otherIndex < 0 ? kept.length : otherIndex + (developmentInstall() ? 1 : 0);
    const group = event === 'PermissionDenied' ? { matcher: 'Bash', hooks: [handler] } : { hooks: [handler] };
    kept.splice(index, 0, group);
    next.hooks[event] = kept;
  }
  return next;
}
async function installHookFile(agent, executable, file, editTargets) {
  if (agent === 'copilot') await requireIgnoredProjectHook(file);
  await changeState(state => { delete state.hookRoot; state.hookFiles = [...new Set([...(state.hookFiles || []), file])]; });
  return locked(file, async () => {
    let original;
    try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = mergeHooks(original === undefined ? {} : JSON.parse(original), agent, executable, editTargets);
    const content = `${JSON.stringify(next, null, 2)}\n`;
    if (original === content) return { agent, file, changed: false };
    if (original !== undefined) await atomicWrite(`${file}.before-doomer-node-${Date.now()}`, original);
    await atomicWrite(file, content);
    return { agent, file, changed: true };
  });
}
async function checkHookFile(agent, executable, file, editTargets) {
  try {
    const config = await readJSON(file, {});
    validate(config, agent === 'copilot');
    const command = hookCommand(agent, executable);
    const configured = agent === 'copilot'
      ? config.version === 1 && Object.entries(copilotTimeouts).every(([event, timeoutSec]) =>
        (config.hooks?.[event] || []).some(h => h.type === 'command' && h.command === `${command} --event=${event}`
          && h.timeoutSec === timeoutSec && !h.matcher && h.async !== true))
      : eventsFor(agent, editTargets).every(event => (config.hooks?.[event] || []).some(group => {
      const matches = event === 'PermissionDenied' ? group.matcher === 'Bash' : !group.matcher || group.matcher === '.*';
      return matches && group.hooks.some(h => h.type === 'command' && h.command === command && h.async !== true);
    }));
    return { agent, file, configured, enabled: config.disableAllHooks !== true, activation: 'unverified' };
  } catch (error) { return { agent, file, configured: false, error: error.message }; }
}

// The manager also supports older pinned CLI releases that lack this hook.
async function supportsEditTargets(agent, executable) {
  if (agent !== 'codex') return false;
  try {
    const output = await run(executable, ['runtime-info'], { timeout: 5000, maxBytes: 16384 });
    return JSON.parse(output.toString()).capabilities?.watchCodexEditTargets === true;
  } catch { return null; }
}

function editTargetStatus(agent, editTargets) {
  if (agent !== 'codex') return {};
  return { editTargets: editTargets === null ? 'probe_failed' : editTargets ? 'supported' : 'unsupported' };
}

export async function installHooks(agent, executable = nativePath()) {
  if (agent === 'copilot' && !await supportsCopilot(executable)) throw new Error('GitHub Copilot hooks require a newer Doomer CLI with Copilot support.');
  const editTargets = await supportsEditTargets(agent, executable);
  const results = [];
  for (const file of await hookFiles(agent)) results.push(await installHookFile(agent, executable, file, editTargets));
  return { agent, file: results[0].file, changed: results.some(result => result.changed), profiles: results, ...editTargetStatus(agent, editTargets) };
}

export async function checkHooks(agent, executable = nativePath(), directory) {
  if (agent === 'copilot' && !await supportsCopilot(executable)) {
    return { agent, file: hookFile(agent), configured: false, activation: 'unverified',
      error: 'GitHub Copilot hooks require a newer Doomer CLI with Copilot support.' };
  }
  const editTargets = await supportsEditTargets(agent, executable);
  const profiles = [];
  let files = await hookFiles(agent);
  if (agent === 'copilot' && directory !== undefined) {
    const user = hookFile(agent);
    const repo = await run('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { timeout: 5000 }).then(out => out.toString().trim(), () => '');
    const project = repo && join(repo, '.github', 'hooks', copilotHookFilename);
    const present = file => lstat(file).then(() => true, error => error.code !== 'ENOENT');
    const projectPresent = project && (files.includes(project) || await present(project));
    const userPresent = await present(user);
    files = projectPresent ? (userPresent ? [user, project] : [project]) : [user];
  }
  for (const file of files) profiles.push(await checkHookFile(agent, executable, file, editTargets));
  if (agent === 'copilot' && directory !== undefined && profiles.filter(profile => profile.configured).length > 1) {
    return { agent, file: profiles[0].file, profiles, configured: false, activation: 'unverified', conflict: true,
      error: 'Doomer hooks are configured in both the Copilot profile and this checkout. Keep one set for this session.' };
  }
  return { agent, file: profiles[0].file, configured: profiles.every(p => p.configured),
    enabled: profiles.every(p => p.enabled !== false), activation: 'unverified', profiles, ...editTargetStatus(agent, editTargets),
    ...(profiles.find(p => p.error) ? { error: profiles.find(p => p.error).error } : {}) };
}
