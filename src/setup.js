import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname, delimiter, isAbsolute } from 'node:path';
import { mkdir, mkdtemp, rm, lstat, stat, access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isCancel, multiselect, select } from '@clack/prompts';
import { agents, hookFile, installHooks, checkHooks, globalSkillPaths } from './hooks.js';
import { paths, developmentInstall, metadata, packageRoot, hash, npm, run, readState, changeState, exists, atomicWrite, locked, interactiveTerminal } from './system.js';
import { resolveAPI } from './api.js';
import { uploadDisclosure } from './permissions.js';
import { installNative, validateCLIVersion } from './native.js';
import { configureReviewerPolicy, inspectReviewerPolicies } from './reviewer-policy.js';
import { configureClaudeReviewPermission } from './claude-policy.js';
import { reloadCodexHooks } from './codex.js';
import { inspectNativeInstallation } from './doctor.js';
import { withSkillSource } from './skill-source.js';
import { installationGuidance, managerCommand, setupStep, shellQuote } from './recovery.js';

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
  if (options.agent !== undefined) {
    const selected = options.agent.split(',').map(agent => agent.trim()).filter(Boolean);
    if (!selected.length || selected.some(agent => !agents.includes(agent))) throw new Error('Supported agents: claude,codex. Use --no-hooks for standalone reviews.');
    return [...new Set(selected)];
  }

  const saved = (await readState()).agents.filter(agent => agents.includes(agent));
  const detected = await detectInstalledAgents();
  const defaults = saved.length ? saved : detected;
  const label = agent => agent === 'claude' ? 'Claude Code' : 'Codex';
  if (!interactiveTerminal()) {
    if (!options.json) console.error(defaults.length
      ? `Agents: ${defaults.map(label).join(', ')} (${saved.length ? 'previous selection' : 'detected'}).`
      : 'No supported agents detected.');
    return defaults;
  }

  const selected = await multiselect({
    message: 'Set up Doomer reviews for',
    options: agents.map(agent => ({ value: agent, label: label(agent) })),
    initialValues: defaults,
    required: false,
    output: process.stderr,
  });
  return isCancel(selected) ? null : selected;
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
        await npm(['install', '--prefix', temp, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--', spec]);
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

export async function installSkill(selected, source) {
  // npm exec launches the same official skills CLI as npx skills add; its own
  // telemetry supplies skills.sh counts. Respect the user's telemetry settings.
  await withSkillSource(async source => {
    const args = ['exec', '--yes', '--package=skills', '--', 'skills', 'add', source, '--skill', 'doomer', '--global', '--yes'];
    if (selected.length) args.push('--agent', ...selected.map(a => a === 'claude' ? 'claude-code' : a));
    else args.push('--agent', 'codex'); // Store the global skill without installing any hooks.
    await npm(args);
  }, source);
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
  for (const agent of selected) installed.push(await installHooks(agent, runtime));
  await changeState(s => { s.agents = [...new Set([...s.agents, ...selected])]; s.api = resolveAPI(options['api-url'], s.api); });
  await changeState(s => {
    const service = resolveAPI(options['api-url'], s.api);
    if (s.grants.some(g => g.api === service)) {
      s.identities ??= {};
      s.identities[service] ||= `doomer_anon_${randomBytes(32).toString('base64url')}`;
      if (process.env.DOOMER_CONFIG_DIR) {
        s.credentialDirs ??= {};
        s.credentialDirs[service] ||= resolve(process.env.DOOMER_CONFIG_DIR);
      }
    }
  });
  return installed;
}

export async function grant(api, credentialDirectory = process.env.DOOMER_CONFIG_DIR) {
  await changeState(s => {
    const service = resolveAPI(api, s.api);
    s.grants = s.grants.filter(g => g.api !== service);
    s.grants.push({ scope: 'global', api: service, approvedAt: new Date().toISOString() });
    s.identities ??= {};
    s.identities[service] ||= `doomer_anon_${randomBytes(32).toString('base64url')}`;
    if (credentialDirectory) {
      s.credentialDirs ??= {};
      s.credentialDirs[service] = resolve(credentialDirectory);
    }
  });
}

async function selectUploadApproval(options, selected, state, api) {
  if (options['approve-uploads']) return 'terminal';
  if (!selected.length || state.grants.some(grant => grant.scope === 'global' && grant.api === api)) return 'existing';
  if (!interactiveTerminal()) {
    throw new Error('Upload approval is required to set up automatic reviews. Run setup in a terminal, or pass --approve-uploads if you approve the uploads. Use --no-hooks for CLI-only setup.');
  }

  console.error(uploadDisclosure(api));
  const decision = await select({
    message: 'Enable Doomer reviews?',
    options: [
      { value: 'browser', label: 'Review permissions in browser' },
      { value: 'terminal', label: 'Yes, enable reviews here' },
      { value: 'exit', label: 'No, exit setup' },
    ],
    output: process.stderr,
  });
  return isCancel(decision) ? 'exit' : decision;
}

export async function setup(options, { forceSkill = true } = {}) {
  validateCLIVersion(options['cli-version']);
  if (options['skill-source']) {
    if (!isAbsolute(options['skill-source']) || !await exists(join(options['skill-source'], 'skills', 'doomer', 'SKILL.md'))) {
      throw new Error('--skill-source must be an absolute local checkout containing skills/doomer/SKILL.md.');
    }
  }
  const state = await readState();
  const api = resolveAPI(options['api-url'], state.api);
  const selected = await selectAgents(options);
  if (selected === null) return null;
  if (options['claude-review-permission'] && !selected.includes('claude')) throw new Error('--claude-review-permission requires selecting claude.');
  if (options['reviewer-policy'] && !selected.includes('codex')) throw new Error('--reviewer-policy requires selecting codex.');
  if (developmentInstall() && !process.env.DOOMER_NATIVE_BINARY) throw new Error('Development installation requires DOOMER_NATIVE_BINARY.');
  if (!interactiveTerminal() && !selected.length && !options['no-hooks']) {
    throw new Error('No supported agents detected. Choose --agent claude,codex or use --no-hooks for CLI-only setup.');
  }
  const approval = await selectUploadApproval(options, selected, state, api);
  if (approval === 'exit') {
    if (!options.json) console.error('Setup canceled.');
    return null;
  }
  if (approval === 'browser' && process.env.DOOMER_TOKEN?.trim()) {
    throw new Error('Unset DOOMER_TOKEN before browser approval so reviews use the account you approve.');
  }
  await rm(join(paths().home,'uninstalling.json'),{force:true});
  const devLauncher = process.env.DOOMER_DEV_SETUP_LAUNCHER;
  const retry = developmentInstall() && devLauncher && isAbsolute(devLauncher)
    ? shellQuote(devLauncher)
    : managerCommand('onboard', { agents: selected, api: options['api-url'], cliVersion: options['cli-version'] });
  const installed = await setupStep('Installing the manager', retry, () => installCLI({ from: options.from }));
  const native = await setupStep('Installing the Go CLI', retry, () => installNative({ version: options['cli-version'] }));
  if (selected.length && !native.watch) throw new Error('The Go CLI needs the current watch command. Build the current Go branch and rerun with DOOMER_NATIVE_BINARY.');
  let reviewCredentialDirectory;
  if (approval === 'browser') {
    reviewCredentialDirectory = await setupStep('Authorizing reviews in the browser', retry, async () => {
      const diagnose = async (flags = []) => JSON.parse((await run(native.executable,
        [...flags, 'watch', 'diagnose', '--manager-home', paths().home, '--agent', selected[0]])).toString());
      let routing = await diagnose();
      if (routing.service !== api) {
        if (!['default', 'manager state'].includes(routing.service_source)) {
          throw new Error('This directory routes Doomer reviews to a different service. Check .doomer.env and rerun setup with the matching --api-url.');
        }
        routing = await diagnose(['--api-url', api]);
      }
      if (routing.token_override_present) throw new Error('Clear the DOOMER_TOKEN override before connecting your browser account.');
      await run(native.executable, ['--api-url', api, '--profile', routing.profile, 'login', '--device', '--review-uploads'], {
        stdio: ['inherit', 2, 2],
        env: { ...process.env, DOOMER_CONFIG_DIR: routing.credential_directory },
      });
      return routing.credential_directory;
    });
  }
  if (forceSkill || options['skill-source'] || !await skillPresent(selected)) {
    if (!options.json) console.error('Installing the Doomer skill…');
    await setupStep('Installing the skill', retry, () => installSkill(selected, options['skill-source']));
  }
  if (approval === 'terminal' || approval === 'browser') await grant(api, reviewCredentialDirectory);
  await setupStep('Configuring agent hooks', retry, () => configure(selected, native.executable, options));
  if (selected.includes('claude')) await configureClaudeReviewPermission(native.executable, options['claude-review-permission']);
  const codexReviewPolicy = selected.includes('codex')
    ? await setupStep('Configuring Codex reviewer policy', retry, () => configureReviewerPolicy(native.executable, options)) : undefined;
  const result = { ...installed, ...native, agents: selected, ...(await doctor({ policy: codexReviewPolicy })) };
  if(selected.includes('codex')) {
    result.codexReload=await reloadCodexHooks();

  }
  return result;
}

export async function doctor({ policy, fix = false, apiURL } = {}) {
  let repairs;
  if (fix) {
    repairs = [];
    const before = await readState();
    const native = await inspectNativeInstallation(before);
    if (native.capabilities.watchAgentHook) {
      for (const agent of before.agents) repairs.push(await installHooks(agent, before.executable));
    }
  }
  const state = await readState();
  const runtime = state.runtime;
  const cli = !!runtime && await exists(runtime);
  const inspection = await inspectNativeInstallation(state);
  const automaticReviews = inspection.capabilities.watchAgentHook;
  const hooks = await Promise.all(state.agents.map(agent => checkHooks(agent, state.executable)));
  const skill = await skillPresent(state.agents);
  const ready = cli && inspection.nativeStatus === 'available' && automaticReviews && inspection.commandInstalled && skill && hooks.every(h => h.configured && h.enabled);
  const result = { ready, cli, ...(repairs ? { repairs } : {}), ...inspection, automaticReviews, version: state.cliVersion || null,
    claudeReviewPermission: state.claudeReviewPermission?.decision || 'unverified',
    executable: state.executable || null, skill: skill ? 'installed' : 'missing', hooks,
    uploadGrants: state.grants.map(({ scope, repo, api, agents }) => ({ scope: scope || 'repository', repo, api, agents })) };
  const api = resolveAPI(apiURL, state.api);
  // Inspect the current policy without applying decisions. Account verification
  // may require the service; report actual failures instead of inventing a missing policy.
  if (policy) result.codexReviewPolicy = policy;
  else if (state.agents.includes('codex') && state.grants.some(g => g.api === api)) {
    result.codexReviewPolicy = await inspectReviewerPolicies(state.executable, { 'api-url': api });
  }
  return { ...result, ...installationGuidance(result, { api, localNative: state.native?.source === 'local', uploadApproved: state.grants.some(g => g.scope === 'global' && g.api === api) }) };
}

export async function update(options) {
  const selected = (await readState()).agents;
  if (options['claude-review-permission'] && !selected.includes('claude')) throw new Error('--claude-review-permission requires selecting claude.');
  if (options['reviewer-policy'] && !selected.includes('codex')) throw new Error('--reviewer-policy requires configured Codex hooks.');
  const channel = metadata.version.includes('-beta.') ? 'beta' : 'latest';
  const raw = await npm(['view', `${metadata.name}@${channel}`, 'version', '--json']);
  const version = JSON.parse(raw.toString());
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid published version.');
  const result = await installCLI({ version });
  const packageMetadata = JSON.parse(await readFile(join(dirname(result.runtime), '..', 'package.json'), 'utf8'));
  const native = await installNative({ update:true, packageMetadata });
  await installSkill(selected);
  if (selected.length && !native.watch) throw new Error('The Go CLI needs the current watch command.');
  for (const agent of selected) await installHooks(agent, native.executable);
  if (selected.includes('claude')) await configureClaudeReviewPermission(native.executable, options['claude-review-permission']);
  const codexReviewPolicy = selected.includes('codex')
    ? await configureReviewerPolicy(native.executable, options) : undefined;
  const updated = { ...result, ...native, version, agents: selected, ...(await doctor({ policy: codexReviewPolicy })) };
  if(selected.includes('codex')) {
    updated.codexReload=await reloadCodexHooks();

  }
  return updated;
}
