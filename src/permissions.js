import { endpoint } from './api.js';

export const serviceLabel = api => new URL(endpoint(api)).origin;
export const uploadPrompt = api => `Allow Doomer reviews to upload source snapshots to Doomer (${serviceLabel(api)})? [y/N] `;

export function hasUploadApproval(state, api, repo, agent) {
  const service = endpoint(api);
  return state.grants.some(grant => grant.api === service && (
    grant.scope === 'global' ||
    (grant.repo === repo && (!agent || grant.agents?.includes(agent)))
  ));
}
