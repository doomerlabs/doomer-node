import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { mkdir, mkdtemp, rename, rm, lstat, symlink, readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { agents, hookFile, installHooks, checkHooks } from './hooks.js';
import { paths, metadata, packageRoot, hash, npm, run, readState, changeState, exists, atomicWrite, locked } from './system.js';
import { endpoint } from './api.js';
import { uploadPrompt } from './permissions.js';

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

async function packageDigest(root) {
  const files = ['package.json', 'README.md', 'LICENSE'];
  for (const directory of ['bin', 'src']) {
    for (const name of await readdir(join(root, directory), { recursive: true })) {
      const relative = `${directory}/${name}`;
      if ((await lstat(join(root, relative))).isFile()) files.push(relative);
    }
  }
  const content = await Promise.all(files.sort().map(async name => [name, hash(await readFile(join(root, name)))]));
  return hash(JSON.stringify(content));
}

export async function installCLI({ from, version } = {}) {
  const p = paths();
  return locked(join(p.home, 'install'), async () => {
    const state = await readState();
    const desiredVersion = version || metadata.version;
    const sourceDigest = version || from ? undefined : await packageDigest(packageRoot);
    let installed = state.runtime;
    if (from || !installed || state.cliVersion !== desiredVersion || !(await exists(installed)) || (sourceDigest && state.sourceDigest !== sourceDigest)) {
      await mkdir(p.runtime, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(p.runtime, '.install-'));
      let retained = false;
      try {
        let spec = from ? resolve(from) : `${metadata.name}@${desiredVersion}`;
        if (!from && !version) {
          // Persist the exact package that is running, whether invoked from a
          // checkout, npx cache, or an installed copy. No public npm release needed.
          const packed = JSON.parse((await npm(['pack', packageRoot, '--ignore-scripts', '--json', '--pack-destination', temp])).toString());
          const filename = packed[0]?.filename;
          if (typeof filename !== 'string' || !/^[\w.-]+\.tgz$/.test(filename)) throw new Error('Invalid npm pack result.');
          spec = join(temp, filename);
        }
        await npm(['install', '--prefix', temp, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--', spec], { stdio: ['inherit', 2, 2] });
        const root = join(temp, 'node_modules', '@doomerlabs', 'doomer');
        const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
        if (pkg.name !== metadata.name || (!from && pkg.version !== desiredVersion)) throw new Error('Installed package identity does not match.');
        installed = join(root, 'bin', 'doomer.js');
        await run(process.execPath, [installed, '--version']);
        retained = true;
        const installedDigest = await packageDigest(root);
        await changeState(s => { s.runtime = installed; s.cliVersion = pkg.version; s.sourceDigest = installedDigest; });
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
    const hookLauncher = join(p.bin, 'hook.cjs');
    await atomicWrite(hookLauncher, `// Stable Doomer hook entry point. Runtime selection lives in private state.\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst { pathToFileURL } = require('node:url');\nconst state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state.json'), 'utf8'));\nimport(pathToFileURL(state.runtime).href).catch(error => { console.error(error.message); process.exitCode = 1; });\n`);
    await changeState(s => { s.hookLauncher = hookLauncher; });
    return { runtime: installed, hookLauncher, executable: target, onPath: (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').includes(bin) };
  });
}

export async function installSkill(selected) {
  // npm exec launches the same official skills CLI as npx skills add; its own
  // telemetry supplies skills.sh counts. Respect the user's telemetry settings.
  // Temporary testing source until skills PR #81 is merged.
  const args = ['exec', '--yes', '--package=skills', '--', 'skills', 'add', 'doomerlabs/skills#feat/doomer-node-skill', '--skill', 'doomer', '--global', '--yes'];
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
    await grant(options['api-url']);
  } else if (process.stdin.isTTY) {
    const state = await readState();
    const api = endpoint(options['api-url'] || state.api);
    if (!state.grants.some(g => g.scope === 'global' && g.api === api)) {
      const answer = await question(uploadPrompt(api));
      if (/^y(es)?$/i.test(answer)) await grant(api);
    }
  }
  return installed;
}

export async function grant(api) {
  await changeState(s => {
    const service = endpoint(api || s.api);
    s.grants = s.grants.filter(g => g.api !== service);
    s.grants.push({ scope: 'global', api: service, approvedAt: new Date().toISOString() });
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
  await configure(selected, installed.hookLauncher, options);
  return { ...installed, agents: selected, ...(await doctor()) };
}

export async function doctor() {
  const state = await readState();
  const runtime = state.runtime;
  const cli = !!runtime && await exists(runtime);
  const hooks = await Promise.all(state.agents.map(agent => checkHooks(agent, state.hookLauncher || runtime)));
  const skill = await skillPresent(state.agents);
  let executable = false;
  if (cli && state.executable) {
    try { executable = (await run(process.execPath, [state.executable, '--version'])).toString().trim() === state.cliVersion; }
    catch { /* Missing or replaced global command. */ }
    if (process.platform === 'win32') executable = await exists(state.executable);
  }
  return { ready: cli && executable && skill && hooks.every(h => h.configured && h.enabled), cli, version: state.cliVersion || null, executable: state.executable || null, commandInstalled: executable, skill: skill ? 'installed' : 'missing', hooks, uploadGrants: state.grants.map(({ scope, repo, api, agents }) => ({ scope: scope || 'repository', repo, api, agents })), next: !cli || !executable || !skill ? 'npx @doomerlabs/doomer onboard' : hooks.some(h => !h.configured) ? 'doomer install-hooks' : hooks.some(h => !h.enabled) ? 'Enable hooks in your agent settings.' : 'Restart your agent, then review and trust the Doomer hooks in /hooks. Configuration on disk does not verify activation.' };
}

export async function update(options) {
  const raw = await npm(['view', metadata.name, 'version', '--json']);
  const version = JSON.parse(raw.toString());
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid published version.');
  const result = await installCLI({ version });
  const selected = (await readState()).agents;
  await installSkill(selected);
  for (const agent of selected) await installHooks(agent, result.hookLauncher);
  return { ...result, version, ...(await doctor()) };
}
