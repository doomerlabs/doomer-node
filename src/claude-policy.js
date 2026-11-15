import { isAbsolute } from 'node:path';
import { hookFile } from './hooks.js';
import { atomicWrite, locked, readJSON, readState, changeState } from './system.js';

// These commands still require an unguessable active watcher control key and
// its approved service. Never allow arbitrary Doomer, shell, or install commands.
export function claudeReviewRules(executable) {
  if (!isAbsolute(executable) || /[\s*()?\[\]{}'"`$\\\r\n]/.test(executable)) {
    throw new Error('Claude review permission requires an absolute executable path without rule metacharacters.');
  }
  return ['hypotheses', 'findings respond', 'findings ls', 'results', 'notice-ack']
    .map(command => `Bash(${executable} watch ${command} --control *)`);
}

export async function configureClaudeReviewPermission(executable, decision, ask) {
  const state = await readState();
  const previous = state.claudeReviewPermission;
  if (!decision && previous?.decision === 'decline') return previous;
  if (!decision && previous?.decision !== 'allow' && process.stdin.isTTY) {
    const rules = claudeReviewRules(executable);
    console.error(`Claude review permission allows submitting assessments, finding decisions and explanations, reading results, and acknowledging displayed advisories through the active Doomer watcher. It does not allow installation, arbitrary shell commands, or changing Claude's deny rules.\n${rules.join('\n')}`);
    const answer = await ask('Allow these Doomer review commands in Claude Code? [allow/not now/never] ');
    if (answer.toLowerCase() === 'allow') decision = 'allow';
    if (answer.toLowerCase() === 'never') decision = 'decline';
  }
  decision ||= previous?.decision;
  if (!decision) return { decision: 'unverified' };
  const file = hookFile('claude');
  const desired = decision === 'allow' ? claudeReviewRules(executable) : [];
  let owned = [];
  await locked(file, async () => {
    const config = await readJSON(file, {});
    if (!config || typeof config !== 'object' || Array.isArray(config) || (config.permissions !== undefined && (!config.permissions || typeof config.permissions !== 'object' || Array.isArray(config.permissions)))) throw new Error('Invalid Claude permission settings; no changes applied.');
    const allow = config.permissions?.allow || [];
    if (!Array.isArray(allow) || allow.some(rule => typeof rule !== 'string')) throw new Error('Invalid Claude allow rules; no changes applied.');
    const oldOwned = previous?.file === file ? previous.ownedRules || [] : [];
    const kept = allow.filter(rule => !oldOwned.includes(rule));
    owned = desired.filter(rule => !kept.includes(rule));
    const next = [...kept, ...owned];
    if (JSON.stringify(allow) !== JSON.stringify(next)) {
      config.permissions ||= {};
      if (next.length) config.permissions.allow = next;
      else delete config.permissions.allow;
      await atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
    }
  });
  const result = { decision, file, ownedRules: owned };
  await changeState(s => { s.claudeReviewPermission = result; });
  return result;
}

export async function removeClaudeReviewPermission() {
  const previous = (await readState()).claudeReviewPermission;
  if (!previous?.ownedRules?.length) return;
  if (previous.file !== hookFile('claude')) return;
  await configureClaudeReviewPermission('', 'decline');
}
