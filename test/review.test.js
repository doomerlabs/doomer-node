import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fixture, exec } from './helpers.js';
import { entry, hash } from '../src/system.js';

test('CLI submits real snapshots and Quick-only reviews, resumes, and hooks invoke review without the skill', async t => {
  const { dir } = await fixture(); const home = await mkdtemp(join(tmpdir(), 'doomer-home-'));
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const snapshots = []; const packs = []; let submissions = 0; let statusCalls = 0; let uploadCalls = 0;
  let origin;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); const body = req.method === 'POST' ? JSON.parse(bytes) : undefined;
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/upload/')) {
        assert.equal(req.headers.authorization, undefined);
        const pack = packs[Number(req.url.split('/').at(-1).split('?')[0])];
        for (const e of pack.entries) assert.equal(hash(gunzipSync(bytes.subarray(e.byte_offset, e.byte_offset + e.length))), e.sha256);
        uploadCalls++; res.end('{}'); return;
      }
      assert.match(req.headers.authorization, /^Bearer doomer_anon_/);
      if (req.url === '/api/v1/repositories') {
        snapshots.push(body);
        const n = snapshots.length;
        res.end(JSON.stringify({ repository_id: 'repo', snapshot_id: `tree${n}`, missing: body.files.map(f => ({ ...f, upload_url: `/api/v1/repositories/blobs/${f.sha256}` })), pack_url: '/api/v1/repositories/packs' }));
      } else if (req.url === '/api/v1/repositories/packs') {
        if (body.action === 'create') {
          const n = packs.push(body) - 1;
          res.end(JSON.stringify({ id: `pack${n}`, upload_url: `${origin}/upload/${n}?signature=test`, headers: { 'Content-Type': 'application/octet-stream' } }));
        } else res.end('{"complete":true}');
      } else if (req.url.includes('/finalize')) {
        res.end(JSON.stringify({ repository_id: 'repo', snapshot_id: req.url.split('/')[6], complete: true }));
      } else if (req.url === '/api/v1/reviews/workspace?view=status') {
        assert.equal(body.full_review, false); assert.equal(body.look_closer, true);
        assert.match(body.diff, /answer = 2/);
        assert.equal(body.base_snapshot_id.startsWith('tree'), true);
        submissions++;
        res.end(JSON.stringify({ id: 'quick1', status: 'running', early_assessment: { status: 'pending' }, full_review: { enabled: false } }));
      } else if (req.url === '/api/v1/reviews/workspace/quick1?view=status') {
        statusCalls++;
        res.end(JSON.stringify({ id: 'quick1', status: 'running', early_assessment: { status: 'ready', leads: [{ path: 'source.js', line: 1, concern: 'Test concern', check: 'Test check' }] } }));
      } else { res.statusCode = 404; res.end('{}'); }
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, DOOMER_HOME: home };
  const cli = (args, extra = {}) => exec(process.execPath, [entry, ...args], { cwd: dir, env, ...extra });
  const hookCLI = async input => {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, 'hook', '--agent', 'codex'], { cwd: dir, env });
      let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.resume();
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('hook failed')));
      child.stdin.end(JSON.stringify(input));
    });
  };
  await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1, agents: ['codex'], api: `${origin}/api`, grants: [{ repo: dir, api: `${origin}/api`, agents: ['codex'] }] }));
  await hookCLI({ hook_event_name: 'UserPromptSubmit', session_id: 'session/../one', cwd: dir });
  await writeFile(join(dir, 'source.js'), 'export const answer = 2;\n');
  // No approval: no network requests, even when the process is noninteractive.
  await assert.rejects(cli(['review', '--api-url', `${origin}/api`, '--agent', 'claude']), /Upload approval/);
  assert.equal(snapshots.length, 0);
  const result = JSON.parse((await cli(['review', '--api-url', `${origin}/api`, '--approve-upload', '--json'])).stdout);
  assert.equal(result.ready, true); assert.equal(result.leads.length, 1);
  assert.equal(snapshots.length, 2); assert.equal(uploadCalls, 2); assert.equal(submissions, 1);
  await cli(['review', '--api-url', `${origin}/api`, '--approve-upload', '--json']);
  assert.equal(submissions, 1, 'identical source resumes the existing review');
  assert.ok(statusCalls >= 2);
  const hookResult = await hookCLI({ hook_event_name: 'Stop', session_id: 'session/../one', cwd: dir });
  // The manual review already covered this exact source, so the hook can reuse it.
  assert.deepEqual(hookResult, {});
  await writeFile(join(dir, 'source.js'), 'export const answer = 2;\n// next edit\n');
  const next = await hookCLI({ hook_event_name: 'Stop', session_id: 'session/../one', cwd: dir });
  assert.equal(next.decision, 'block'); assert.match(next.reason, /Test concern/);
  assert.equal(submissions, 2, 'Stop submits the next source automatically without reading a skill');
  const repeated = await hookCLI({ hook_event_name: 'Stop', session_id: 'session/../one', cwd: dir, stop_hook_active: true });
  assert.deepEqual(repeated, {}); assert.equal(submissions, 2);
});
