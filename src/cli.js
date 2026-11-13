import { parseArgs } from 'node:util';
import { readState, changeState, metadata, paths, developmentInstall } from './system.js';
import { setup, doctor, update, selectAgents } from './setup.js';
import { installHooks } from './hooks.js';
import { installNative, upgradeNative } from './native.js';
import { resolveAPI } from './api.js';
import { uninstall } from './uninstall.js';
import { reloadCodexHooks, reloadMessage } from './codex.js';
import { formatDoctor } from './doctor.js';

const HELP = `Doomer manager ${metadata.version}

Usage: npx @doomerlabs/doomer <command>

  install                      Install CLI + skill and onboard selected agents
  onboard                      Complete setup after installing the skill directly
  install-hooks                Install or repair agent hooks
  refresh-hooks                Reload hooks in a running local Codex server
  doctor                       Check CLI, skill and hook readiness (no changes)
  upgrade                      Update only the native CLI (--check to inspect)
  update                       Update CLI + skill and repair configured hooks
  uninstall                    Remove managed hooks, skill, CLI and local data
  revoke                       Revoke saved upload approval for this service

Setup options:
  --agent claude,codex         Agents to configure (interactive when omitted)
  --no-hooks                   Install for standalone reviews
  --approve-uploads            Approve all Doomer review uploads to this service
  --from PATH.tgz              Install a local npm tarball before publication
  --json                       Machine-readable result
  --api-url URL                Service (or DOOMER_API_URL; default: https://doomer.ai/api)

Node.js 22+ and Git required. Setup does not grant native hook trust.
`;

export async function main(args) {
  const { values: options, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    agent: { type: 'string' },
    'no-hooks': { type: 'boolean' }, 'approve-uploads': { type: 'boolean' },
    json: { type: 'boolean' }, from: { type: 'string' }, 'api-url': { type: 'string' }, home: { type: 'string' },
  } });
  if (options.home) process.env[developmentInstall() ? 'DOOMER_DEV_HOME' : 'DOOMER_HOME'] = options.home;
  if (options.version) { console.log(metadata.version); return 0; }
  if (options.help || !positionals.length) { console.log(HELP); return 0; }
  const [command, ...extra] = positionals;
  if (extra.length) throw new Error('Unexpected command arguments. Run npx @doomerlabs/doomer --help.');
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
      else console.log(formatDoctor(result));
      return result.ready ? 0 : 1;
    }
    case 'install-hooks': {
      const selected = await selectAgents(options);
      const native = await installNative();
      if (!native.watch) throw new Error('The Go CLI needs the current watch command. Build the current Go branch and rerun with DOOMER_NATIVE_BINARY.');
      for (const agent of selected) {
        const result = await installHooks(agent, native.executable);
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
    case 'upgrade': {
      const result = await upgradeNative({ check: options.check });
      console.log(options.json ? JSON.stringify(result, null, 2) : `Doomer ${result.state}: ${result.currentVersion} → ${result.latestVersion}`);
      return 0;
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
    case 'revoke': {
      const service = resolveAPI(options['api-url'], (await readState()).api);
      await changeState(s => { s.grants = s.grants.filter(g => g.api !== service); });
      console.log(`Removed saved upload approval for ${new URL(service).origin}.`);
      return 0;
    }
    default: throw new Error(`Unknown command ${command}. Run npx @doomerlabs/doomer --help.`);
  }
}
