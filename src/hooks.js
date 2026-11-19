import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { atomicWrite, quote, readJSON, locked, paths, nativePath, changeState, developmentInstall } from './system.js';

export const agents = ['claude', 'codex'];
export const events = ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd', 'PermissionDenied'];
export const eventsFor = agent => ['UserPromptSubmit', 'Stop', ...(agent === 'codex' ? ['Interrupt'] : ['SessionEnd', 'PermissionDenied'])];
const retiredEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const timeouts = { UserPromptSubmit: 45, Stop: 60, Interrupt: 15, SessionEnd: 15, PermissionDenied: 5 };
const marker = () => developmentInstall() ? '--owner=doomer-node-dev' : '--owner=doomer-node';
export function hookFile(agent) {
  if (agent === 'claude') return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  if (agent === 'codex') return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json');
  throw new Error(`Unsupported agent ${agent}. Choose claude or codex.`);
}
// Update existing Codex Accounts profiles as well as the invoking environment.
// Empty profiles are not enrolled merely because their directory exists.
export async function hookFiles(agent) {
  const files = [hookFile(agent)];
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

export function hookCommand(agent, executable = nativePath()) {
  if (process.platform === 'win32') {
    if (/["%\r\n]/.test(executable)) throw new Error('Unsupported characters in Windows installation path');
    if (/["%\r\n]/.test(paths().home)) throw new Error('Unsupported characters in state path');
    return `"${executable}" watch agent --agent=${agent} ${marker()} --manager-home="${paths().home}"`;
  }
  return `${quote(executable)} watch agent --agent=${agent} ${marker()} --manager-home=${quote(paths().home)}`;
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function validate(config) {
  if (!object(config) || (config.hooks !== undefined && !object(config.hooks))) throw new Error('Invalid hook settings; existing configuration was not changed.');
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
    ...agents.map(agent => join(dirname(hookFile(agent)), 'skills', 'doomer'))])];
}

export function withoutOwnedHooks(config) {
  validate(config);
  const next = structuredClone(config);
  if (!next.hooks) return next;
  for (const event of [...events, ...retiredEvents]) {
    if (!next.hooks[event]) continue;
    const kept = next.hooks[event].map(group => ({...group, hooks:group.hooks.filter(handler => !owned(handler))})).filter(group => group.hooks.length);
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
  return locked(file, async () => {
    original = await readFile(file, 'utf8');
    const config = JSON.parse(original);
    const next = withoutOwnedHooks(config);
    if (JSON.stringify(next) === JSON.stringify(config)) return false;
    await atomicWrite(`${file}.before-doomer-node-uninstall-${Date.now()}`, original);
    await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  });
}

export function mergeHooks(config, agent, executable = nativePath()) {
  validate(config);
  const next = structuredClone(config);
  next.hooks ??= {};
  for (const event of [...events, ...retiredEvents]) {
    const kept = (next.hooks[event] || []).map(group => ({ ...group, hooks: group.hooks.filter(h => !owned(h)) })).filter(g => g.hooks.length);
    if (retiredEvents.includes(event) || !eventsFor(agent).includes(event)) {
      if (kept.length) next.hooks[event] = kept;
      else delete next.hooks[event];
      continue;
    }
    const handler = { type: 'command', command: hookCommand(agent, executable), timeout: timeouts[event] };
    if (agent === 'codex') handler.statusMessage = `${developmentInstall() ? 'Doomer development' : 'Doomer'}: ${event === 'UserPromptSubmit' ? 'start watch' : 'stop watch'}`;
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
async function installHookFile(agent, executable, file) {
  await changeState(state => { delete state.hookRoot; state.hookFiles = [...new Set([...(state.hookFiles || []), file])]; });
  return locked(file, async () => {
    let original;
    try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = mergeHooks(original === undefined ? {} : JSON.parse(original), agent, executable);
    const content = `${JSON.stringify(next, null, 2)}\n`;
    if (original === content) return { agent, file, changed: false };
    if (original !== undefined) await atomicWrite(`${file}.before-doomer-node-${Date.now()}`, original);
    await atomicWrite(file, content);
    return { agent, file, changed: true };
  });
}
async function checkHookFile(agent, executable, file) {
  try {
    const config = await readJSON(file, {});
    validate(config);
    const command = hookCommand(agent, executable);
    const configured = eventsFor(agent).every(event => (config.hooks?.[event] || []).some(group => {
      const matches = event === 'PermissionDenied' ? group.matcher === 'Bash' : !group.matcher || group.matcher === '.*';
      return matches && group.hooks.some(h => h.type === 'command' && h.command === command && h.async !== true);
    }));
    return { agent, file, configured, enabled: config.disableAllHooks !== true, activation: 'unverified' };
  } catch (error) { return { agent, file, configured: false, error: error.message }; }
}

export async function installHooks(agent, executable = nativePath()) {
  const results = [];
  for (const file of await hookFiles(agent)) results.push(await installHookFile(agent, executable, file));
  return { agent, file: hookFile(agent), changed: results.some(result => result.changed), profiles: results };
}

export async function checkHooks(agent, executable = nativePath()) {
  const profiles = [];
  for (const file of await hookFiles(agent)) profiles.push(await checkHookFile(agent, executable, file));
  return { agent, file: hookFile(agent), configured: profiles.every(p => p.configured),
    enabled: profiles.every(p => p.enabled !== false), activation: 'unverified', profiles,
    ...(profiles.find(p => p.error) ? { error: profiles.find(p => p.error).error } : {}) };
}
