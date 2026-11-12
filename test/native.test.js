import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveBinary } from '../src/native.js';
import { gzipSync } from 'node:zlib';

test('native archive supports the published ./doomer path and rejects symlinks', () => {
  const header=Buffer.alloc(512);header.write('./doomer');header.write('00000000004\0',124);header[156]=48;
  const archive=()=>gzipSync(Buffer.concat([header,Buffer.from('test'),Buffer.alloc(508),Buffer.alloc(1024)]));
  assert.equal(archiveBinary(archive()).toString(),'test');
  header[156]=50;
  assert.throws(()=>archiveBinary(archive()),/Invalid native release executable/);
});
