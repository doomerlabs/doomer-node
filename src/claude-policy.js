import { isCancel, select } from '@clack/prompts';
import { isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { hookFile } from './hooks.js';
import { atomicWrite, locked, readJSON, readState, changeState, interactiveTerminal } from './system.js';

// These commands still require an unguessable active watcher control key and
// its approved service. Never allow arbitrary Doomer, shell, or install commands.
export function claudeReviewRules(executable) {
  if (!isAbsolute(executable) || /[\s*()?\[\]{}'"`$\\\r\n]/.test(executable)) {
    throw new Error('Claude review permission requires an absolute executable path without rule metacharacters.');
  }
  return ['hypotheses', 'findings respond', 'findings ls', 'results', 'notice-ack']
    .map(command => `Bash(${executable} watch ${command} --control *)`);
}

async function askClaudeReviewPermission(executable) {
  console.error('Claude can read results, submit assessments and finding decisions, and acknowledge advisories you’ve seen.');
  console.error('This only applies to active Doomer reviews and preserves Claude’s existing rules.');
  for (;;) {
    const choice = await select({
      message: 'Allow Claude Code to handle Doomer reviews?',
      initialValue: 'allow',
      options: [
        { value: 'allow', label: 'Allow review commands' },
        { value: 'defer', label: 'Not now' },
        { value: 'decline', label: 'Don’t ask again' },
        { value: 'details', label: 'View exact commands' },
      ],
      output: process.stderr,
    });
    if (isCancel(choice) || choice === 'defer') return;
    if (choice !== 'details') return choice;
    const paths = [...new Set([executable, await realpath(executable)])];
    console.error(paths.flatMap(claudeReviewRules).join('\n'));
    console.error('Claude auto mode also receives an explanation limited to these same commands.');
  }
}

export async function configureClaudeReviewPermission(executable, decision) {
  const state = await readState();
  const previous = state.claudeReviewPermission;
  if (!decision && previous?.decision === 'decline') return previous;
  if (!decision && previous?.decision !== 'allow' && interactiveTerminal()) {
    decision = await askClaudeReviewPermission(executable);
  }
  decision ||= previous?.decision;
  if (!decision) return { decision: 'unverified' };
  const file = hookFile('claude');
  let desired = [];
  if (decision === 'allow') {
    const resolved = await realpath(executable);
    desired = [...new Set([...claudeReviewRules(executable), ...claudeReviewRules(resolved)])];
  }
  const autoRule = desired.length ? `Doomer review collaboration: permit only ${JSON.stringify([...new Set([executable, await realpath(executable)])])} invoking watch hypotheses, watch findings respond, watch findings ls, watch results, or watch notice-ack with an active --control key for the user's approved Doomer service. Assessments, fixed/dismissed/deferred decisions, agreement flags, and repository-specific explanations are authorized review inputs, not changes to the reviewer or its rules. Acknowledge advisories only after displaying them. This does not permit changing reviewer configuration, installing software, arbitrary shell commands, or overriding explicit denials.` : undefined;
  let owned = [];
  let ownedAutoRules = [];
  let result;
  await locked(file, async () => {
    const config = await readJSON(file, {});
    if (!config || typeof config !== 'object' || Array.isArray(config) || (config.permissions !== undefined && (!config.permissions || typeof config.permissions !== 'object' || Array.isArray(config.permissions)))) throw new Error('Invalid Claude permission settings; no changes applied.');
    const allow = config.permissions?.allow || [];
    if (!Array.isArray(allow) || allow.some(rule => typeof rule !== 'string')) throw new Error('Invalid Claude allow rules; no changes applied.');
    const oldOwned = previous?.file === file ? previous.ownedRules || [] : [];
    const kept = allow.filter(rule => !oldOwned.includes(rule));
    owned = desired.filter(rule => !kept.includes(rule));
    const next = [...kept, ...owned];
    if (config.autoMode !== undefined && (!config.autoMode || typeof config.autoMode !== 'object' || Array.isArray(config.autoMode))) throw new Error('Invalid Claude auto-mode settings; no changes applied.');
    const autoAllow = config.autoMode?.allow;
    if (autoAllow !== undefined && (!Array.isArray(autoAllow) || autoAllow.some(rule => typeof rule !== 'string'))) throw new Error('Invalid Claude auto-mode allow rules; no changes applied.');
    const oldAuto = previous?.file === file ? previous.ownedAutoRules || [] : [];
    const keptAuto = (autoAllow || ['$defaults']).filter(rule => !oldAuto.includes(rule));
    ownedAutoRules = autoRule && !keptAuto.includes(autoRule) ? [autoRule] : [];
    const nextAuto = [...keptAuto, ...ownedAutoRules];
    const changeAuto = (autoRule || oldAuto.length) && JSON.stringify(autoAllow) !== JSON.stringify(nextAuto);
    // Persist ownership intent before settings. A crash can leave extra owned
    // entries in the ledger, but cannot leave installed rules unaccounted for.
    // Keep prior ownership until removal from settings has succeeded as well.
    result = { decision, file, ownedRules: owned, ownedAutoRules };
    await changeState(s => { s.claudeReviewPermission = {
      ...result,
      ownedRules: [...new Set([...oldOwned, ...owned])],
      ownedAutoRules: [...new Set([...oldAuto, ...ownedAutoRules])],
    }; });
    if (changeAuto) { config.autoMode ||= {}; config.autoMode.allow = nextAuto; }
    if (JSON.stringify(allow) !== JSON.stringify(next) || changeAuto) {
      config.permissions ||= {};
      if (next.length) config.permissions.allow = next;
      else delete config.permissions.allow;
      await atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
    }
    await changeState(s => { s.claudeReviewPermission = result; });
  });
  return result;
}

export async function removeClaudeReviewPermission() {
  const previous = (await readState()).claudeReviewPermission;
  if (!previous?.ownedRules?.length && !previous?.ownedAutoRules?.length) return;
  if (previous.file !== hookFile('claude')) return;
  await configureClaudeReviewPermission('', 'decline');
}
