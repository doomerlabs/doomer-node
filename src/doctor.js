import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { supportsWatch } from './native.js';
import { delimiter, dirname, join, basename } from 'node:path';
import { metadata, nativePath, developmentInstall, run } from './system.js';

async function executableOnPath(env, name) {
  const extensions = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = join(directory, `${name}${extension}`);
      try {
        await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if ((await stat(file)).isFile()) return file;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

export async function inspectNativeInstallation(state, env = process.env) {
  const binary = state.native?.path;
  const command = nativePath();
  let target = null;
  let nativeVersion = null;
  let nativeStatus = 'missing';
  if (binary) {
    try {
      target = await realpath(binary);
      nativeStatus = 'unusable';
      nativeVersion = (await run(binary, ['--version'], { timeout: 5000, maxBytes: 16384 })).toString().trim();
      if (/^doomer\s+\S/i.test(nativeVersion)) nativeStatus = 'available';
    } catch { /* Report missing separately from a binary that failed to run. */ }
  }
  let commandStatus = 'missing';
  try {
    const resolved = await realpath(command);
    commandStatus = target && resolved === target ? (nativeStatus === 'available' ? 'available' : 'unusable') : 'different';
  } catch { /* Includes broken symlinks. */ }
  const resolvedCommand = await executableOnPath(env, basename(command));
  let onPath = false;
  if (resolvedCommand && target) {
    try { onPath = await realpath(resolvedCommand) === target; } catch { /* Broken PATH entry. */ }
  }
  const capabilities = { watchAgentHook: commandStatus === 'available' && await supportsWatch(command) };
  return { capabilities, native: target !== null, nativeStatus, nativeVersion, recordedNativeVersion: state.native?.version || null,
    commandInstalled: commandStatus === 'available', commandStatus, globalCommand: command, resolvedCommand, onPath };
}

export function formatDoctor(result, { color = process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' } = {}) {
  const paint = (text, code) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const rows = [paint(developmentInstall() ? 'Doomer development installation' : 'Doomer installation', '1'), ''];
  const row = (label, value, status = 'ok') => {
    const [symbol, code] = status === 'ok' ? ['✓', '32'] : status === 'warning' ? ['!', '33'] : ['✗', '31'];
    rows.push(`  ${paint(symbol, code)} ${label.padEnd(12)} ${value}`);
  };
  row('Manager', `${metadata.version}${result.cli ? '' : ' — installation missing'}`, result.cli ? 'ok' : 'error');
  row('Go CLI', result.nativeStatus === 'available' ? result.nativeVersion : result.nativeStatus === 'missing' ? 'Missing' : 'Present, but could not run as Doomer', result.nativeStatus === 'available' ? 'ok' : 'error');
  if (result.nativeStatus === 'available' && result.nativeVersion !== result.recordedNativeVersion) {
    rows.push(`                 ${paint('Binary updated since installation', '2')}`);
  }
  const commandText = result.commandStatus === 'available'
    ? `${result.globalCommand}${result.onPath ? '' : ' — not selected by PATH'}`
    : result.commandStatus === 'different' ? `${result.globalCommand} — points to a different binary`
    : result.commandStatus === 'unusable' ? `${result.globalCommand} — not runnable` : `${result.globalCommand} — missing`;
  row('Command', commandText, result.commandStatus === 'available' ? (result.onPath ? 'ok' : 'warning') : 'error');
  if (!result.onPath && result.resolvedCommand) rows.push(`                 PATH selects ${result.resolvedCommand}`);
  row('Skill', result.skill, result.skill === 'installed' ? 'ok' : 'error');
  for (const hook of result.hooks) {
    const configured = hook.configured && hook.enabled;
    const name = hook.agent === 'claude' ? 'Claude Code' : 'Codex';
    for (const profile of hook.profiles || []) rows.push(`                 ${profile.file}: ${profile.error || (profile.enabled === false ? (profile.configured ? 'disabled' : 'disabled; hooks need repair') : profile.configured ? 'configured; activation unverified' : 'hooks need repair')}`);
    row(name, configured ? 'Hooks configured; activation unverified' : hook.error || (hook.enabled === false ? 'Hooks disabled' : 'Hooks need repair'), configured ? 'ok' : 'error');
  }
  if (result.hooks.some(h => h.agent === 'claude')) row('Claude review', result.claudeReviewPermission || 'unverified', result.claudeReviewPermission === 'allow' ? 'ok' : 'warning');
  if (!result.automaticReviews) row('Watch', 'Current watch command unavailable', 'error');
  if (result.reviewerAuthorization) {
    const auth = result.reviewerAuthorization;
    row('Consent', auth.uploadConsent === 'approved' ? 'Snapshots, task context, finding decisions and explanations approved' : 'Not approved', auth.uploadConsent === 'approved' ? 'ok' : 'warning');
    if (auth.policy !== 'not_required') row('Review policy', `${auth.policy}; activation ${auth.activation}`, auth.policy === 'installed' ? 'ok' : 'warning');
  }
  rows.push('', paint(result.ready ? 'Installation ready' : 'Installation needs attention', result.ready ? '32;1' : '33;1'));
  if (!result.onPath && result.commandInstalled) rows.push(`Add ${dirname(result.globalCommand)} to the front of PATH to use this installation.`);
  for (const issue of result.issues || []) {
    rows.push(`\n${issue.message}`);
    if (issue.command) rows.push(`Run: ${issue.command}`);
    if (issue.instruction) rows.push(issue.instruction);
  }
  if (!result.issues?.length) rows.push(result.next);
  if (result.enableAutomaticReviews) rows.push('', 'Enable automatic reviews:', result.enableAutomaticReviews.command, result.enableAutomaticReviews.instruction);
  return rows.join('\n');
}

export function formatSetup(result) {
  const labels = result.agents.map(agent => agent === 'claude' ? 'Claude Code' : 'Codex');
  const names = labels.join(' and ');
  const lines = [result.ready ? `Doomer is set up${names ? ` for ${names}` : ' without automatic review hooks'}.` : 'Doomer setup needs attention.'];
  const pathIssue = result.issues.find(issue => issue.code === 'command_not_on_path');
  const setupIssues = result.issues.filter(issue => issue !== pathIssue);
  for (const issue of setupIssues) {
    lines.push('', issue.message);
    if (issue.command) lines.push(`Run: ${issue.command}`);
    if (issue.instruction) lines.push(issue.instruction);
  }

  if (result.ready && result.uploadApproved && labels.length) {
    lines.push('', 'Get your first review');
    lines.push(`  1. Open the repository you want reviewed in ${labels.join(' or ')}.`);
    if (result.agents.includes('claude')) lines.push('     Claude Code: start a fresh session to load the hooks.');
    if (result.codexReload?.restartRequired) lines.push('     Codex: start a new session to load the hooks.');
    lines.push('  2. In that session, open /hooks, find Doomer, and trust its hooks.');
    lines.push('  3. Ask your agent to make a small code change. A completed review confirms setup.');
  } else if (result.ready && labels.length) {
    lines.push('', 'After approving uploads, open /hooks in your agent and trust Doomer.');
    if (result.agents.includes('claude')) lines.push('Claude Code: start a fresh session to load the hooks.');
  } else if (!labels.length && result.enableAutomaticReviews) {
    lines.push('', 'Enable automatic reviews:', result.enableAutomaticReviews.command, result.enableAutomaticReviews.instruction);
  }
  if (result.agents.includes('claude') && !['allow', 'decline'].includes(result.claudeReviewPermission)) {
    lines.push('', 'Claude may ask for permission to run Doomer review commands.');
  }
  if (pathIssue) {
    lines.push('', 'Optional for running `doomer` from your shell. The hooks already use the installed CLI path.');
    if (pathIssue.instruction) lines.push(pathIssue.instruction);
  } else if (result.ready && result.executable) {
    lines.push('', `CLI: ${result.executable}`);
  }
  return lines.join('\n');
}
