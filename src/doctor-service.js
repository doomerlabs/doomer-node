import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_API, endpoint } from './api.js';

const limit = 64 * 1024;
const keys = new Set(['DOOMER_API_URL', 'DOOMER_CONFIG_DIR', 'DOOMER_TOKEN', 'DOOMER_PROFILE']);

// Match the native watcher's nearest-file, literal-data routing. Never execute
// .envrc or include credential values in diagnostics.
export async function doctorService({ explicit, saved, cwd = process.cwd(), env = process.env } = {}) {
  let directory = await realpath(resolve(cwd));
  let file;
  let values;
  for (;;) {
    const candidate = join(directory, '.doomer.env');
    let handle;
    try {
      // Follow regular-file symlinks like the native watcher, but reject special
      // files before opening. NONBLOCK also protects against a concurrent FIFO swap.
      const before = await stat(candidate);
      if (!before.isFile() || before.size > limit) throw new Error('Invalid .doomer.env: expected a regular file of at most 64 KiB.');
      handle = await open(candidate, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) throw new Error('Invalid .doomer.env: expected a regular file of at most 64 KiB.');
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw new Error('.doomer.env exceeds 64 KiB.');
      values = parseDirectoryEnvironment(buffer.subarray(0, length).toString('utf8'));
      file = candidate;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.code) throw new Error(`Cannot read .doomer.env (${error.code}).`);
        throw error;
      }
    } finally { await handle?.close(); }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const choices = [[explicit, 'flag'], [values?.DOOMER_API_URL, 'directory'], [env.DOOMER_API_URL, 'environment'], [saved, 'saved'], [DEFAULT_API, 'default']];
  const [api, apiSource] = choices.find(([value]) => value);
  let normalized;
  try { normalized = endpoint(api); }
  catch { throw new Error('Invalid Doomer service URL: use HTTPS (HTTP is allowed only on loopback).'); }
  const credentialDirectory = values && Object.hasOwn(values, 'DOOMER_CONFIG_DIR') ? values.DOOMER_CONFIG_DIR : env.DOOMER_CONFIG_DIR;
  return { api: normalized, apiSource, ...(apiSource === 'directory' ? { apiConfigFile: file } : {}), ...(credentialDirectory ? { credentialDirectory } : {}) };
}

function parseDirectoryEnvironment(text) {
  const values = Object.create(null);
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) throw new Error(`Invalid .doomer.env assignment on line ${index + 1}.`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!keys.has(key)) throw new Error(`Unsupported .doomer.env key on line ${index + 1}.`);
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate .doomer.env key on line ${index + 1}.`);
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error(`Unclosed .doomer.env quote on line ${index + 1}.`);
      value = value.slice(1, -1);
    }
    if (/[\0\r\n]/.test(value)) throw new Error(`Invalid .doomer.env value on line ${index + 1}.`);
    if (key === 'DOOMER_API_URL' && !value) throw new Error('DOOMER_API_URL cannot be empty in .doomer.env.');
    if (key === 'DOOMER_CONFIG_DIR' && value && !isAbsolute(value)) throw new Error('DOOMER_CONFIG_DIR must be absolute in .doomer.env.');
    values[key] = value;
  }
  return values;
}
