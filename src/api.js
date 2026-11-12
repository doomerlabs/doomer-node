import { gzipSync } from 'node:zlib';
import { hash } from './system.js';

export const DEFAULT_API = 'https://doomer.ai/api';
export function endpoint(value = DEFAULT_API) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('API URL must use HTTPS (HTTP is allowed only on loopback).');
  return url.href.replace(/\/$/, '');
}
const validID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export class API {
  constructor(base, token) { this.base = endpoint(base); this.token = token; }
  async request(path, body) {
    if (!path.startsWith('/v1/')) throw new Error('Invalid API path.');
    const response = await fetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Doomer API returned HTTP ${response.status}.`);
    const raw = await response.text();
    if (raw.length > 16 * 1024 * 1024) throw new Error('API response exceeds size limit.');
    return JSON.parse(raw);
  }
  async upload(files, repository) {
    const blobs = new Map(files.map(f => [f.sha256, Buffer.from(f.content, 'base64')]));
    const manifest = files.map(f => ({ path: f.path, mode: f.mode, sha256: f.sha256, size: blobs.get(f.sha256).length }));
    let state = await this.request('/v1/repositories', { repository, files: manifest, verification_limit: 256, protocol: 'packs-v1' });
    const repo = state.repository_id; const snapshot = state.snapshot_id;
    if (!validID(repo) || !validID(snapshot)) throw new Error('Invalid snapshot identity.');
    const finalize = `/api/v1/repositories/${repo}/snapshots/${snapshot}/finalize`;
    for (let round = 0; round < 2 * Math.ceil(files.length / 256) + 10; round++) {
      if (state.repository_id !== repo || state.snapshot_id !== snapshot) throw new Error('Snapshot identity changed during upload.');
      const missing = state.missing || [];
      if (state.complete) {
        if (missing.length) throw new Error('Inconsistent complete snapshot.');
        return { repository_id: repo, snapshot_id: snapshot };
      }
      if ((!missing.length && !state.checking) || (state.finalize_url && state.finalize_url !== finalize)) throw new Error('Invalid snapshot upload response.');
      if (missing.length && state.pack_url !== '/api/v1/repositories/packs') throw new Error('Server does not support pack uploads.');
      // Bounded batches keep temporary compressed buffers small.
      let batch = []; let size = 0;
      for (const item of missing) {
        const bytes = blobs.get(item.sha256);
        if (!bytes || bytes.length !== item.size || hash(bytes) !== item.sha256 || item.upload_url !== `/api/v1/repositories/blobs/${item.sha256}`) throw new Error('Server requested content outside this snapshot.');
        if (batch.length && size + bytes.length > 16 * 1024 * 1024) { await this.uploadPack(batch); batch = []; size = 0; }
        batch.push({ sha: item.sha256, bytes }); size += bytes.length;
      }
      if (batch.length) await this.uploadPack(batch);
      state = await this.request(finalize.slice(4) + '?verification_limit=256', {});
    }
    throw new Error('Snapshot upload did not complete.');
  }
  async uploadPack(blobs) {
    const chunks = []; const entries = []; let offset = 0;
    for (const { sha, bytes } of blobs) {
      const compressed = gzipSync(bytes, { level: 1 });
      entries.push({ sha256: sha, size: bytes.length, byte_offset: offset, length: compressed.length });
      chunks.push(compressed); offset += compressed.length;
    }
    const data = Buffer.concat(chunks);
    const session = await this.request('/v1/repositories/packs', { action: 'create', sha256: hash(data), compressed_size: data.length, entries });
    if (!validID(session.id)) throw new Error('Invalid pack session.');
    const destination = new URL(session.upload_url);
    if (destination.username || destination.password || destination.hash || (destination.protocol !== 'https:' && !(destination.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)))) throw new Error('Invalid signed upload destination.');
    const headers = {};
    for (const [key, value] of Object.entries(session.headers || {})) {
      const lower = key.toLowerCase();
      if (lower === 'content-length' && String(value) === String(data.length)) continue;
      if (!['content-type', 'x-amz-checksum-sha256'].includes(lower)) throw new Error('Unsupported signed upload header.');
      headers[key] = value;
    }
    // Signed URLs include query strings. Validate separately, and never forward API credentials.
    const response = await fetch(destination, { method: 'PUT', body: data, headers, redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Pack upload returned HTTP ${response.status}.`);
    if (!(await this.request('/v1/repositories/packs', { action: 'complete', id: session.id })).complete) throw new Error('Pack verification failed.');
  }
  async get(id) {
    if (!validID(id)) throw new Error('Invalid review ID.');
    const result = await this.request(`/v1/reviews/workspace/${id}?view=status`);
    if (result.id !== id) throw new Error('Review identity changed.');
    return result;
  }
  async start(input) {
    const result = await this.request('/v1/reviews/workspace?view=status', input);
    if (!validID(result.id)) throw new Error('Invalid review ID.');
    return result;
  }
}
