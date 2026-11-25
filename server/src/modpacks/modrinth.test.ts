import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultVersion, identifyPack, searchPacks } from './modrinth.js';

type Call = { url: string; init?: RequestInit };
function stub(routes: [RegExp, (url: string) => unknown][]) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const [re, fn] of routes) if (re.test(url)) {
      const r = fn(url);
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error(`Upstream 404 for ${url}`);
  }) as any;
  return { f, calls };
}

test('searchPacks sends modpack + server_side facets and index=downloads when q empty', async () => {
  const s = stub([[/\/search/, () => ({ hits: [{ project_id: 'p1', slug: 'cobble', title: 'Cobble', icon_url: 'i', downloads: 5, versions: ['1.21.1'], categories: ['fabric', 'adventure'] }], total_hits: 1 })]]);
  const r = await searchPacks('', 0, s.f);
  const u = new URL(s.calls[0].url);
  assert.equal(u.searchParams.get('index'), 'downloads');
  assert.deepEqual(JSON.parse(u.searchParams.get('facets')!), [['project_type:modpack'], ['server_side:required', 'server_side:optional']]);
  assert.deepEqual(r.hits[0], { projectId: 'p1', slug: 'cobble', title: 'Cobble', icon: 'i', downloads: 5, mcVersions: ['1.21.1'], loaders: ['fabric'] });
  assert.equal(r.total, 1);
  await searchPacks('cobble', 20, s.f);
  const u2 = new URL(s.calls[1].url);
  assert.equal(u2.searchParams.get('query'), 'cobble');
  assert.equal(u2.searchParams.get('offset'), '20');
  assert.notEqual(u2.searchParams.get('index'), 'downloads');
});

test('defaultVersion prefers newest release over newer beta', () => {
  assert.equal(defaultVersion([{ type: 'beta', date: '2026-03-01' }, { type: 'release', date: '2026-02-01' }, { type: 'release', date: '2026-01-01' }]), 1);
  assert.equal(defaultVersion([{ type: 'beta', date: '2026-01-01' }, { type: 'alpha', date: '2026-03-01' }]), 1);
});

const project = { id: 'p1', slug: 'cobble', title: 'Cobble', icon_url: 'i' };
test('identifyPack exact by file hash', async () => {
  const s = stub([
    [/\/version_file\/abc/, () => ({ id: 'v9', project_id: 'p1', version_number: '1.6.1' })],
    [/\/project\/p1$/, () => project],
  ]);
  assert.deepEqual(await identifyPack('abc', { name: 'Cobble', versionId: '1.6.1' }, s.f), { projectId: 'p1', slug: 'cobble', title: 'Cobble', icon: 'i', versionId: 'v9', versionNumber: '1.6.1', confidence: 'exact' });
});

test('identifyPack falls back to name + versionId', async () => {
  const s = stub([
    [/\/version_file\//, () => new Error('Upstream 404')],
    [/\/search/, () => ({ hits: [{ project_id: 'p0', slug: 'other', title: 'Other' }, { project_id: 'p1', slug: 'cobble', title: 'Cobble', icon_url: 'i' }] })],
    [/\/project\/p0\/version/, () => [{ id: 'x', version_number: '9' }]],
    [/\/project\/p1\/version/, () => [{ id: 'v8', version_number: '1.6.0' }, { id: 'v9', version_number: '1.6.1' }]],
    [/\/project\/p1$/, () => project],
  ]);
  const r = await identifyPack('zzz', { name: 'Cobble', versionId: '1.6.1' }, s.f);
  assert.deepEqual(r, { projectId: 'p1', slug: 'cobble', title: 'Cobble', icon: 'i', versionId: 'v9', versionNumber: '1.6.1', confidence: 'name-version' });
});

test('identifyPack returns null when no version_number matches', async () => {
  const s = stub([
    [/\/version_file\//, () => new Error('Upstream 404')],
    [/\/search/, () => ({ hits: [{ project_id: 'p1', slug: 'cobble', title: 'Cobble' }] })],
    [/\/project\/p1\/version/, () => [{ id: 'v8', version_number: '1.6.0' }]],
  ]);
  assert.equal(await identifyPack('zzz', { name: 'Cobble', versionId: '2.0' }, s.f), null);
});
