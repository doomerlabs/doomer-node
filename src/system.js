import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const entry = join(packageRoot, 'bin', 'doomer.js');
export const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
export const hash = value => createHash('sha256').update(value).digest('hex');
export const quote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

export function paths(env = process.env) {
  const home = resolve(env.DOOMER_HOME || join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'doomer-node'));
  return { home, state: join(home, 'state.json'), bin: join(home, 'bin'), runtime: join(home, 'runtime') };
}

export const nativePath = () => resolve(process.env.DOOMER_BIN_DIR || join(homedir(), '.local', 'bin'), 'doomer');

export async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read valid JSON at ${file}: ${error.message}`); }
}

export async function atomicWrite(file, data, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode, flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
export const writeJSON = (file, value) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
export const readState = () => readJSON(paths().state, { version: 1, agents: [], grants: [] });

// Serialize changes to shared installation/session state; fail rather than steal a lock.
export async function locked(file, work) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try { await mkdir(`${file}.lock`, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another Doomer operation holds ${file}.lock`); throw error; }
  try { return await work(); } finally { await rm(`${file}.lock`, { recursive: true, force: true }); }
}
export async function changeState(work) {
  return locked(paths().state, async () => {
    const state = await readState();
    await work(state);
    await writeJSON(paths().state, state);
    return state;
  });
}

export async function exists(file) {
  try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'], ...options });
    const chunks = []; let bytes = 0; let exceeded = false;
    child.stdout?.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 128 * 1024 * 1024)) { exceeded = true; child.kill(); }
      else chunks.push(chunk);
    });
    // Drain stderr, but do not echo credentials from git/npm error output.
    child.stderr?.resume();
    child.on('error', reject);
    child.on('close', code => {
      if (exceeded) reject(new Error(`${command} output exceeds the size limit`));
      else if (code !== 0) reject(new Error(`${command} failed (exit ${code})`));
      else resolve(Buffer.concat(chunks));
    });
    if (child.stdin) child.stdin.end(options.input);
  });
}

export async function npm(args, options = {}) {
  // npm_execpath is set by npx/npm; invoke the JS CLI without a command shell.
  const executable = process.env.npm_execpath;
  if (executable && /\.(?:c?js|mjs)$/.test(executable)) return run(process.execPath, [executable, ...args], options);
  if (process.platform === 'win32') throw new Error('Run setup through npx on Windows so npm_execpath is available.');
  return run('npm', args, options);
}
