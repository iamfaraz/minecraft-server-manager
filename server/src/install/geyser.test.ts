import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasFabricApi } from './java.js';

test('hasFabricApi spots Fabric API or Quilted Fabric API already in mods/', async () => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'fapi-'));
  assert.equal(await hasFabricApi(d), false);
  await fsp.writeFile(path.join(d, 'other.jar'), '');
  assert.equal(await hasFabricApi(d), false);
  await fsp.writeFile(path.join(d, 'qfapi-7.5.0_qsl-6.1.2_fapi-0.92.2_mc-1.20.1.jar'), '');
  assert.equal(await hasFabricApi(d), true);
  const d2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'fapi-'));
  await fsp.writeFile(path.join(d2, 'fabric-api-0.92.12+1.20.1.jar'), '');
  assert.equal(await hasFabricApi(d2), true);
  assert.equal(await hasFabricApi(path.join(d2, 'missing')), false);
});
