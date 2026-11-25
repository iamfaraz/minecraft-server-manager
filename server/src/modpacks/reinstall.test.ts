import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modpackReinstall } from './update.js';

test('modpackReinstall: finished pack install repairs the loader only', () => assert.equal(modpackReinstall({ archive: true, stagedId: undefined, staged: false }), 'loader'));
test('modpackReinstall: interrupted install re-runs the pack from the staged file', () => assert.equal(modpackReinstall({ archive: false, stagedId: 'pack-x', staged: true }), 'pack'));
test('modpackReinstall: nothing to install from', () => assert.equal(modpackReinstall({ archive: false, stagedId: 'pack-x', staged: false }), 'refuse'));
