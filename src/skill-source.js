import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { run } from './system.js';

// Reviewed production skill revision. Change only with matching onboarding validation.
export const SKILL_SOURCE = 'doomerlabs/skills#4b72a27ea8672e6af167616f19810a6319efdbc3';

export async function withPinnedSkillCheckout(repository, revision, install) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid pinned skill revision.');
  const temporary = await mkdtemp(join(tmpdir(), 'doomer-skill-'));
  const checkout = join(temporary, 'checkout');
  const git = args => run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    timeout: 60000, maxBytes: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  try {
    await git(['init', '--quiet', checkout]);
    await git(['-C', checkout, 'remote', 'add', 'origin', repository]);
    await git(['-C', checkout, 'fetch', '--quiet', '--depth=1', 'origin', revision]);
    await git(['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    const actual = (await git(['-C', checkout, 'rev-parse', 'HEAD'])).toString().trim();
    if (actual !== revision) throw new Error('Downloaded skill does not match its pinned revision.');
    return await install(checkout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function withSkillSource(install, source = SKILL_SOURCE) {
  // Captured local component sources are used by the shared E2E runner.
  if (isAbsolute(source)) return install(source);
  const match = /^doomerlabs\/skills#([a-f0-9]{40})$/.exec(source);
  if (!match) throw new Error('Invalid official skill source.');
  return withPinnedSkillCheckout('https://github.com/doomerlabs/skills.git', match[1], install);
}
