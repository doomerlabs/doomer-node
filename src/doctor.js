import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
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
  return { native: target !== null, nativeStatus, nativeVersion, recordedNativeVersion: state.native?.version || null,
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
    row(name, configured ? 'Hooks configured; activation unverified' : hook.error || (hook.enabled === false ? 'Hooks disabled' : 'Hooks need repair'), configured ? 'ok' : 'error');
  }
  if (!result.automaticReviews) row('Watch', 'Current watch command unavailable', 'error');
  rows.push('', paint(result.ready ? 'Installation ready' : 'Installation needs attention', result.ready ? '32;1' : '33;1'));
  if (!result.onPath && result.commandInstalled) rows.push(`Add ${dirname(result.globalCommand)} to the front of PATH to use this installation.`);
  rows.push(result.next);
  return rows.join('\n');
}
