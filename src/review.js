import { readState, run } from './system.js';
import { endpoint } from './api.js';
import { hasUploadApproval, serviceLabel } from './permissions.js';
import { repositoryRoot } from './snapshot.js';
import { question } from './setup.js';
import { syncNativeConsent, nativeContext } from './native.js';

export async function review(options, id) {
  const state = await readState();
  const service = endpoint(options['api-url'] || state.api);
  let context = nativeContext(state, 'manual', service);
  let args;
  if (id) {
    context = await syncNativeConsent('manual', service, undefined, true);
    args = ['review', 'get', id, '--workspace'];
  } else {
    const repo = await repositoryRoot(options.repo);
    let approved = hasUploadApproval(state, service, repo);
    if (!approved && options['approve-upload']) approved = true;
    if (!approved) {
      if (!process.stdin.isTTY) throw new Error('Upload approval is required. Run doomer onboard or explicitly authorize this review with --approve-upload.');
      approved = /^y(es)?$/i.test(await question(`Upload source snapshots to Doomer (${serviceLabel(service)}) for this Quick review? [y/N] `));
    }
    if (!approved) throw new Error('Review cancelled; no source uploaded.');
    context = await syncNativeConsent('manual', service, repo, true);
    args = ['review', '--path', repo, '--deep-review=false'];
    if (options.base) args.push('--base', options.base);
    if (options.wait) args.push('--wait', options.wait === 'quick' ? 'look-closer' : options.wait);
    if (options.timeout) args.push('--timeout', `${options.timeout}s`);
    if (options['show-diff']) args.push('--show-diff');
  }
  if (options.json) args.push('--format', 'json');
  await run(context.binary, [...context.args, ...args], {env:context.env, stdio:'inherit'});
}
