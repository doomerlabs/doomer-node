// Repository location only. The Go CLI owns source capture and review uploads.
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { run } from './system.js';

export function gitEnv() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
}
export const git = (root, args) => run('git', ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv() });
export async function repositoryRoot(path = '.') {
  return realpath((await git(resolve(path), ['rev-parse', '--show-toplevel'])).toString().trim());
}
