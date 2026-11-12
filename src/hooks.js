import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, entry, quote, readJSON, locked, paths, changeState } from './system.js';

export const agents = ['claude', 'codex'];
export const events = ['UserPromptSubmit', 'Stop'];
export const eventsFor = () => events;
const retiredEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const marker = '--owner=doomer-node';
export function hookFile(agent) {
  if (agent === 'claude') return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  if (agent === 'codex') return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json');
  throw new Error(`Unsupported agent ${agent}. Choose claude or codex.`);
}
export function hookCommand(agent, executable = entry) {
  if (process.platform === 'win32') {
    if (/["%\r\n]/.test(process.execPath + executable)) throw new Error('Unsupported characters in Windows installation path');
    if (/["%\r\n]/.test(paths().home)) throw new Error('Unsupported characters in state path');
    return `"${process.execPath}" "${executable}" hook --agent=${agent} ${marker} --home="${paths().home}"`;
  }
  return `${quote(process.execPath)} ${quote(executable)} hook --agent=${agent} ${marker} --home=${quote(paths().home)}`;
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
const owned = handler => typeof handler.command === 'string' && handler.command.split(/\s+/).includes(marker);

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

export function mergeHooks(config, agent, executable = entry) {
  validate(config);
  const next = structuredClone(config);
  next.hooks ??= {};
  for (const event of [...events, ...retiredEvents]) {
    const kept = (next.hooks[event] || []).map(group => ({ ...group, hooks: group.hooks.filter(h => !owned(h)) })).filter(g => g.hooks.length);
    if (retiredEvents.includes(event)) {
      if (kept.length) next.hooks[event] = kept;
      else delete next.hooks[event];
      continue;
    }
    const handler = { type: 'command', command: hookCommand(agent, executable), timeout: event === 'Stop' ? 60 : 45 };
    if (agent === 'codex') handler.statusMessage = event === 'Stop' ? 'Doomer: check review' : 'Doomer: start watcher';
    next.hooks[event] = [...kept, { hooks: [handler] }];
  }
  return next;
}
export async function installHooks(agent, executable = entry) {
  const file = hookFile(agent);
  await changeState(state => { state.hookFiles = [...new Set([...(state.hookFiles || []), file])]; });
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
export async function checkHooks(agent, executable = entry) {
  const file = hookFile(agent);
  try {
    const config = await readJSON(file, {});
    validate(config);
    const command = hookCommand(agent, executable);
    const configured = eventsFor(agent).every(event => (config.hooks?.[event] || []).some(group => (!group.matcher || group.matcher === '.*') && group.hooks.some(h => h.type === 'command' && h.command === command && h.async !== true)));
    return { agent, file, configured, enabled: config.disableAllHooks !== true, activation: 'unverified' };
  } catch (error) { return { agent, file, configured: false, error: error.message }; }
}
