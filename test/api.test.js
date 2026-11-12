import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAPI, DEFAULT_API} from '../src/api.js';

test('API selection follows flag, environment, saved setting, production precedence',()=>{
  const env={DOOMER_API_URL:'http://localhost:3000/api'};
  assert.equal(resolveAPI('http://localhost:4000/api',DEFAULT_API,env),'http://localhost:4000/api');
  assert.equal(resolveAPI(undefined,DEFAULT_API,env),'http://localhost:3000/api');
  assert.equal(resolveAPI(undefined,'http://localhost:5000/api',{}),'http://localhost:5000/api');
  assert.equal(resolveAPI(undefined,undefined,{}),DEFAULT_API);
  assert.throws(()=>resolveAPI(undefined,undefined,{DOOMER_API_URL:'http://example.com/api'}),/HTTPS/);
});
