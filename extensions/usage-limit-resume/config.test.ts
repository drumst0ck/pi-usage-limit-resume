import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from './families.ts';

const tmp = (t: any) => { const d = mkdtempSync(join(tmpdir(), 'ulr-config-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('user config outside the package is merged over the packaged one and the defaults', t => {
 const d = tmp(t);
 writeFileSync(join(d, 'pkg.json'), JSON.stringify({ families: { poe: { piProviders: ['poe'], apiKey: true } } }));
 writeFileSync(join(d, 'user.json'), JSON.stringify({ families: { mycloud: { piProviders: ['my-pi'], codexbarId: 'x' }, poe: { piProviders: ['poe2'] } } }));
 const c = loadConfig([join(d, 'pkg.json'), join(d, 'user.json')]);
 assert.deepEqual(c.families!.mycloud, { piProviders: ['my-pi'], codexbarId: 'x' });
 assert.deepEqual(c.families!.poe, { piProviders: ['poe2'] });
 assert.ok(c.families!.claude);
});

test('missing config files fall back to the defaults', t => {
 const d = tmp(t);
 assert.deepEqual(loadConfig([join(d, 'nope.json'), join(d, 'nope2.json')]), DEFAULT_CONFIG);
});

test('a broken user config is ignored instead of breaking Pi startup', t => {
 const d = tmp(t);
 writeFileSync(join(d, 'user.json'), '{ not json');
 assert.deepEqual(loadConfig([join(d, 'user.json')]), DEFAULT_CONFIG);
});

test('family ids that are not filename-safe or have no providers are dropped', () => {
 const c = mergeConfig(DEFAULT_CONFIG, { families: {
  '../escape': { piProviders: ['a'] }, 'Upper': { piProviders: ['b'] }, '': { piProviders: ['c'] },
  ok: { piProviders: ['d'] }, noproviders: {} as any, badre: { piProviders: ['e'], modelPattern: '(' },
 } });
 assert.deepEqual(Object.keys(c.families!).filter(k => !(k in DEFAULT_CONFIG.families!)), ['ok']);
});
