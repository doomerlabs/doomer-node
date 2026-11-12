import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUploadApproval, uploadPrompt, acceptsUploadAnswer } from '../src/permissions.js';

test('global approval covers all repositories and agents, only for the selected service', () => {
  const state = { grants: [{scope:'global',api:'https://doomer.ai/api'}] };
  for (const agent of ['claude','codex',undefined]) {
    assert.equal(hasUploadApproval(state,'https://doomer.ai/api','/another/repository',agent),true);
  }
  assert.equal(hasUploadApproval(state,'https://example.com/api','/another/repository','codex'),false);
  assert.equal(hasUploadApproval({grants:[]},'https://doomer.ai/api','/repo','codex'),false);
  assert.equal(uploadPrompt('https://doomer.ai/api'),'Allow Doomer reviews to upload source snapshots to Doomer (https://doomer.ai)? [Y/n] ');
});

test('upload prompt accepts Enter by default and honors an explicit no', () => {
  for (const answer of ['', ' ', 'y', 'Y', 'yes']) assert.equal(acceptsUploadAnswer(answer), true);
  for (const answer of ['n', 'N', 'no', 'invalid']) assert.equal(acceptsUploadAnswer(answer), false);
});

test('legacy repository grants are not silently broadened', () => {
  const state = { grants: [{repo:'/original',agents:['codex'],api:'https://doomer.ai/api'}] };
  assert.equal(hasUploadApproval(state,'https://doomer.ai/api','/original','codex'),true);
  assert.equal(hasUploadApproval(state,'https://doomer.ai/api','/another','codex'),false);
  assert.equal(hasUploadApproval(state,'https://doomer.ai/api','/original','claude'),false);
});
