import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, entry, quote, readJSON, locked, paths } from './system.js';

export const agents = ['claude', 'codex'];
export const events = ['UserPromptSubmit', 'Stop'];
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
  for (const event of events) {
    const groups = config.hooks?.[event] || [];
    if (!Array.isArray(groups) || groups.some(g => !object(g) || !Array.isArray(g.hooks) || g.hooks.some(h => !object(h)))) {
      throw new Error(`Invalid ${event} hook settings; existing configuration was not changed.`);
    }
  }
}
const owned = handler => typeof handler.command === 'string' && handler.command.split(/\s+/).includes(marker);

export function mergeHooks(config, agent, executable = entry) {
  validate(config);
  const next = structuredClone(config);
  next.hooks ??= {};
  for (const event of events) {
    const kept = (next.hooks[event] || []).map(group => ({ ...group, hooks: group.hooks.filter(h => !owned(h)) })).filter(g => g.hooks.length);
    const handler = { type: 'command', command: hookCommand(agent, executable), timeout: event === 'Stop' ? 120 : 10 };
    if (agent === 'codex') handler.statusMessage = event === 'Stop' ? 'Doomer: check review' : 'Doomer: capture baseline';
    next.hooks[event] = [...kept, { hooks: [handler] }];
  }
  return next;
}
export async function installHooks(agent, executable = entry) {
  const file = hookFile(agent);
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
    const configured = events.every(event => (config.hooks?.[event] || []).some(group => !group.matcher && group.hooks.some(h => h.type === 'command' && h.command === command && h.async !== true)));
    return { agent, file, configured, enabled: config.disableAllHooks !== true, activation: 'unverified' };
  } catch (error) { return { agent, file, configured: false, error: error.message }; }
}
