// Regression tests for src/store.js — ring buffer, pause accounting,
// navigation semantics, filters, and the setMaxEntries clamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, DEFAULT_FILTERS } from '../src/store.js';

function entry(over = {}) {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    url: 'https://a/x',
    method: 'GET',
    status: 200,
    bodyText: '{}',
    ...over,
  };
}

test('add/getById/count and clear', () => {
  const s = createStore();
  assert.equal(s.count(), 0);
  const e = entry({ url: 'https://a/users' });
  s.add(e);
  assert.equal(s.count(), 1);
  assert.equal(s.getById(e.id), e);
  assert.equal(s.getById('missing'), null);
  s.clear();
  assert.equal(s.count(), 0);
});

test('ring buffer drops oldest beyond maxEntries', () => {
  const s = createStore({ maxEntries: 3 });
  const ids = ['a', 'b', 'c', 'd'].map((id) => entry({ id }));
  ids.forEach((e) => s.add(e));
  assert.equal(s.count(), 3);
  assert.equal(s.getById('a'), null);
  assert.ok(s.getById('d'));
});

test('setMaxEntries clamps, sheds, and rejects garbage', () => {
  const s = createStore({ maxEntries: 100 });
  for (let i = 0; i < 80; i += 1) s.add(entry({ id: `e${i}` }));
  assert.equal(s.setMaxEntries(60), 60);
  assert.equal(s.count(), 60);
  assert.equal(s.getById('e0'), null);
  assert.ok(s.getById('e79'));
  assert.equal(s.setMaxEntries(1), 50); // clamped to floor
  assert.equal(s.setMaxEntries(99999), 2000); // clamped to ceiling
  assert.equal(s.setMaxEntries('nope'), 2000); // unchanged on garbage
});

test('pause drops incoming and counts misses, resume resets', () => {
  const s = createStore();
  s.setPaused(true);
  assert.equal(s.isPaused(), true);
  assert.equal(s.add(entry()), null);
  assert.equal(s.add(entry()), null);
  assert.equal(s.count(), 0);
  assert.equal(s.missedCount(), 2);
  s.setPaused(false);
  assert.equal(s.isPaused(), false);
  assert.equal(s.missedCount(), 0);
  s.add(entry());
  assert.equal(s.count(), 1);
});

test('navigation clears unless preserve-log is on', () => {
  const s = createStore();
  s.add(entry());
  assert.equal(s.handleNavigation(), true);
  assert.equal(s.count(), 0);
  s.setPreserveLog(true);
  assert.equal(s.shouldPreserveLog(), true);
  s.add(entry());
  assert.equal(s.handleNavigation(), false);
  assert.equal(s.count(), 1);
});

test('filters default, update, and match', () => {
  const s = createStore();
  assert.deepEqual(s.getFilters(), DEFAULT_FILTERS);
  s.add(entry({ id: 'g', method: 'GET', status: 200, url: 'https://a/users' }));
  s.add(entry({ id: 'p', method: 'POST', status: 201, bodyText: '{"created":true}' }));
  s.add(entry({ id: 'e', method: 'GET', status: 500, url: 'https://a/boom' }));
  s.setFilters({ method: 'POST' });
  assert.deepEqual(s.getFiltered().map((e) => e.id), ['p']);
  s.setFilters({ method: 'ALL', status: '5xx' });
  assert.deepEqual(s.getFiltered().map((e) => e.id), ['e']);
  s.setFilters({ status: 'ALL', query: 'users' });
  assert.deepEqual(s.getFiltered().map((e) => e.id), ['g']);
  s.setFilters({ query: 'created' });
  assert.deepEqual(s.getFiltered().map((e) => e.id), ['p']);
});

test('getAll returns a copy in insertion order', () => {
  const s = createStore();
  s.add(entry({ id: 'x' }));
  const all = s.getAll();
  assert.deepEqual(all.map((e) => e.id), ['x']);
  all.push(entry({ id: 'y' }));
  assert.equal(s.count(), 1);
});

test('subscribe notifies and unsubscribes', () => {
  const s = createStore();
  const seen = [];
  const unsub = s.subscribe((c) => seen.push(c.kind));
  s.add(entry());
  s.setFilters({ query: 'z' });
  s.clear();
  unsub();
  s.add(entry());
  assert.deepEqual(seen, ['add', 'filter', 'clear']);
});

test('a throwing listener does not break the store', () => {
  const s = createStore();
  s.subscribe(() => {
    throw new Error('boom');
  });
  s.add(entry());
  assert.equal(s.count(), 1);
});
