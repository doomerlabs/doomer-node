import { parseArgs } from 'node:util';
import { readState, changeState, metadata, paths, exists } from './system.js';
import { setup, doctor, update, selectAgents, installCLI } from './setup.js';
import { installHooks } from './hooks.js';
import { review } from './review.js';
import { installNative, nativeHook, stopNativeWatchers } from './native.js';
import { resolveAPI } from './api.js';
import { uninstall } from './uninstall.js';
import { reloadCodexHooks, reloadMessage } from './codex.js';

const HELP = `Doomer manager ${metadata.version}

Usage: npx @doomerlabs/doomer <command>

  install                      Install CLI + skill and onboard selected agents
  onboard                      Complete setup after installing the skill directly
  review [get ID]              Delegate a review to the Go CLI
  install-hooks                Install or repair agent hooks
  refresh-hooks                Reload hooks in a running local Codex server
  doctor                       Check CLI, skill and hook readiness (no changes)
  update                       Update CLI + skill and repair configured hooks
  uninstall                    Remove managed hooks, skill, CLI and local data
  revoke                       Revoke saved upload approval for this service

Setup options:
  --agent claude,codex         Agents to configure (interactive when omitted)
  --no-hooks                   Install for standalone reviews
  --approve-uploads            Approve all Doomer review uploads to this service
  --from PATH.tgz              Install a local npm tarball before publication

Review options:
  --repo PATH                  Git worktree (default: current directory)
  --base REF                   Baseline (default: merge base with main/master)
  --approve-upload             Explicit approval for this one review
  --wait none                  Submit without waiting
  --timeout SECONDS            Quick result wait limit (default: 60)
  --show-diff                  Print the exact submitted diff to stderr
  --json                       Machine-readable result
  --api-url URL                Service (or DOOMER_API_URL; default: https://doomer.ai/api)

Node.js 22+ and Git required. Setup does not grant native hook trust.
`;

export async function main(args) {
  const { values: options, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    agent: { type: 'string' }, repo: { type: 'string', default: '.' }, base: { type: 'string' },
    'no-hooks': { type: 'boolean' }, 'approve-upload': { type: 'boolean' }, 'approve-uploads': { type: 'boolean' },
    json: { type: 'boolean' }, from: { type: 'string' }, 'api-url': { type: 'string' }, home: { type: 'string' },
    wait: { type: 'string' }, timeout: { type: 'string' }, session: { type: 'string' }, owner: { type: 'string' }, 'show-diff': { type: 'boolean' },
  } });
  if (options.home) process.env.DOOMER_HOME = options.home;
  if (options.version) { console.log(metadata.version); return 0; }
  if (options.help || !positionals.length) { console.log(HELP); return 0; }
  if (options.timeout !== undefined && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0 || Number(options.timeout) > 1800)) throw new Error('--timeout must be between 0 and 1800 seconds.');
  if (options.wait !== undefined && options.wait !== 'none' && options.wait !== 'quick') throw new Error('--wait must be quick or none.');
  const [command, subcommand, id, ...extra] = positionals;
  if (extra.length || (command !== 'review' && subcommand) || (command === 'review' && subcommand && (subcommand !== 'get' || !id))) throw new Error('Unexpected command arguments. Run doomer --help.');
  switch (command) {
    case 'install':
    case 'onboard': {
      const result = await setup(options, { forceSkill: command === 'install' });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Doomer installed: ${result.executable}`);
        console.log(`Agents: ${result.agents.join(', ') || 'standalone (no hooks)'}`);
        for (const hook of result.hooks) console.log(`${hook.agent} hooks: ${hook.file}`);
        console.log(result.next);
        if (!result.onPath) console.log(`Add ${paths().home.includes('\\') ? 'the executable directory' : result.executable.slice(0, result.executable.lastIndexOf('/'))} to PATH to run doomer.`);
      }
      return result.ready ? 0 : 1;
    }
    case 'doctor': {
      const result = await doctor();
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`CLI: ${result.cli ? result.version : 'missing'}; global command: ${result.commandInstalled ? 'installed' : 'missing'}; skill: ${result.skill}`);
        for (const h of result.hooks) console.log(`${h.agent}: ${h.configured ? 'configured' : 'needs repair'}${h.enabled === false ? ', disabled' : ''}; native activation unverified${h.error ? ` (${h.error})` : ''}`);
        console.log(result.next);
      }
      return result.ready ? 0 : 1;
    }
    case 'install-hooks': {
      const selected = await selectAgents(options);
      const state = await readState();
      const runtime = state.hookLauncher && await exists(state.hookLauncher) ? state.hookLauncher : (await installCLI({ from: options.from })).hookLauncher;
      await installNative();
      for (const agent of selected) {
        const result = await installHooks(agent, runtime);
        console.log(`${agent}: ${result.changed ? 'installed' : 'already configured'} (${result.file})`);
      }
      await changeState(s => { s.agents = [...new Set([...s.agents, ...selected])]; });
      if(selected.includes('codex')) console.log(reloadMessage(await reloadCodexHooks()));
      else console.log('Review and trust the hooks in your agent. Installation does not prove activation.');
      return 0;
    }
    case 'refresh-hooks': {
      const result=await reloadCodexHooks();
      console.log(options.json ? JSON.stringify(result,null,2) : reloadMessage(result));
      return result.reloaded ? 0 : 1;
    }
    case 'update': {
      const result = await update(options);
      console.log(options.json ? JSON.stringify(result, null, 2) : `Doomer updated to ${result.version}. ${result.next}`);
      return result.ready ? 0 : 1;
    }
    case 'uninstall': {
      const result=await uninstall();
      if(options.json)console.log(JSON.stringify(result,null,2));
      else {
        console.log('Doomer uninstalled. Managed hooks, skills and local installation data removed.');
        if(result.removedExecutable)console.log(`Removed ${result.removedExecutable}`);
        if(result.preservedExecutable)console.log(`Preserved replacement executable: ${result.preservedExecutable}`);
        if(result.codexReload)console.log(result.codexReload.reloaded ? 'Codex reloaded the removed hooks without restarting.' : reloadMessage(result.codexReload));
      }
      return 0;
    }
    case 'review': {
      await review(options, subcommand === 'get' ? id : undefined);
      return 0;
    }
    case 'revoke': {
      const service = resolveAPI(options['api-url'], (await readState()).api);
      await changeState(s => { s.grants = s.grants.filter(g => g.api !== service); });
      await stopNativeWatchers(service);
      console.log(`Removed saved upload approval for ${new URL(service).origin}.`);
      return 0;
    }
    case 'hook': {
      try {
        let data = '';
        for await (const part of process.stdin) { data += part; if (data.length > 1024 * 1024) throw new Error('Hook input too large.'); }
        console.log(JSON.stringify(await nativeHook(JSON.parse(data), options)));
      } catch (error) {
        console.error(`Doomer hook: ${error.message}`);
        console.log(JSON.stringify({ systemMessage: `Doomer Quick review was not completed: ${error.message}` }));
      }
      return 0;
    }
    default: throw new Error(`Unknown command ${command}. Run doomer --help.`);
  }
}
