import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFabricLoader, pickForgeVersion, pickNeoForgeVersion } from './java.js';

const fabric = [
  { loader: { version: '0.16.10', stable: false } },
  { loader: { version: '0.16.9', stable: true } },
  { loader: { version: '0.15.11', stable: true } },
];
test('pickFabricLoader returns newest stable when unpinned', () => assert.equal(pickFabricLoader(fabric), '0.16.9'));
test('pickFabricLoader returns pinned', () => assert.equal(pickFabricLoader(fabric, '0.15.11'), '0.15.11'));
test('pickFabricLoader throws for unknown pinned', () => assert.throws(() => pickFabricLoader(fabric, '0.1.0'), /No Fabric loader 0\.1\.0/));

const promos = { '1.20.1-recommended': '47.2.0', '1.20.1-latest': '47.3.12' };
const forgeAll = ['1.20.1-47.3.12', '1.20.1-47.3.0', '1.20.1-47.2.0', '1.19.2-43.2.0'];
test('pickForgeVersion returns recommended when unpinned', () => assert.equal(pickForgeVersion(promos, forgeAll, '1.20.1'), '47.2.0'));
test('pickForgeVersion returns pinned', () => assert.equal(pickForgeVersion(promos, forgeAll, '1.20.1', '47.3.0'), '47.3.0'));
test('pickForgeVersion throws for unknown pinned', () => assert.throws(() => pickForgeVersion(promos, forgeAll, '1.20.1', '40.0.0'), /No Forge 40\.0\.0/));

const neo = ['21.1.70', '21.1.77', '21.1.80-beta', '20.4.237'];
test('pickNeoForgeVersion returns newest stable when unpinned', () => assert.equal(pickNeoForgeVersion(neo, '1.21.1'), '21.1.77'));
test('pickNeoForgeVersion returns pinned', () => assert.equal(pickNeoForgeVersion(neo, '1.21.1', '21.1.70'), '21.1.70'));
test('pickNeoForgeVersion throws for unknown pinned', () => assert.throws(() => pickNeoForgeVersion(neo, '1.21.1', '21.1.1'), /No NeoForge 21\.1\.1/));
