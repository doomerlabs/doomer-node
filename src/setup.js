import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { mkdir, mkdtemp, rename, rm, lstat, symlink, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { agents, hookFile, installHooks, checkHooks } from './hooks.js';
import { paths, metadata, npm, run, readState, changeState, exists, atomicWrite, locked } from './system.js';
import { endpoint } from './api.js';
import { repositoryRoot } from './snapshot.js';

export async function question(text) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive setup requires a terminal. Pass --agent claude,codex or --no-hooks.');
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(text)).trim(); } finally { reader.close(); }
}
export async function selectAgents(options) {
  if (options['no-hooks']) return [];
  let chosen = options.agent?.split(',').filter(Boolean);
  if (!chosen) {
    const saved = (await readState()).agents;
    const detected = [];
    for (const agent of agents) if (await exists(dirname(hookFile(agent)))) detected.push(agent);
    const defaults = saved.length ? saved : detected;
    const answer = await question(`Agents to set up (claude,codex or none)${defaults.length ? ` [${defaults.join(',')}]` : ''}: `);
    chosen = answer === 'none' ? [] : (answer || defaults.join(',')).split(',').map(s => s.trim()).filter(Boolean);
    if (!answer && !chosen.length) throw new Error('Choose at least one agent, or enter none.');
  }
  if (chosen.some(agent => !agents.includes(agent))) throw new Error('Supported agents: claude,codex. Use --no-hooks for standalone reviews.');
  return [...new Set(chosen)];
}

export async function installCLI({ from, version = metadata.version } = {}) {
  const p = paths();
  return locked(join(p.home, 'install'), async () => {
    const state = await readState();
    let installed = state.runtime;
    if (from || !installed || state.cliVersion !== version || !(await exists(installed))) {
      await mkdir(p.runtime, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(p.runtime, '.install-'));
      let retained = false;
      try {
        const spec = from ? resolve(from) : `${metadata.name}@${version}`;
        await npm(['install', '--prefix', temp, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--', spec], { stdio: ['inherit', 2, 2] });
        const root = join(temp, 'node_modules', '@doomerlabs', 'doomer');
        const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
        if (pkg.name !== metadata.name || (!from && pkg.version !== version)) throw new Error('Installed package identity does not match.');
        installed = join(root, 'bin', 'doomer.js');
        await run(process.execPath, [installed, '--version']);
        retained = true;
        await changeState(s => { s.runtime = installed; s.cliVersion = pkg.version; });
      } finally { if (!retained) await rm(temp, { recursive: true, force: true }); }
    }
    const bin = process.env.DOOMER_BIN_DIR || join(homedir(), '.local', 'bin');
    await mkdir(bin, { recursive: true });
    const target = join(bin, process.platform === 'win32' ? 'doomer.cmd' : 'doomer');
    if (await exists(target)) {
      if ((await lstat(target)).isDirectory()) throw new Error(`${target} is a directory; refusing to replace it.`);
    }
    if (process.platform === 'win32') {
      if (/["%\r\n]/.test(process.execPath + installed)) throw new Error('Unsupported characters in installation path.');
      await atomicWrite(target, `@echo off\r\n"${process.execPath}" "${installed}" %*\r\n`, 0o755);
    } else {
      // Replace the old executable atomically, retaining it for recovery.
      if (await exists(target)) {
        const { copyFile, readlink } = await import('node:fs/promises');
        const backup = `${target}.before-doomer-node-${Date.now()}`;
        if ((await lstat(target)).isSymbolicLink()) await symlink(await readlink(target), backup);
        else await copyFile(target, backup);
      }
      const link = join(bin, `.doomer-${process.pid}-${Date.now()}`);
      await symlink(installed, link);
      try { await rename(link, target); } finally { await rm(link, { force: true }); }
    }
    await changeState(s => { s.executable = target; });
    return { runtime: installed, executable: target, onPath: (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').includes(bin) };
  });
}

export async function installSkill(selected) {
  // npm exec launches the same official skills CLI as npx skills add; its own
  // telemetry supplies skills.sh counts. Respect the user's telemetry settings.
  const args = ['exec', '--yes', '--package=skills', '--', 'skills', 'add', 'doomerlabs/skills', '--skill', 'doomer', '--global', '--yes'];
  if (selected.length) args.push('--agent', ...selected.map(a => a === 'claude' ? 'claude-code' : a));
  else args.push('--agent', 'codex'); // Store the global skill without installing any hooks.
  await npm(args, { stdio: ['inherit', 2, 2] });
  await changeState(s => { s.skillInstalledAt = new Date().toISOString(); });
}

export async function skillPresent(selected = []) {
  const canonical = join(homedir(), '.agents', 'skills', 'doomer', 'SKILL.md');
  const groups = selected.length ? selected.map(agent => agent === 'codex'
    ? [canonical, join(dirname(hookFile(agent)), 'skills', 'doomer', 'SKILL.md')]
    : [join(dirname(hookFile(agent)), 'skills', 'doomer', 'SKILL.md')]) : [[canonical]];
  for (const locations of groups) {
    let found = false;
    for (const file of locations) {
      try { if (/^name:\s*doomer\s*$/m.test(await readFile(file, 'utf8'))) { found = true; break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!found) return false;
  }
  return true;
}

export async function configure(selected, runtime, options) {
  const installed = [];
  for (const agent of selected) installed.push(await installHooks(agent, runtime));
  await changeState(s => { s.agents = [...new Set([...s.agents, ...selected])]; s.api = endpoint(options['api-url'] || s.api); });
  if (options['approve-uploads']) {
    const repo = await repositoryRoot(options.repo);
    await grant(repo, selected, options['api-url']);
  } else if (selected.length && process.stdin.isTTY) {
    let root;
    try { root = await repositoryRoot(options.repo); } catch { /* Can onboard outside a Git repo. */ }
    if (root) {
      const answer = await question(`Allow Doomer reviews to upload source snapshots from ${root} to ${endpoint(options['api-url'] || (await readState()).api)} for these agents? [y/N] `);
      if (/^y(es)?$/i.test(answer)) await grant(root, selected, options['api-url']);
    }
  }
  return installed;
}

export async function grant(root, selected, api) {
  await changeState(s => {
    const service = endpoint(api || s.api);
    s.grants = s.grants.filter(g => !(g.repo === root && g.api === service));
    s.grants.push({ repo: root, api: service, agents: selected, approvedAt: new Date().toISOString() });
  });
}

export async function setup(options, { forceSkill = true } = {}) {
  endpoint(options['api-url'] || (await readState()).api);
  const selected = await selectAgents(options);
  const installed = await installCLI({ from: options.from });
  if (forceSkill || !await skillPresent(selected)) {
    console.error('Adding the doomer skill through the official skills CLI…');
    await installSkill(selected);
  }
  await configure(selected, installed.runtime, options);
  return { ...installed, agents: selected, ...(await doctor()) };
}

export async function doctor() {
  const state = await readState();
  const runtime = state.runtime;
  const cli = !!runtime && await exists(runtime);
  const hooks = await Promise.all(state.agents.map(agent => checkHooks(agent, runtime)));
  const skill = await skillPresent(state.agents);
  let executable = false;
  if (cli && state.executable) {
    try { executable = (await run(process.execPath, [state.executable, '--version'])).toString().trim() === state.cliVersion; }
    catch { /* Missing or replaced global command. */ }
    if (process.platform === 'win32') executable = await exists(state.executable);
  }
  return { ready: cli && executable && skill && hooks.every(h => h.configured && h.enabled), cli, version: state.cliVersion || null, executable: state.executable || null, commandInstalled: executable, skill: skill ? 'installed' : 'missing', hooks, uploadGrants: state.grants.map(({ repo, api, agents }) => ({ repo, api, agents })), next: !cli || !executable || !skill ? 'npx @doomerlabs/doomer onboard' : hooks.some(h => !h.configured) ? 'doomer install-hooks' : hooks.some(h => !h.enabled) ? 'Enable hooks in your agent settings.' : 'Review and trust the hooks in your agent; activation is not verified by installation.' };
}

export async function update(options) {
  const raw = await npm(['view', metadata.name, 'version', '--json']);
  const version = JSON.parse(raw.toString());
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid published version.');
  const result = await installCLI({ version });
  const selected = (await readState()).agents;
  await installSkill(selected);
  for (const agent of selected) await installHooks(agent, result.runtime);
  return { ...result, version, ...(await doctor()) };
}
