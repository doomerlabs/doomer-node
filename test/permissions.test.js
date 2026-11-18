import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUploadApproval, uploadDisclosure } from '../src/permissions.js';

test('global approval covers all repositories and agents, only for the selected service', () => {
  const state = { grants: [{scope:'global',api:'https://doomer.ai/api'}] };
  for (const agent of ['claude','codex',undefined]) {
    assert.equal(hasUploadApproval(state,'https://doomer.ai/api','/another/repository',agent),true);
  }
  assert.equal(hasUploadApproval(state,'https://example.com/api','/another/repository','codex'),false);
  assert.equal(hasUploadApproval({grants:[]},'https://doomer.ai/api','/repo','codex'),false);
  assert.match(uploadDisclosure('https://doomer.ai/api'), /source snapshots, task context, and finding decisions with explanations to https:\/\/doomer.ai for all repositories/);
});
