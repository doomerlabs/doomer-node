import { constants } from 'node:fs';
import { lstat, open, realpath, mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { run, hash } from './system.js';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_FILES = 20000;
export function gitEnv() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
}
export const git = (root, args, options = {}) => run('git', ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv(), ...options });
export async function repositoryRoot(path = '.') {
  return realpath((await git(resolve(path), ['rev-parse', '--show-toplevel'])).toString().trim());
}
function validPath(path) {
  return path && !path.includes('\\') && !path.startsWith('/') && !path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git');
}
function checkSize(files) {
  if (files.length > MAX_FILES || files.reduce((n, f) => n + Buffer.byteLength(f.content, 'base64'), 0) > MAX_TOTAL) throw new Error('Snapshot exceeds 20,000 files or 256 MiB.');
}
function file(path, mode, bytes) {
  if (!validPath(path)) throw new Error(`Unsupported source path: ${JSON.stringify(path)}`);
  if (bytes.length > MAX_FILE) throw new Error(`File exceeds 20 MiB: ${path}`);
  if (bytes.subarray(0, 100).toString().startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error(`Git LFS is not supported: ${path}`);
  return { path, mode, sha256: hash(bytes), content: bytes.toString('base64') };
}
export const fingerprint = files => hash(JSON.stringify(files.map(({ path, mode, sha256 }) => ({ path, mode, sha256 }))));

export async function worktree(root) {
  root = await realpath(root);
  if ((await git(root, ['config', '--bool', 'core.sparseCheckout']).catch(() => Buffer.from('false'))).toString().trim() === 'true') throw new Error('Sparse checkouts are not supported.');
  const index = (await git(root, ['ls-files', '--stage', '-z'])).toString();
  const names = new Set();
  for (const row of index.split('\0').filter(Boolean)) {
    const [mode, , stage] = row.slice(0, row.indexOf('\t')).split(' ');
    if (stage !== '0') throw new Error('Resolve merge conflicts before reviewing.');
    if (!['100644', '100755'].includes(mode)) throw new Error('Symlinks and submodules are not supported.');
    names.add(row.slice(row.indexOf('\t') + 1));
  }
  for (const name of (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean)) names.add(name);
  if (names.size > MAX_FILES) throw new Error('Snapshot exceeds 20,000 files.');
  const files = []; let total = 0;
  for (const name of [...names].sort()) {
    if (!validPath(name)) throw new Error('Unsupported source path');
    let path = root; let missing = false;
    for (const part of name.split('/')) {
      path = join(path, part);
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symlinks are not supported: ${name}`); }
      catch (error) { if (error.code === 'ENOENT') { missing = true; break; } throw error; }
    }
    if (missing) continue;
    if (!(await realpath(path)).startsWith(root + sep)) throw new Error('Source path escaped the repository.');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_FILE) throw new Error(`Unsupported file or file exceeds 20 MiB: ${name}`);
      total += before.size;
      if (total > MAX_TOTAL) throw new Error('Snapshot exceeds 256 MiB.');
      const buffer = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const bytes = buffer.subarray(0, count);
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) throw new Error('Source changed during capture; retry the review.');
      files.push(file(name, before.mode & 0o111 ? '100755' : '100644', bytes));
    } finally { await handle.close(); }
  }
  if ((await git(root, ['ls-files', '--stage', '-z'])).toString() !== index) throw new Error('Index changed during capture; retry the review.');
  return files;
}

export async function baseline(root, ref) {
  let commit;
  if (ref) commit = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString().trim();
  else {
    for (const branch of ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master']) {
      try { commit = (await git(root, ['merge-base', 'HEAD', branch])).toString().trim(); break; } catch { /* Try next local baseline. */ }
    }
    commit ||= (await git(root, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
  }
  const records = (await git(root, ['ls-tree', '-r', '-z', commit])).toString().split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t'); const [mode, type, oid] = row.slice(0, tab).split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Baseline symlinks and submodules are not supported.');
    return { path: row.slice(tab + 1), mode, oid };
  });
  if (records.length > MAX_FILES) throw new Error('Baseline exceeds 20,000 files.');
  const output = await git(root, ['cat-file', '--batch'], { input: records.map(f => f.oid).join('\n') + (records.length ? '\n' : ''), maxBytes: MAX_TOTAL + MAX_FILES * 100 });
  const files = []; let offset = 0;
  for (const record of records) {
    const end = output.indexOf(10, offset);
    const [oid, type, rawSize] = output.subarray(offset, end).toString().split(' '); const size = Number(rawSize);
    if (oid !== record.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || end < 0 || end + size + 1 >= output.length) throw new Error('Invalid Git blob response.');
    files.push(file(record.path, record.mode, output.subarray(end + 1, end + 1 + size)));
    offset = end + size + 2;
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  checkSize(files);
  return { files, commit };
}

export async function diffSnapshots(before, after) {
  const temp = await mkdtemp(join(tmpdir(), 'doomer-diff-'));
  const env = { ...gitEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  const command = args => git(temp, args, { env });
  async function materialize(files) {
    for (const f of files) {
      if (!validPath(f.path)) throw new Error('Invalid snapshot path.');
      const path = join(temp, f.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(f.content, 'base64'));
      await chmod(path, f.mode === '100755' ? 0o755 : 0o644);
    }
  }
  try {
    await command(['init', '-q']);
    await command(['config', 'core.filemode', 'true']);
    await command(['config', 'core.autocrlf', 'false']);
    await materialize(before);
    await command(['add', '-f', '--all']);
    const tree = (await command(['write-tree'])).toString().trim();
    for (const f of before) await rm(join(temp, f.path));
    // Remove empty directories so directory-to-file changes are supported.
    for (const f of before) {
      let parent = dirname(join(temp, f.path));
      while (parent !== temp) { try { await (await import('node:fs/promises')).rmdir(parent); } catch { break; } parent = dirname(parent); }
    }
    await materialize(after);
    await command(['add', '-f', '--all']);
    return (await command(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', tree, '--'])).toString();
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function repositoryName(root) {
  try {
    const remote = (await git(root, ['remote', 'get-url', 'origin'])).toString().trim();
    const path = remote.startsWith('git@') ? remote.slice(remote.indexOf(':') + 1) : new URL(remote).pathname.replace(/^\//, '');
    if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(path)) return path.replace(/\.git$/, '');
  } catch { /* A local-only repository still has a stable private identifier. */ }
  return `local/${hash(root).slice(0, 20)}`;
}
