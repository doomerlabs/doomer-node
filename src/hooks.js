import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, quote, readJSON, locked, paths, nativePath, changeState, readState, developmentInstall, selectedHookRoot, run } from './system.js';

export const agents = ['claude', 'codex'];
export const events = ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'];
export const eventsFor = agent => ['UserPromptSubmit', 'Stop', agent === 'codex' ? 'Interrupt' : 'SessionEnd'];
const retiredEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const marker = () => developmentInstall() ? '--owner=doomer-node-dev' : '--owner=doomer-node';
export function hookFile(agent) {
  if (agent === 'claude') return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  if (agent === 'codex') return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json');
  throw new Error(`Unsupported agent ${agent}. Choose claude or codex.`);
}
export function hookCommand(agent, executable = nativePath(), root) {
  if (root && !isAbsolute(root)) throw new Error('DOOMER_HOOK_ROOT must be absolute.');
  if (process.platform === 'win32') {
    if (/["%\r\n]/.test(executable)) throw new Error('Unsupported characters in Windows installation path');
    if (/["%\r\n]/.test(paths().home)) throw new Error('Unsupported characters in state path');
    if (root && /["%\r\n]/.test(root)) throw new Error('Unsupported characters in Windows watch root');
    return `"${executable}" watch agent-hook --agent=${agent} ${marker()} --manager-home="${paths().home}"${root ? ` --watch-root="${root}"` : ''}`;
  }
  return `${quote(executable)} watch agent-hook --agent=${agent} ${marker()} --manager-home=${quote(paths().home)}${root ? ` --watch-root=${quote(root)}` : ''}`;
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

export function mergeHooks(config, agent, executable = nativePath(), root) {
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
    const handler = { type: 'command', command: hookCommand(agent, executable, root), timeout: event === 'Stop' ? 60 : event === 'UserPromptSubmit' ? 45 : 15 };
    if (agent === 'codex') handler.statusMessage = `${developmentInstall() ? 'Doomer development' : 'Doomer'}: ${event === 'UserPromptSubmit' ? 'start watch' : 'stop watch'}`;
    // Keep production before development so reinstalling either profile does
    // not change the other's positional trust key in Codex.
    const other = developmentInstall() ? '--owner=doomer-node' : '--owner=doomer-node-dev';
    const otherIndex = kept.findIndex(group => group.hooks.some(h => typeof h.command === 'string' && h.command.split(/\s+/).includes(other)));
    const index = otherIndex < 0 ? kept.length : otherIndex + (developmentInstall() ? 1 : 0);
    kept.splice(index, 0, { hooks: [handler] });
    next.hooks[event] = kept;
  }
  return next;
}
export async function installHooks(agent, executable = nativePath()) {
  const file = hookFile(agent);
  const state = await readState();
  const root = selectedHookRoot(state);
  if (developmentInstall() && !root) throw new Error('Development hooks require DOOMER_HOOK_ROOT pointing to your test-apps directory.');
  if (root && !(await run(executable, ['watch', 'agent-hook', '--help'])).toString().includes('--watch-root')) throw new Error('This Go CLI needs watch-root support; rebuild before installing scoped hooks.');
  await changeState(state => { if (root) state.hookRoot = root; else if (Object.hasOwn(process.env, 'DOOMER_HOOK_ROOT')) delete state.hookRoot; state.hookFiles = [...new Set([...(state.hookFiles || []), file])]; });
  return locked(file, async () => {
    let original;
    try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = mergeHooks(original === undefined ? {} : JSON.parse(original), agent, executable, root);
    const content = `${JSON.stringify(next, null, 2)}\n`;
    if (original === content) return { agent, file, changed: false };
    if (original !== undefined) await atomicWrite(`${file}.before-doomer-node-${Date.now()}`, original);
    await atomicWrite(file, content);
    return { agent, file, changed: true };
  });
}
export async function checkHooks(agent, executable = nativePath()) {
  const file = hookFile(agent);
  try {
    const config = await readJSON(file, {});
    validate(config);
    const state = await readState();
    const command = hookCommand(agent, executable, selectedHookRoot(state));
    const configured = eventsFor(agent).every(event => (config.hooks?.[event] || []).some(group => (!group.matcher || group.matcher === '.*') && group.hooks.some(h => h.type === 'command' && h.command === command && h.async !== true)));
    return { agent, file, configured, enabled: config.disableAllHooks !== true, activation: 'unverified' };
  } catch (error) { return { agent, file, configured: false, error: error.message }; }
}
