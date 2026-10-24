import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createMarketIndex } from '../scripts/update-market.mjs';
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('bundle manifest and browser module resolve the actual release package', () => {
  let definition;
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { definition = value; } } } });
  assert.equal(definition.id, pkg.name);
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(fs.readFileSync(new URL('../locale/' + language + '.json', import.meta.url), 'utf8'));
    assert.equal(locale.meta.title, pkg.name);
  }
  assert.ok(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').includes("className: 'dsh-web-chat-title' }, '" + pkg.name + "'"));
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: dsh-web-chat\b/);
  assert.ok(patch.includes("name: '" + pkg.name + "'"));
});
test('an unpublished version cannot become a misleading installable market entry', () => {
  assert.throws(() => createMarketIndex(pkg, { name: pkg.name, versions: {}, time: {} }), /先发布/);
  const registry = { name: pkg.name, versions: { [pkg.version]: { ...pkg, repository: { url: 'git+https://example.invalid/unrelated.git' } } }, time: { [pkg.version]: '2026-10-24T04:00:00Z' } };
  assert.throws(() => createMarketIndex(pkg, registry), /先发布/);
});
test('market entries use the confirmed registry version, author and publication time', () => {
  const registry = { name: pkg.name, versions: { [pkg.version]: pkg }, time: { [pkg.version]: '2026-10-24T04:00:00Z' } };
  const index = createMarketIndex(pkg, registry);
  assert.equal(index.plugins[0].name, pkg.name);
  assert.equal(index.plugins[0].author, 'ksnnkyo');
  assert.equal(index.plugins[0].versions[0].version, '0.1.0');
  assert.equal(index.plugins[0].versions[0].publishTimestamp, 1792814400);
});
