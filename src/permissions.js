import { endpoint } from './api.js';

export const serviceLabel = api => new URL(endpoint(api)).origin;
export const uploadDisclosure = api => `Doomer sends source snapshots, task context, and finding decisions with explanations to ${serviceLabel(api)} for all repositories it reviews.`;

export function hasUploadApproval(state, api, repo, agent) {
  const service = endpoint(api);
  return state.grants.some(grant => grant.api === service && (
    grant.scope === 'global' ||
    (grant.repo === repo && (!agent || grant.agents?.includes(agent)))
  ));
}
