import { randomBytes } from 'node:crypto';
import { readFile, lstat, symlink, rename, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { nativePath, metadata, developmentInstall, otherState, hash, run, readState, changeState, atomicWrite, exists } from './system.js';

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

export async function supportsWatch(binary) {
  try {
    const options = { timeout: 5000, maxBytes: 16384 };
    const [watch, hook] = await Promise.all([
      run(binary, ['watch', '--help'], options),
      run(binary, ['watch', 'agent', '--help'], options),
    ]);
    return watch.toString().includes('Watch recursively and review settled changes until stopped')
      && hook.toString().includes('--manager-home') && hook.toString().includes('--agent');
  }
  catch { return false; }
}

export async function supportsCopilot(binary) {
  try {
    const output = await run(binary, ['runtime-info'], { timeout: 5000, maxBytes: 16384 });
    return JSON.parse(output).capabilities?.watchCopilotHooks === true;
  } catch { return false; }
}

async function requireCopilotHooks(binary) {
  if (!await supportsCopilot(binary)) throw new Error('GitHub Copilot hooks require a newer Doomer CLI with Copilot support.');
}

async function withStagedNative(bytes, use) {
  const directory = await mkdtemp(join(tmpdir(), 'doomer-native-'));
  try {
    const path = join(directory, process.platform === 'win32' ? 'doomer.exe' : 'doomer');
    await atomicWrite(path, bytes, 0o755);
    return await use(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function activateNative(native) {
  const executable = nativePath();
  const temporary = join(dirname(executable), `.doomer-${randomBytes(8).toString('hex')}`);
  try {
    if (resolve(native.path) !== executable) {
      await symlink(basename(native.path), temporary);
      await rename(temporary, executable);
    }
  } finally { await rm(temporary, { force: true }); }
  await changeState(state => {
    state.native = native;
    state.executable = executable;
    state.binaries ??= {};
    state.binaries[native.path] = native.sha256;
  });
  return { ...native, executable, onPath: (process.env.PATH || '').split(':').includes(dirname(executable)) };
}

async function installVersion(binary, version, source, requireCopilot = false) {
  const sha256 = hash(binary);
  const suffix = source === 'local' ? 'dev' : version;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(suffix)) throw new Error('Invalid native CLI version.');
  const path = join(dirname(nativePath()), `doomer-${suffix}`);
  if (requireCopilot) await withStagedNative(binary, requireCopilotHooks);
  if (source === 'local') {
    const other = await otherState();
    if (other.native?.path === path && other.binaries?.[path]) throw new Error('The other installation uses doomer-dev. Keep production on a released binary before installing a separate development build.');
    await atomicWrite(path, binary, 0o755);
  } else if (await exists(path)) {
    if (!(await lstat(path)).isFile() || hash(await readFile(path)) !== sha256) throw new Error(`Installed version differs: ${path}`);
  } else await atomicWrite(path, binary, 0o755);
  const reported = (await run(path, ['--version'])).toString().trim();
  if (source !== 'local' && !new RegExp(`^doomer\\s+${version.replaceAll('.', '\\.')}($|\\s)`).test(reported)) throw new Error('Native CLI version does not match the release manifest.');
  return activateNative({ path, version, source, sha256, watch: await supportsWatch(path) });
}

export function validateCLIVersion(version) {
  if (version === undefined) return;
  if (!/^20\d{2}\.\d{1,2}\.\d{1,2}(?:\.\d+)?(?:-beta\.\d+)?$/.test(version)) throw new Error('Invalid --cli-version: expected a published Doomer release version.');
  if (process.env.DOOMER_NATIVE_BINARY || developmentInstall()) throw new Error('--cli-version cannot be combined with a local development CLI.');
}

async function resolveNative({ update = false, version, packageMetadata = metadata } = {}) {
  validateCLIVersion(version);
  const state = await readState();
  if (developmentInstall() && !process.env.DOOMER_NATIVE_BINARY) throw new Error('Development installation requires DOOMER_NATIVE_BINARY pointing to your locally built Go CLI.');
  if (process.env.DOOMER_NATIVE_BINARY) {
    const path = resolve(process.env.DOOMER_NATIVE_BINARY);
    const version = (await run(path, ['--version'])).toString().trim();
    return { bytes: await readFile(path), version, source: 'local' };
  }
  const installed = state.native;
  const beta = packageMetadata.version.includes('-beta.');
  const packagePin = beta ? packageMetadata.doomer?.cliVersion : undefined;
  if (beta && !packagePin) throw new Error('Beta installer is missing its tested Go CLI version.');
  const selectedVersion = version ?? (installed?.source === 'pinned' ? installed.version : undefined) ?? packagePin;
  validateCLIVersion(selectedVersion);
  if (!update && !(installed?.source === 'package-pinned' && !packagePin) && (!selectedVersion || (['pinned', 'package-pinned'].includes(installed?.source) && installed.version === selectedVersion)) && installed?.path && dirname(installed.path) === dirname(nativePath()) && state.binaries?.[installed.path] && await exists(installed.path)) {
    if (!(await lstat(installed.path)).isFile()) throw new Error('Installed native CLI has changed. Reinstall with DOOMER_NATIVE_BINARY or update.');
    const bytes = await readFile(installed.path);
    if (hash(bytes) !== installed.sha256) throw new Error('Installed native CLI has changed. Reinstall with DOOMER_NATIVE_BINARY or update.');
    return { ...installed, bytes, cached: true };
  }
  const { manifest, asset } = selectedVersion ? await pinnedRelease(selectedVersion) : await stableRelease();
  const archive = await download(asset.url, 64 * 1024 * 1024);
  if (hash(archive) !== asset.sha256) throw new Error('Native release checksum mismatch.');
  const source = selectedVersion ? (version || installed?.source === 'pinned' ? 'pinned' : 'package-pinned') : 'stable';
  return { bytes: archiveBinary(archive), version: manifest.version, source };
}

export async function installNative(options = {}) {
  const native = await resolveNative(options);
  const requireCopilot = options.requireCopilot || (await readState()).agents?.includes('copilot');
  if (native.cached) {
    const { bytes, cached, ...receipt } = native;
    if (requireCopilot) await requireCopilotHooks(receipt.path);
    return activateNative({ ...receipt, watch: await supportsWatch(receipt.path) });
  }
  return installVersion(native.bytes, native.version, native.source, requireCopilot);
}

// Stage a verified candidate without changing the current installation. Go
// commits the binary and settings after it has the required user decisions.
export async function withNativeSetup(options, setup) {
  const native = await resolveNative({ ...options, update: true });
  return withStagedNative(native.bytes, async path => {
    if (options.requireCopilot || (await readState()).agents?.includes('copilot')) await requireCopilotHooks(path);
    const reported = (await run(path, ['--version'], { timeout: 5000 })).toString().trim();
    if (native.source !== 'local' && reported.split(/\s+/)[1] !== native.version) throw new Error('Native CLI version does not match the release manifest.');
    const help = await run(path, ['npm-setup', '--help'], { maxBytes: 16384, timeout: 5000 })
      .catch(() => Buffer.alloc(0));
    if (!help.toString().includes('--release-sha256')) {
      throw new Error('This Doomer npm package requires a Go CLI with installer support.');
    }
    return setup({ path, version: native.version, source: native.source, sha256: hash(native.bytes) });
  });
}

async function pinnedRelease(version) {
  const platform = `${process.platform}_${{ x64: 'amd64', arm64: 'arm64' }[process.arch] || 'unsupported'}`;
  const name = `doomer_${version}_${platform}.tar.gz`;
  const base = `${RELEASES}releases/${version}/`;
  const manifest = JSON.parse((await download(`${base}release-manifest.json`, 1024 * 1024)).toString());
  const digest = manifest.artifacts?.[name];
  if (manifest.schemaVersion !== 1 || manifest.version !== version || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`No valid native CLI release ${version} for ${platform}.`);
  return { manifest, asset: { url: `${base}${name}`, sha256: digest.slice(7) } };
}

async function stableRelease() {
  const platform = `${process.platform}_${{ x64: 'amd64', arm64: 'arm64' }[process.arch] || 'unsupported'}`;
  const manifest = JSON.parse((await download(`${RELEASES}stable.json`, 1024 * 1024)).toString());
  const asset = manifest.assets?.[platform];
  if (manifest.schema_version !== 1 || !/^20\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/.test(manifest.version) || !asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`No valid native CLI release for ${platform}.`);
  const expectedURL = `${RELEASES}releases/${manifest.version}/doomer_${manifest.version}_${platform}.tar.gz`;
  if (asset.url !== expectedURL) throw new Error('Native release URL does not match its version.');
  return { manifest, asset };
}

// CLI-only maintenance never installs skills or rewrites agent hook settings.
export async function upgradeNative({ check = false } = {}) {
  const state = await readState();
  const current = state.native;
  if (current?.source === 'package-pinned') throw new Error('This CLI is pinned to the installer beta. Run npx @doomerlabs/doomer@beta update for the next tested beta.');
  if (current?.source === 'pinned') throw new Error('This CLI is pinned. Run install --cli-version VERSION to select another release.');
  if (!current || current.source !== 'stable' || developmentInstall() || process.env.DOOMER_NATIVE_BINARY) {
    throw new Error('CLI-only upgrade requires a released Node-managed installation; development binaries remain user-built.');
  }
  if (!state.binaries?.[current.path] || !(await exists(current.path)) || !(await lstat(current.path)).isFile() || hash(await readFile(current.path)) !== current.sha256) {
    throw new Error('Installed native CLI has changed; repair the installation before upgrading.');
  }
  const { manifest, asset } = await stableRelease();
  const parts = value => value.split('.').map(Number);
  if (!/^20\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/.test(current.version)) throw new Error('Invalid installed CLI version.');
  const previous = parts(current.version), next = parts(manifest.version);
  const first = next.findIndex((value, i) => value !== previous[i]);
  const available = first >= 0 && next[first] > previous[first];
  if (!check && available) {
    const archive = await download(asset.url, 64 * 1024 * 1024);
    if (hash(archive) !== asset.sha256) throw new Error('Native release checksum mismatch.');
    await installVersion(archiveBinary(archive), manifest.version, 'stable', state.agents?.includes('copilot'));
  }
  return { state: available ? (check ? 'update_available' : 'updated') : 'current', currentVersion: current.version, latestVersion: manifest.version, manager: 'node' };
}
