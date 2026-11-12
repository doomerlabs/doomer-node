import { randomBytes } from 'node:crypto';
import { readFile, lstat, symlink, rename, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { resolveAPI } from './api.js';
import { paths, nativePath, hash, run, readState, changeState, readJSON, writeJSON, atomicWrite, locked, exists } from './system.js';
import { hasUploadApproval } from './permissions.js';

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

async function supportsWatch(binary) {
  try { return (await run(binary, ['watch', '--help'])).toString().includes('Watch recursively and review settled changes until stopped'); }
  catch { return false; }
}

async function activateNative(native) {
  const executable = nativePath();
  const temporary = join(dirname(executable), `.doomer-${randomBytes(8).toString('hex')}`);
  try {
    await symlink(basename(native.path), temporary);
    await rename(temporary, executable);
  } finally { await rm(temporary, { force: true }); }
  await changeState(state => {
    state.native = native;
    state.executable = executable;
    state.binaries ??= {};
    state.binaries[native.path] = native.sha256;
  });
  return { ...native, executable, onPath: (process.env.PATH || '').split(':').includes(dirname(executable)) };
}

async function installVersion(binary, version, source) {
  const sha256 = hash(binary);
  const label = source === 'local' ? /^doomer\s+([a-z0-9][a-z0-9._-]*)/i.exec(version)?.[1] : version;
  if (!label || !/^[a-z0-9][a-z0-9._-]*$/i.test(label)) throw new Error('Invalid native CLI version.');
  const suffix = source === 'local' ? `${label}-${sha256.slice(0, 12)}` : label;
  const path = join(dirname(nativePath()), `doomer-${suffix}`);
  if (await exists(path)) {
    if (!(await lstat(path)).isFile() || hash(await readFile(path)) !== sha256) throw new Error(`Installed version differs: ${path}`);
  } else await atomicWrite(path, binary, 0o755);
  const reported = (await run(path, ['--version'])).toString().trim();
  if (source === 'stable' && !reported.includes(version)) throw new Error('Native CLI version does not match the release manifest.');
  return activateNative({ path, version, source, sha256, watch: await supportsWatch(path) });
}

export async function installNative({ update = false } = {}) {
  const state = await readState();
  if (process.env.DOOMER_NATIVE_BINARY) {
    const source = resolve(process.env.DOOMER_NATIVE_BINARY);
    const version = (await run(source, ['--version'])).toString().trim();
    return installVersion(await readFile(source), version, 'local');
  }
  const installed = state.native;
  if (!update && installed?.path && dirname(installed.path) === dirname(nativePath()) && state.binaries?.[installed.path] && await exists(installed.path)) {
    if (!(await lstat(installed.path)).isFile() || hash(await readFile(installed.path)) !== installed.sha256) throw new Error('Installed native CLI has changed. Reinstall with DOOMER_NATIVE_BINARY or update.');
    return activateNative({ ...installed, watch: await supportsWatch(installed.path) });
  }
  const platform = `${process.platform}_${{ x64: 'amd64', arm64: 'arm64' }[process.arch] || 'unsupported'}`;
  const manifest = JSON.parse((await download(`${RELEASES}stable.json`, 1024 * 1024)).toString());
  const asset = manifest.assets?.[platform];
  if (manifest.schema_version !== 1 || !/^20\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/.test(manifest.version) || !asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`No valid native CLI release for ${platform}.`);
  const expectedURL = `${RELEASES}releases/${manifest.version}/doomer_${manifest.version}_${platform}.tar.gz`;
  if (asset.url !== expectedURL) throw new Error('Native release URL does not match its version.');
  const archive = await download(asset.url, 64 * 1024 * 1024);
  if (hash(archive) !== asset.sha256) throw new Error('Native release checksum mismatch.');
  return installVersion(archiveBinary(archive), manifest.version, 'stable');
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
