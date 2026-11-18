import { readFile } from 'node:fs/promises';
import { atomicWrite, locked } from '../manager/src/system.js';

const path = '/etc/codex/hooks.json';
const managed = JSON.parse(await readFile(new URL('./codex-hooks.json', import.meta.url), 'utf8'));
await locked(path, async () => {
  let current;
  try { current = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    current = {};
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)
    || (current.hooks && (typeof current.hooks !== 'object' || Array.isArray(current.hooks)))) {
    throw new Error('Existing Codex hook configuration is invalid.');
  }
  current.hooks ??= {};
  for (const [event, groups] of Object.entries(managed.hooks)) {
    const command = groups[0].hooks[0].command;
    const existing = current.hooks[event] ?? [];
    if (!Array.isArray(existing) || existing.some(group => !Array.isArray(group?.hooks))) {
      throw new Error('Existing Codex hook configuration is invalid.');
    }
    current.hooks[event] = existing
      .map(group => ({ ...group, hooks: group.hooks.filter(hook => hook.command !== command) }))
      .filter(group => group.hooks.length)
      .concat(groups);
  }
  await atomicWrite(path, JSON.stringify(current, null, 2) + '\n', 0o644);
});
