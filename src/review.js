import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { API, endpoint } from './api.js';
import { paths, hash, readState, readJSON, writeJSON, changeState, locked, metadata, quote } from './system.js';
import { repositoryRoot, repositoryName, baseline, worktree, fingerprint, diffSnapshots, git } from './snapshot.js';
import { question } from './setup.js';

export const sessionPath = (root, agent, id) => join(paths().home, 'sessions', `${hash(JSON.stringify([root, agent, id]))}.json`);
const receiptPath = (root, api, digest) => join(paths().home, 'reviews', `${hash(JSON.stringify([root, api, digest]))}.json`);
export async function client(api) {
  const base = endpoint(api || (await readState()).api);
  let token = process.env.DOOMER_TOKEN;
  if (!token) {
    const state = await changeState(s => {
      s.identities ??= {};
      s.identities[base] ||= `doomer_anon_${randomBytes(32).toString('base64url')}`;
    });
    token = state.identities[base];
  }
  return new API(base, token);
}
export async function waitQuick(api, initial, seconds = 60) {
  let review = initial;
  const deadline = Date.now() + seconds * 1000;
  while (true) {
    if (review.early_assessment?.status === 'ready') return review;
    if (review.early_assessment?.status === 'unavailable' || ['failed', 'cancelled', 'expired', 'completed'].includes(review.status)) throw new Error('Quick review ended without a ready result.');
    if (Date.now() >= deadline) return review;
    await sleep(Math.min(1000, deadline - Date.now()));
    review = await api.get(review.id);
  }
}
export async function review(options) {
  const root = await repositoryRoot(options.repo);
  const api = endpoint(options['api-url'] || (await readState()).api);
  let session;
  if (options.session) {
    if (!options.agent) throw new Error('--session requires --agent.');
    session = await readJSON(sessionPath(root, options.agent, options.session));
    if (!session || session.root !== root) throw new Error('No captured baseline for this agent session.');
  }
  const before = session ? session.files : (await baseline(root, options.base)).files;
  const after = await worktree(root);
  const digest = fingerprint(after);
  if (fingerprint(before) === digest) return { state: 'no_changes', ready: true, repository: root, leads: [] };
  if (!options['approve-upload']) {
    const state = await readState();
    const permitted = state.grants.some(g => g.repo === root && g.api === api && (!options.agent || g.agents.includes(options.agent)));
    if (!permitted) {
      if (!process.stdin.isTTY) throw new Error('Upload approval is required. A human can run this review with --approve-upload, or approve the repository during doomer onboard.');
      const answer = await question(`Upload baseline and current source snapshots from ${root} to ${api} for this Quick review? [y/N] `);
      if (!/^y(es)?$/i.test(answer)) throw new Error('Review cancelled; no source was uploaded.');
    }
  }
  const file = receiptPath(root, api, hash(fingerprint(before) + digest));
  return locked(file, async () => {
    const service = await client(api);
    let saved = await readJSON(file);
    let result;
    if (saved?.id) result = await service.get(saved.id);
    else {
      const diff = await diffSnapshots(before, after);
      if (!diff) return { state: 'no_changes', ready: true, repository: root, leads: [] };
      if (options['show-diff']) process.stderr.write(diff);
      if (!saved?.input) {
        console.error('Uploading source snapshots for Quick review…');
        const repository = await repositoryName(root);
        const base = await service.upload(before, repository);
        const target = await service.upload(after, repository);
        if (base.repository_id !== target.repository_id) throw new Error('Snapshot repository identity changed.');
        const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toString().trim();
        saved = { root, api, digest, input: {
          repository_id: target.repository_id, base_snapshot_id: base.snapshot_id, snapshot_id: target.snapshot_id,
          repository, branch, diff, review_scope: 'diff', look_closer: true, full_review: false, look_closer_threshold: 80,
          review_id: `node-${randomUUID()}`, review_group_id: '', revision: 0, review_continuity: false,
          client: { name: 'Doomer Node CLI', cli_version: metadata.version, notice_schema: '1' },
        } };
        await writeJSON(file, saved);
      }
      result = await service.start(saved.input);
      saved.id = result.id;
      await writeJSON(file, saved);
    }
    if (result.look_closer_enabled === false || (result.full_review && result.full_review.enabled)) throw new Error('Server did not honor the Quick-only review request.');
    result = await waitQuick(service, result, options.wait === 'none' ? 0 : Number(options.timeout ?? 60));
    saved.result = result;
    saved.ready = result.early_assessment?.status === 'ready';
    await writeJSON(file, saved);
    if (saved.ready) await writeJSON(join(paths().home, 'reviewed', `${hash(JSON.stringify([root, api, digest]))}.json`), { id: result.id, root, digest, api });
    return { ...result, state: saved.ready ? 'ready' : 'pending', ready: saved.ready, repository: root, leads: result.early_assessment?.leads || [], next: saved.ready ? undefined : `doomer review get ${result.id}` };
  });
}

export async function getReview(id, options) {
  const service = await client(options['api-url']);
  const result = await waitQuick(service, await service.get(id), options.wait === 'none' ? 0 : Number(options.timeout ?? 60));
  return { ...result, ready: result.early_assessment?.status === 'ready', leads: result.early_assessment?.leads || [] };
}

export function printReview(result, json = false) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  if (result.state === 'no_changes') return console.log('No changes to review.');
  console.log(result.ready ? 'Doomer Quick review ready.' : `Doomer Quick review pending (${result.id}).`);
  for (const lead of result.leads) console.log(`\n${lead.path}:${lead.line}\n${lead.concern}\nCheck: ${lead.check}`);
  if (result.ready && !result.leads.length) console.log('No Quick findings.');
  if (result.url) console.log(`\n${result.url}`);
  if (result.next) console.log(`\nResume: ${result.next}`);
}

export async function hook(input, options) {
  const agent = options.agent;
  if (!['claude', 'codex'].includes(agent) || !input.session_id || !input.cwd) return {};
  if (!['UserPromptSubmit', 'Stop'].includes(input.hook_event_name)) return {};
  const root = await repositoryRoot(input.cwd);
  const file = sessionPath(root, agent, input.session_id);
  if (input.hook_event_name === 'UserPromptSubmit') {
    const files = await worktree(root);
    await writeJSON(file, { root, files, digest: fingerprint(files), capturedAt: new Date().toISOString() });
    return {};
  }
  const session = await readJSON(file);
  if (!session) return {};
  const files = await worktree(root); const digest = fingerprint(files);
  if (digest === session.digest) return {};
  const state = await readState(); const api = endpoint(state.api);
  if (await readJSON(join(paths().home, 'reviewed', `${hash(JSON.stringify([root, api, digest]))}.json`))) return {};
  const permitted = state.grants.some(g => g.repo === root && g.api === api && g.agents.includes(agent));
  if (!permitted) {
    if (input.stop_hook_active) return {};
    return { decision: 'block', reason: 'Doomer Quick review needs upload approval for this repository. Ask the user to run doomer onboard and approve source uploads, or report that this task was not reviewed. Do not infer consent from hook installation.' };
  }
  // This CLI process performs the review itself: skill discovery is not needed.
  const result = await review({ repo: root, agent, session: input.session_id, timeout: '30' });
  if (!result.ready) {
    if (input.stop_hook_active) return {};
    return { decision: 'block', reason: `Doomer Quick review is still running (${result.id}). Run doomer review get ${result.id}, inspect the result, and report a timeout if it cannot complete.` };
  }
  if (!result.leads.length) return {};
  const summary = JSON.stringify(result.leads.slice(0, 20).map(lead => ({
    path: String(lead.path).slice(0, 500), line: lead.line,
    concern: String(lead.concern).slice(0, 1600), check: String(lead.check).slice(0, 1600),
  })));
  return { decision: 'block', reason: `Doomer Quick review found issues (${result.id}). Inspect and address these findings before finishing (or explain why a finding does not apply). Changes will be reviewed again. Use doomer review get ${result.id} --json for full results.\n${summary}` };
}
