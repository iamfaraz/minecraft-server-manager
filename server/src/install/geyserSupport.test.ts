import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geyserLoader, geyserSupport, versionRange } from './geyserSupport.js';

const versions = (byLoader: Record<string, string[]>) => {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const loader = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('loaders')!))[0];
    return byLoader[loader] ? [{ version_number: '2.12.1-b2', game_versions: byLoader[loader] }, { version_number: '2.12.1-b1', game_versions: ['1.20.1'] }] : [];
  };
  return { f, calls };
};

test('geyserLoader maps server types to Geyser builds', () => {
  assert.equal(geyserLoader('PAPER'), 'paper');
  assert.equal(geyserLoader('PURPUR'), 'paper');
  assert.equal(geyserLoader('FABRIC'), 'fabric');
  assert.equal(geyserLoader('QUILT'), 'fabric');
  assert.equal(geyserLoader('NEOFORGE'), 'neoforge');
  assert.equal(geyserLoader('FORGE'), null);
  assert.equal(geyserLoader('VANILLA'), null);
});

test('supported only when the newest Geyser build lists the version', async () => {
  const { f } = versions({ fabric: ['26.3'], paper: ['1.20.5', '1.21.1', '26.3'] });
  assert.deepEqual(await geyserSupport('FABRIC', '1.20.1', f, true), { supported: false, versions: ['26.3'] });
  assert.deepEqual(await geyserSupport('FABRIC', '26.3', f, true), { supported: true, versions: ['26.3'] });
  assert.equal((await geyserSupport('PAPER', '1.21.1', f, true)).supported, true);
  assert.equal((await geyserSupport('PAPER', '1.20.1', f, true)).supported, false);
});

test('types without a Geyser build are unsupported; a failed lookup is unknown', async () => {
  const { f } = versions({});
  assert.equal((await geyserSupport('FORGE', '1.20.1', f, true)).supported, false);
  const broken = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await geyserSupport('FABRIC', '1.20.1', broken, true), { supported: null, versions: [] });
});

test('lookups are cached per loader', async () => {
  const { f, calls } = versions({ fabric: ['26.3'] });
  await geyserSupport('FABRIC', '26.3', f, true);
  await geyserSupport('QUILT', '1.20.1', f);
  assert.equal(calls.length, 1);
});

test('versionRange sorts the versions', () => {
  assert.equal(versionRange(['26.3', '1.20.5', '1.21.11', '26.1']), '1.20.5 – 26.3');
  assert.equal(versionRange(['26.3']), '26.3');
});
