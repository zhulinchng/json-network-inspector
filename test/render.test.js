// Regression tests for the renderers (highlight.js, json-view.js) and the
// shared filter predicate (entryMatches in inspector-ui.js): XSS escaping,
// token classes, node budget, depth collapse, and search-prefix semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEl, makeDocument, serialize } from './fake-dom.js';
import { appendHighlighted } from '../src/highlight.js';
import { createJsonView } from '../src/json-view.js';
import { entryMatches } from '../src/inspector-ui.js';

function renderHighlight(source) {
  const doc = makeDocument();
  const code = doc.createElement('code');
  appendHighlighted(code, source);
  return serialize(code);
}

test('highlighter escapes markup and tokenizes types', () => {
  const html = renderHighlight('{"a":"</script><b>","n":1.5,"t":true,"z":null}');
  assert.ok(!html.includes('<script>'), 'must not contain raw script tag');
  assert.ok(html.includes('&lt;/script&gt;'), 'must escape markup');
  assert.ok(html.includes('tok-key'), 'keys highlighted');
  assert.ok(html.includes('tok-str'), 'strings highlighted');
  assert.ok(html.includes('tok-num'), 'numbers highlighted');
  assert.ok(html.includes('tok-lit'), 'literals highlighted');
});

test('highlighter falls back to plain text for non-JSON', () => {
  const html = renderHighlight('<html>hello & bye</html>');
  assert.ok(html.includes('&lt;html&gt;'), 'escapes even without tokens');
  assert.ok(!html.includes('tok-key'));
});

test('tree renders structure and escapes hostile keys', () => {
  const doc = makeDocument();
  const view = createJsonView({});
  const host = doc.createElement('div');
  view.render(host, {
    users: [{ name: 'ada', tags: ['x', 'y'] }],
    '<img src=x onerror=alert(1)>': 1,
    n: null,
    ok: false,
  });
  const html = serialize(host);
  assert.ok(html.includes('users') && html.includes('name'));
  assert.ok(html.includes('&lt;img'), 'hostile key escaped');
  assert.ok(!html.includes('<img src'), 'no injected element');
  assert.ok(html.includes('v-null') && html.includes('v-bool'));
  assert.ok(html.includes('[1]'), 'expanded container shows child count');
});

test('tree caps huge payloads behind Show more', () => {
  const doc = makeDocument();
  const view = createJsonView({});
  const big = {};
  for (let i = 0; i < 3000; i += 1) big[`k${i}`] = { v: i };
  const host = doc.createElement('div');
  view.render(host, big);
  assert.ok(serialize(host).includes('Show more'), 'node budget enforced');
});

test('tree collapses beyond the depth cap', () => {
  const doc = makeDocument();
  const view = createJsonView({});
  const host = doc.createElement('div');
  view.render(host, { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } });
  assert.ok(serialize(host).includes('is-collapsed'), 'deep subtree starts collapsed');
});

test('tree copy buttons report the JSON pointer path', async () => {
  const doc = makeDocument();
  let selected = null;
  const view = createJsonView({ onSelectPath: (p) => { selected = p; } });
  const host = doc.createElement('div');
  view.render(host, { a: [{ b: 1 }] });
  // Find the 'path' button of the first row and click it.
  const buttons = [];
  const walk = (n) => {
    if (n.tag === 'button' && n._text === 'path') buttons.push(n);
    n.children.forEach(walk);
  };
  walk(host);
  assert.ok(buttons.length > 0, 'path buttons rendered');
  // Stub the clipboard (Node's global navigator is getter-only).
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
  });
  try {
    buttons[0].click();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
  assert.equal(buttons[0].textContent, '✓', 'copy feedback shown');
});

test('entryMatches filters method, status, and URL', () => {
  const e = { method: 'POST', status: 201, url: 'https://a/users', bodyText: '{"id":1}' };
  const base = { query: '', method: 'ALL', status: 'ALL' };
  assert.equal(entryMatches(e, base), true);
  assert.equal(entryMatches(e, { ...base, method: 'GET' }), false);
  assert.equal(entryMatches(e, { ...base, status: '5xx' }), false);
  assert.equal(entryMatches(e, { ...base, status: '2xx' }), true);
  assert.equal(entryMatches(e, { ...base, query: 'USERS' }), true);
  assert.equal(entryMatches(e, { ...base, query: 'nope' }), false);
});

test('entryMatches searches a body prefix so huge payloads stay fast', () => {
  const e = {
    method: 'GET',
    status: 200,
    url: 'https://a/big',
    bodyText: `{"head":"${'x'.repeat(200 * 1024)}","needle":"FINDME"}`,
  };
  const base = { query: 'FINDME', method: 'ALL', status: 'ALL' };
  assert.equal(entryMatches(e, base), false, 'match beyond the 100 KB prefix is out of scope');
  assert.equal(entryMatches({ ...e, bodyText: '{"needle":"FINDME"}' }, base), true);
});
