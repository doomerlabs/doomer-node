import { parseArgs } from 'node:util';
import { readState, changeState, metadata, developmentInstall } from './system.js';
import { setup, doctor, selectAgents } from './setup.js';
import { installHooks } from './hooks.js';
import { installNative, upgradeNative } from './native.js';
import { doctorService } from './doctor-service.js';
import { uninstall } from './uninstall.js';
import { reloadCodexHooks, reloadMessage } from './codex.js';
import { formatDoctor, formatSetup, sessionTestPrompt } from './doctor.js';
import { doctorBrowserEndpoint, sendDoctorBrowserResult } from './doctor-browser.js';

const HELP = `Doomer manager ${metadata.version}

Usage: npx @doomerlabs/doomer <command>

  install                      Install CLI + skill and onboard selected agents
  onboard                      Complete setup after installing the skill directly
  install-hooks                Install or repair agent hooks
  refresh-hooks                Reload hooks in a running local Codex server
  doctor                       Diagnose setup and recent reviews (--fix repairs configured hooks)
  upgrade                      Update only the native CLI (--check to inspect)
  update                       Update CLI + skill and repair configured hooks
  uninstall                    Remove managed hooks, skill, CLI and local data
  revoke                       Revoke saved upload approval for this service

Setup options:
  --agent claude,codex         Agents to configure (picker or detected defaults when omitted)
  --no-hooks                   Install without automatic review hooks
  --approve-uploads            Approve all Doomer review uploads to this service
  --claude-review-permission allow|decline  Decide scoped Claude review permissions
  --reviewer-policy allow|decline  Decide the separately disclosed Codex policy
  --reviewer-policy-proposal HASH  Digest from that exact proposal
  --skill-source PATH         Install the doomer skill from a local source checkout
  --repo PATH                  Checkout to diagnose with doctor
  --test-session               Print a prompt to test the current chat’s hook and watcher
  --browser-session CODE       Send status codes to a waiting troubleshooting page
  --browser-origin URL         Origin from the waiting troubleshooting page
  --verify-account             Opt in to remote account verification with doctor
  --json                       Machine-readable result
  --api-url URL                Service (or DOOMER_API_URL; default: https://doomer.ai/api)

Node.js 22+ and Git required. Setup does not grant native hook trust.
`;

export async function main(args) {
  const { values: options, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    fix: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    agent: { type: 'string' },
    'claude-review-permission': { type: 'string' }, 'reviewer-policy': { type: 'string' }, 'reviewer-policy-proposal': { type: 'string' },
    'no-hooks': { type: 'boolean' }, 'approve-uploads': { type: 'boolean' },
    repo: { type: 'string' }, 'verify-account': { type: 'boolean' }, 'test-session': { type: 'boolean' },
    'browser-session': { type: 'string' }, 'browser-origin': { type: 'string' },
    'skill-source': { type: 'string' }, json: { type: 'boolean' }, 'cli-version': { type: 'string' }, 'api-url': { type: 'string' }, home: { type: 'string' },
  } });
  if (options.home) process.env[developmentInstall() ? 'DOOMER_DEV_HOME' : 'DOOMER_HOME'] = options.home;
  if (options.version) { console.log(metadata.version); return 0; }
  if (options.help || !positionals.length) { console.log(HELP); return 0; }
  const [command, ...extra] = positionals;
  const browserCheck = Object.hasOwn(options, 'browser-session') || Object.hasOwn(options, 'browser-origin');
  if (browserCheck && (command !== 'doctor' || Object.keys(options).some(option => !['browser-session', 'browser-origin', 'repo'].includes(option)))) {
    throw new Error('Use --browser-session and --browser-origin with a read-only doctor check.');
  }
  if (Object.hasOwn(options, 'claude-review-permission') && (!['allow', 'decline'].includes(options['claude-review-permission']) || !['install', 'onboard', 'update'].includes(command))) throw new Error('--claude-review-permission allow|decline requires install, onboard, or update.');
  if (Object.hasOwn(options, 'reviewer-policy') && (!['allow', 'decline'].includes(options['reviewer-policy']) || !['install', 'onboard', 'update'].includes(command))) throw new Error('--reviewer-policy allow|decline is supported only by install, onboard, and update, after reviewing the scoped proposal.');
  if (Object.hasOwn(options, 'reviewer-policy-proposal') && (!['install', 'onboard', 'update'].includes(command) || !options['reviewer-policy'])) throw new Error('--reviewer-policy-proposal requires a reviewer-policy decision with install, onboard, or update.');
  if ((Object.hasOwn(options, 'repo') || options['verify-account']) && command !== 'doctor') throw new Error('--repo and --verify-account are supported only by doctor.');
  if (options['test-session'] && (command !== 'doctor' || Object.keys(options).some(option => option !== 'test-session'))) throw new Error('--test-session is a standalone doctor option.');
  if (Object.hasOwn(options, 'fix') && command !== 'doctor') throw new Error('--fix is supported only by doctor.');
  if (Object.hasOwn(options, 'check') && command !== 'upgrade') throw new Error('--check is supported only by upgrade.');
  if (Object.hasOwn(options, 'cli-version') && !['install', 'onboard'].includes(command)) throw new Error('--cli-version is supported only by install and onboard.');
  if (Object.hasOwn(options, 'skill-source') && !['install', 'onboard'].includes(command)) throw new Error('--skill-source is supported only by install and onboard.');
  if (extra.length) throw new Error('Unexpected command arguments. Run npx @doomerlabs/doomer --help.');
  switch (command) {
    case 'install':
    case 'onboard':
    case 'update': {
      const result = await setup(options, command);
      if (result === null) {
        if (options.json) console.log(JSON.stringify({ status: 'canceled', ready: false }));
        return 0;
      }
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(formatSetup(result));
      return result.ready ? 0 : 1;
    }
    case 'doctor': {
      if (options['test-session']) {
        console.log(sessionTestPrompt);
        return 0;
      }
      const result = await doctor({ fix: options.fix, apiURL: options['api-url'], repo: options.repo, runtime: true, verifyAccount: options['verify-account'] ?? false });
      if (browserCheck) {
        const endpoint = doctorBrowserEndpoint(options['browser-origin'], result.api);
        console.log(formatDoctor(result));
        await sendDoctorBrowserResult(endpoint, options['browser-session'], result);
        console.log('Result sent to Doomer Doctor.');
        return result.ready ? 0 : 1;
      }
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(formatDoctor(result));
      return result.ready ? 0 : 1;
    }
    case 'install-hooks': {
      const selected = await selectAgents(options);
      if (!selected?.length) {
        if (options.json) console.log(JSON.stringify({ status: selected === null ? 'canceled' : 'skipped', agents: [], installed: false }));
        else if (selected !== null) console.log('No agent hooks selected.');
        return 0;
      }
      const native = await installNative();
      if (!native.watch) throw new Error('The Go CLI needs the current watch command. Build the current Go branch and rerun with DOOMER_NATIVE_BINARY.');
      const hooks = [];
      for (const agent of selected) hooks.push(await installHooks(agent, native.executable));
      await changeState(s => { s.agents = [...new Set([...s.agents, ...selected])]; });
      const codexReload = selected.includes('codex') ? await reloadCodexHooks() : undefined;
      if (options.json) {
        console.log(JSON.stringify({ status: 'configured', agents: selected, installed: true, hooks, codexReload }));
        return 0;
      }
      for (const hook of hooks) {
        for (const profile of hook.profiles) console.log(`${hook.agent}: ${profile.changed ? 'installed' : 'already configured'} (${profile.file})`);
      }
      if (codexReload) console.log(reloadMessage(codexReload));
      else console.log('Review and trust the hooks in your agent. Installation does not prove activation.');
      return 0;
    }
    case 'refresh-hooks': {
      const result=await reloadCodexHooks();
      console.log(options.json ? JSON.stringify(result,null,2) : reloadMessage(result));
      return result.reloaded ? 0 : 1;
    }
    case 'upgrade': {
      const result = await upgradeNative({ check: options.check });
      console.log(options.json ? JSON.stringify(result, null, 2) : `Doomer ${result.state}: ${result.currentVersion} → ${result.latestVersion}`);
      return 0;
    }
    case 'uninstall': {
      const result=await uninstall();
      if(options.json)console.log(JSON.stringify(result,null,2));
      else {
        console.log('Doomer uninstalled. Owned hooks, permissions, skills and local installation data removed.');
        if(result.preservedSharedSkill)console.log('Preserved skills still used by another installation.');
        if(result.codexPolicies?.some(policy=>policy.preserved_policy))console.log('Preserved shared or customized Codex review policy.');
        if(result.removedExecutable)console.log(`Removed ${result.removedExecutable}`);
        if(result.preservedExecutable)console.log(`Preserved replacement executable: ${result.preservedExecutable}`);
        if(result.codexReload)console.log(result.codexReload.reloaded ? 'Codex reloaded the removed hooks without restarting.' : reloadMessage(result.codexReload));
      }
      return 0;
    }
    case 'revoke': {
      const { api: service } = await doctorService({ explicit: options['api-url'], saved: (await readState()).api });
      let removed = false;
      await changeState(s => {
        removed = s.grants.some(g => g.api === service);
        s.grants = s.grants.filter(g => g.api !== service);
      });
      console.log(removed ? `Removed saved upload approval for ${service}.` : `No saved upload approval for ${service}.`);
      return 0;
    }
    default: throw new Error(`Unknown command ${command}. Run npx @doomerlabs/doomer --help.`);
  }
}
