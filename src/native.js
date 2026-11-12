import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, chmod } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveAPI } from './api.js';
import { paths, hash, run, readState, changeState, readJSON, writeJSON, atomicWrite, locked, exists } from './system.js';
import { hasUploadApproval } from './permissions.js';
import { repositoryRoot } from './snapshot.js';

const RELEASES = 'https://downloads.doomer.ai/cli/';

async function download(url, limit) {
  if (!url.startsWith(RELEASES)) throw new Error('Invalid native CLI release URL.');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Native CLI download failed: HTTP ${response.status}.`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Native CLI download exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Read just the regular executable; never extract archive paths onto disk.
export function archiveBinary(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
  let binary;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().split('\0')[0].replace(/^\.\//, '');
    const sizeField = header.subarray(124, 136).toString().replace(/\0/g, '').trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error('Invalid native release archive.');
    const size = parseInt(sizeField, 8);
    const type = header[156];
    if (offset + 512 + size > tar.length) throw new Error('Truncated native release archive.');
    if (name === 'doomer') {
      if (binary || ![0, 48].includes(type) || size > 64 * 1024 * 1024) throw new Error('Invalid native release executable.');
      binary = tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!binary?.length) throw new Error('Native release contains no doomer executable.');
  return binary;
}

export async function installNative({ update = false } = {}) {
  const state = await readState();
  const target = join(paths().bin, 'doomer-go');
  if (process.env.DOOMER_NATIVE_BINARY) {
    const source = resolve(process.env.DOOMER_NATIVE_BINARY);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (source !== target) await atomicWrite(target, await readFile(source), 0o755);
    await chmod(target, 0o755);
    const version = (await run(target, ['--version'])).toString().trim();
    const allChanges = (await run(target, ['watch','--help'])).toString().includes('--all-changes');
    await changeState(s => { s.native = { path: target, version, source: 'local', allChanges }; });
    return { path: target, version, allChanges };
  }
  if (!update && state.native?.path === target && await exists(target)) return state.native;
  const platform = `${process.platform}_${{ x64: 'amd64', arm64: 'arm64' }[process.arch] || 'unsupported'}`;
  const manifest = JSON.parse((await download(`${RELEASES}stable.json`, 1024 * 1024)).toString());
  const asset = manifest.assets?.[platform];
  if (manifest.schema_version !== 1 || !/^20\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/.test(manifest.version) || !asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`No valid native CLI release for ${platform}.`);
  const expectedURL = `${RELEASES}releases/${manifest.version}/doomer_${manifest.version}_${platform}.tar.gz`;
  if (asset.url !== expectedURL) throw new Error('Native release URL does not match its version.');
  const archive = await download(asset.url, 64 * 1024 * 1024);
  if (hash(archive) !== asset.sha256) throw new Error('Native release checksum mismatch.');
  const binary = archiveBinary(archive);
  await atomicWrite(target, binary, 0o755);
  const version = (await run(target, ['--version'])).toString().trim();
  if (!version.includes(manifest.version)) throw new Error('Native CLI version does not match the release manifest.');
  const allChanges = (await run(target, ['watch','--help'])).toString().includes('--all-changes');
  const native = { path: target, version: manifest.version, sha256: hash(binary), source: 'stable', allChanges };
  await changeState(s => { s.native = native; });
  return native;
}

export function nativeContext(state, agent = 'manual', api) {
  if (!state.native?.path) throw new Error('The Go CLI is missing. Run npx @doomerlabs/doomer onboard.');
  const service = resolveAPI(api, state.api);
  const profile = `node-${agent}`;
  const config = join(paths().home, 'native-state');
  return { binary: state.native.path, api: service, profile, config,
    root: join(config, 'watch', hash(`${service}\0${profile}`)),
    env: { ...process.env, DOOMER_CONFIG_DIR: config },
    args: ['--api-url', service, '--profile', profile],
  };
}

export async function syncNativeConsent(agent, api, repo, oneReview = false) {
  let state = await readState();
  const context = nativeContext(state, agent, api);
  if (!oneReview && !hasUploadApproval(state, context.api, repo, agent === 'manual' ? undefined : agent)) throw new Error('Doomer upload approval is required; run npx @doomerlabs/doomer onboard.');
  state = await changeState(s => {
    s.identities ??= {};
    s.identities[context.api] ||= `doomer_anon_${randomBytes(32).toString('base64url')}`;
  });
  const token = process.env.DOOMER_TOKEN || state.identities[context.api];
  const globals = state.grants.filter(g => g.api === context.api && g.scope === 'global');
  const scoped = state.grants.filter(g => g.api === context.api && g.repo && (agent === 'manual' || g.agents?.includes(agent)));
  const grant = globals[0] || scoped.find(g => g.repo === repo);
  await locked(join(context.config, 'sync'), async () => {
    // The Go CLI's native credential store is isolated from the old installer.
    const credentials = await readJSON(join(context.config, 'config.json'), {});
    credentials.auths ??= {};
    credentials.auths[`auth:v2:${Buffer.byteLength(context.api)}:${context.api}:${context.profile}`] = { token };
    await writeJSON(join(context.config, 'config.json'), credentials);
    if (!oneReview) await writeJSON(join(context.root, 'config.json'), {
      version: 1, api_url: context.api, profile: context.profile, account_key: hash(token),
      explicit_consent: true, all_repositories: globals.length > 0,
      all_changes: true,
      directories: globals.length ? [] : scoped.map(g => g.repo),
      consented_at: grant.approvedAt,
    });
  });
  return context;
}

async function workingRepository(input) {
  // Explicit tool working directories are stronger evidence than the session cwd.
  const values = [input.tool_input?.workdir, input.tool_input?.cwd, input.cwd, input.tool_input?.file_path, input.tool_input?.path].filter(v => typeof v === 'string' && v);
  for (const value of values) {
    let path = resolve(input.cwd || '.', value);
    while (!await exists(path) && dirname(path) !== path) path = dirname(path);
    try { return await repositoryRoot(path); }
    catch { try { return await repositoryRoot(dirname(path)); } catch { /* Try another explicit path. */ } }
  }
  return undefined;
}

async function ensureWatcher(context, repo) {
  const state = await readState();
  if (!state.native?.allChanges) throw new Error('The installed Go CLI needs --all-changes support. Build the feat/watch-all-changes Go branch and reinstall with DOOMER_NATIVE_BINARY pointing to that binary.');
  await locked(join(context.root, 'node-start'), async () => {
    if (await exists(join(paths().home,'uninstalling.json'))) throw new Error('Doomer is being uninstalled.');
    if (await exists(join(context.root, 'paused.json'))) throw new Error('Doomer watching is paused. Resume it explicitly.');
    try {
      const status = JSON.parse((await run(context.binary, [...context.args, 'watch', 'status', repo, '--json'], { env: context.env })).toString());
      if (status.paused) throw new Error('Doomer watching is paused. Resume it explicitly.');
      if (status.running) {
        if (!status.all_changes) throw new Error('The existing Go watcher is not in all-changes mode; restart that watcher before continuing.');
        return;
      }
    } catch (error) { if (error.message.includes('paused') || error.message.includes('all-changes mode')) throw error; }
    await mkdir(context.root, { recursive: true, mode: 0o700 });
    const log = await open(join(context.root, 'watch.log'), 'a', 0o600);
    const session = `node-${randomUUID()}`;
    const child = spawn(context.binary, [...context.args, 'watch', '--all-changes', '--managed-session', session], {
      cwd: repo, env: context.env, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    let failure;
    child.on('error', error => { failure = error; });
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < 80; attempt++) {
      if (failure) throw failure;
      const process = await readJSON(join(context.root, 'process.json'));
      if (process?.managed_session === session && await exists(join(context.root, 'heartbeat.json'))) return;
      if (child.exitCode !== null) throw new Error('Go watcher failed to start; inspect its watch.log.');
      await sleep(100);
    }
    throw new Error('Go watcher startup timed out; inspect its watch.log.');
  });
}

export async function nativeHook(input, options) {
  if (await exists(join(paths().home,'uninstalling.json'))) return {};
  if (!['codex', 'claude'].includes(options.agent) || !input.session_id || !input.cwd) return {};
  if (!['UserPromptSubmit','Stop'].includes(input.hook_event_name)) return {};
  const repo = await workingRepository(input);
  const state = await readState();
  const context = nativeContext(state, options.agent);
  if (!repo) {
    // No guessing from the prompt. Go can retain the prompt until a tool names a repo.
    const global = state.grants.some(g => g.scope === 'global' && g.api === context.api);
    if (!global) return {};
  }
  const approved = await syncNativeConsent(options.agent, context.api, repo);
  if (repo) await ensureWatcher(approved, repo);
  const result = await run(approved.binary, [...approved.args, 'watch', 'hook', '--state', approved.root, '--agent', options.agent], {
    env: approved.env, input: JSON.stringify(input), timeout: 35000, maxBytes: 2 * 1024 * 1024,
  });
  return JSON.parse(result.toString() || '{}');
}

export async function stopNativeWatchers(api) {
  const state = await readState();
  if (!state.native?.path) return;
  for (const agent of ['codex', 'claude', 'manual']) {
    const context = nativeContext(state, agent, api);
    if (await exists(join(context.root, 'config.json'))) {
      await run(context.binary, [...context.args, 'watch', 'stop'], { env: context.env });
    }
  }
}
