import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { decideSkips, jarIsClientOnly } from './clientOnly.js';

function jar(entries: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [k, v] of Object.entries(entries)) z.addFile(k, Buffer.from(v));
  return z.toBuffer();
}

test('jarIsClientOnly: fabric environment client', () => assert.equal(jarIsClientOnly(jar({ 'fabric.mod.json': JSON.stringify({ id: 'x', environment: 'client' }) })), true));
test('jarIsClientOnly: fabric environment *', () => assert.equal(jarIsClientOnly(jar({ 'fabric.mod.json': JSON.stringify({ id: 'x', environment: '*' }) })), false));
test('jarIsClientOnly: quilt client', () =>
  assert.equal(jarIsClientOnly(jar({ 'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'x' }, minecraft: { environment: 'client' } }) })), true));
test('jarIsClientOnly: forge clientSideOnly', () => assert.equal(jarIsClientOnly(jar({ 'META-INF/mods.toml': 'modLoader="javafml"\nclientSideOnly=true\n[[mods]]\nmodId="x"' })), true));
test('jarIsClientOnly: neoforge mods.toml without flag', () => assert.equal(jarIsClientOnly(jar({ 'META-INF/neoforge.mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="x"' })), false));
test('jarIsClientOnly: not a zip', () => assert.equal(jarIsClientOnly(Buffer.from('nope')), false));

test('decideSkips precedence', () => {
  const d = decideSkips(
    [
      { path: 'mods/a.jar', env: { server: 'unsupported' } },
      { path: 'mods/b.jar', projectServerSide: 'unsupported' },
      { path: 'mods/c.jar', clientOnlyJar: true },
      { path: 'mods/d.jar', env: { server: 'required' } },
    ],
    {},
  );
  assert.deepEqual(
    d.map((x) => [x.path, x.skip, x.reason]),
    [
      ['mods/a.jar', true, 'pack-env'],
      ['mods/b.jar', true, 'modrinth-server-unsupported'],
      ['mods/c.jar', true, 'mod-metadata-client'],
      ['mods/d.jar', false, undefined],
    ],
  );
});
test('admin override forces install of flagged mod', () =>
  assert.deepEqual(decideSkips([{ path: 'mods/a.jar', env: { server: 'unsupported' } }], { 'mods/a.jar': false })[0], { path: 'mods/a.jar', skip: false, reason: undefined }));
test('admin override skips required mod', () =>
  assert.deepEqual(decideSkips([{ path: 'mods/d.jar', env: { server: 'required' } }], { 'mods/d.jar': true })[0], { path: 'mods/d.jar', skip: true, reason: 'admin' }));
