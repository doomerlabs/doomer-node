import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname, delimiter, isAbsolute } from 'node:path';
import { mkdir, mkdtemp, rm, lstat, stat, access, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { agents, hookFile, installHooks, checkHooks, globalSkillPaths } from './hooks.js';
import { paths, developmentInstall, selectedHookRoot, metadata, packageRoot, hash, npm, run, readState, changeState, exists, atomicWrite, locked } from './system.js';
import { resolveAPI } from './api.js';
import { uploadPrompt, acceptsUploadAnswer } from './permissions.js';
import { installNative } from './native.js';
import { reloadCodexHooks } from './codex.js';
import { inspectNativeInstallation } from './doctor.js';
import { SKILL_SOURCE } from './skill-source.js';
import { installationGuidance, managerCommand, setupStep } from './recovery.js';

export async function question(text) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive setup requires a terminal. Pass --agent claude,codex or --no-hooks.');
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(text)).trim(); } finally { reader.close(); }
}
// Look for runnable agent commands, without launching them or treating leftover
// configuration directories as proof that an agent is installed.
export async function detectInstalledAgents(env = process.env) {
  const directories = (env.PATH || '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const detected = [];
  for (const agent of agents) {
    let found = false;
    for (const directory of directories) {
      for (const extension of extensions) {
        const file = join(directory, agent + extension);
        try {
          await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
          if ((await stat(file)).isFile()) { found = true; break; }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
        }
      }
      if (found) break;
    }
    if (found) detected.push(agent);
  }
  return detected;
}

export async function selectAgents(options) {
  if (options['no-hooks']) return [];
  let chosen = options.agent?.split(',').filter(Boolean);
  if (!chosen) {
    const saved = (await readState()).agents;
    const detected = await detectInstalledAgents();
    const defaults = saved.length ? saved : detected;
    const detection = `Detected agents: ${detected.length ? detected.join(',') : 'none on PATH'}.`;
    const previous = saved.length ? `\nPrevious selection: ${saved.map(agent => detected.includes(agent) ? agent : `${agent} (not detected)`).join(',')}.` : '';
    const answer = await question(`${detection}${previous}\nAgents to set up (claude,codex or none)${defaults.length ? ` [${defaults.join(',')}]` : ''}: `);
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
    const hookLauncher = join(p.bin, 'hook.cjs');
    await atomicWrite(hookLauncher, `// Stable Doomer hook entry point. Runtime selection lives in private state.\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst { pathToFileURL } = require('node:url');\nconst state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state.json'), 'utf8'));\nimport(pathToFileURL(state.runtime).href).catch(error => { console.error(error.message); process.exitCode = 1; });\n`);
    await changeState(s => { s.hookLauncher = hookLauncher; });
    return { runtime: installed, hookLauncher };
  });
}

export async function installSkill(selected) {
  // npm exec launches the same official skills CLI as npx skills add; its own
  // telemetry supplies skills.sh counts. Respect the user's telemetry settings.
  const args = ['exec', '--yes', '--package=skills', '--', 'skills', 'add', SKILL_SOURCE, '--skill', 'doomer', '--global', '--yes'];
  if (selected.length) args.push('--agent', ...selected.map(a => a === 'claude' ? 'claude-code' : a));
  else args.push('--agent', 'codex'); // Store the global skill without installing any hooks.
  await npm(args, { stdio: ['inherit', 2, 2] });
  await changeState(s => { s.skillInstalledAt = new Date().toISOString(); s.skillPaths=[...new Set([...(s.skillPaths||[]),...globalSkillPaths()])]; });
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
  if (Object.hasOwn(process.env, 'DOOMER_HOOK_ROOT')) {
    await changeState(s => { if (process.env.DOOMER_HOOK_ROOT) s.hookRoot = process.env.DOOMER_HOOK_ROOT; else delete s.hookRoot; });
  }
  for (const agent of selected) installed.push(await installHooks(agent, runtime));
  await changeState(s => { s.agents = [...new Set([...s.agents, ...selected])]; s.api = resolveAPI(options['api-url'], s.api); });
  if (options['approve-uploads']) {
    await grant(options['api-url']);
  } else if (process.stdin.isTTY) {
    const state = await readState();
    const api = resolveAPI(options['api-url'], state.api);
    if (!state.grants.some(g => g.scope === 'global' && g.api === api)) {
      const answer = await question(uploadPrompt(api));
      if (acceptsUploadAnswer(answer)) await grant(api);
    }
  }
  await changeState(s => {
    const service = resolveAPI(options['api-url'], s.api);
    if (s.grants.some(g => g.api === service)) {
      s.identities ??= {};
      s.identities[service] ||= `doomer_anon_${randomBytes(32).toString('base64url')}`;
      if (process.env.DOOMER_CONFIG_DIR) {
        s.credentialDirs ??= {};
        s.credentialDirs[service] = resolve(process.env.DOOMER_CONFIG_DIR);
      }
    }
  });
  return installed;
}

export async function grant(api) {
  await changeState(s => {
    const service = resolveAPI(api, s.api);
    s.grants = s.grants.filter(g => g.api !== service);
    s.grants.push({ scope: 'global', api: service, approvedAt: new Date().toISOString() });
    s.identities ??= {};
    s.identities[service] ||= `doomer_anon_${randomBytes(32).toString('base64url')}`;
    if (process.env.DOOMER_CONFIG_DIR) {
      s.credentialDirs ??= {};
      s.credentialDirs[service] = resolve(process.env.DOOMER_CONFIG_DIR);
    }
  });
}

export async function setup(options, { forceSkill = true } = {}) {
  resolveAPI(options['api-url'], (await readState()).api);
  const selected = await selectAgents(options);
  if (developmentInstall() && !process.env.DOOMER_NATIVE_BINARY) throw new Error('Development installation requires DOOMER_NATIVE_BINARY.');
  const hookRoot = selectedHookRoot(await readState());
  if (developmentInstall() && selected.length && !hookRoot) throw new Error('Development hooks require DOOMER_HOOK_ROOT pointing to your test-apps directory.');
  if (hookRoot && selected.length) {
    if (!isAbsolute(hookRoot) || !(await stat(hookRoot).catch(() => null))?.isDirectory()) throw new Error('DOOMER_HOOK_ROOT must be an existing absolute directory. Set DOOMER_HOOK_ROOT to a new directory, or to an empty value to clear the saved scope.');
    if (process.env.DOOMER_HOOK_ROOT) process.env.DOOMER_HOOK_ROOT = await realpath(hookRoot);
  }
  await rm(join(paths().home,'uninstalling.json'),{force:true});
  const retry = managerCommand('onboard', { agents: selected, api: options['api-url'] });
  const installed = await setupStep('Installing the manager', retry, () => installCLI({ from: options.from }));
  const native = await setupStep('Installing the Go CLI', retry, () => installNative());
  if (forceSkill || !await skillPresent(selected)) {
    console.error('Adding the doomer skill through the official skills CLI…');
    await setupStep('Installing the skill', retry, () => installSkill(selected));
  }
  if (selected.length && !native.watch) throw new Error('The Go CLI needs the current watch command. Build the current Go branch and rerun with DOOMER_NATIVE_BINARY.');
  await setupStep('Configuring agent hooks', retry, () => configure(selected, native.executable, options));
  const result = { ...installed, ...native, agents: selected, ...(await doctor()) };
  if(selected.includes('codex')) {
    result.codexReload=await reloadCodexHooks();

  }
  return result;
}

export async function doctor() {
  const state = await readState();
  const runtime = state.runtime;
  const cli = !!runtime && await exists(runtime);
  const inspection = await inspectNativeInstallation(state);
  const automaticReviews = inspection.capabilities.watchAgentHook;
  const hooks = await Promise.all(state.agents.map(agent => checkHooks(agent, state.executable)));
  const skill = await skillPresent(state.agents);
  const ready = cli && inspection.nativeStatus === 'available' && automaticReviews && inspection.commandInstalled && skill && hooks.every(h => h.configured && h.enabled);
  const result = { ready, cli, ...inspection, automaticReviews, version: state.cliVersion || null,
    executable: state.executable || null, skill: skill ? 'installed' : 'missing', hooks,
    uploadGrants: state.grants.map(({ scope, repo, api, agents }) => ({ scope: scope || 'repository', repo, api, agents })) };
  const api = resolveAPI(undefined, state.api);
  return { ...result, ...installationGuidance(result, { api, localNative: state.native?.source === 'local', uploadApproved: state.grants.some(g => g.scope === 'global' && g.api === api) }) };
}

export async function update(options) {
  const raw = await npm(['view', metadata.name, 'version', '--json']);
  const version = JSON.parse(raw.toString());
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid published version.');
  const result = await installCLI({ version });
  const native = await installNative({ update:true });
  const selected = (await readState()).agents;
  await installSkill(selected);
  if (selected.length && !native.watch) throw new Error('The Go CLI needs the current watch command.');
  for (const agent of selected) await installHooks(agent, native.executable);
  const updated = { ...result, ...native, version, ...(await doctor()) };
  if(selected.includes('codex')) {
    updated.codexReload=await reloadCodexHooks();

  }
  return updated;
}
