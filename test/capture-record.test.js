// Regression tests for src/capture-record.js — the trust boundary helpers:
// body decoding/truncation, JSON detection, record factories, payload auth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BODY_CHARS,
  MAX_FORWARD_CHARS,
  REQ_BODY_CAP,
  decodeBody,
  displayPath,
  formatSize,
  formatTime,
  headersToObject,
  isJsonEntry,
  isValidHookPayload,
  makeDevtoolsRecord,
  makePageHookRecord,
  parseSafe,
  statusClass,
  truncateBody,
  truncateReqBody,
} from '../src/capture-record.js';

test('truncateBody caps at 2 MB with flag and original size', () => {
  const big = 'x'.repeat(MAX_BODY_CHARS + 10);
  const out = truncateBody(big);
  assert.equal(out.truncated, true);
  assert.equal(out.originalSize, big.length);
  assert.equal(out.text.length, MAX_BODY_CHARS);
  const small = truncateBody('{}');
  assert.deepEqual(small, { text: '{}', truncated: false, originalSize: 2 });
});

test('truncateReqBody caps request payloads at 256 KB', () => {
  const big = 'y'.repeat(REQ_BODY_CAP + 1);
  const out = truncateReqBody(big);
  assert.equal(out.truncated, true);
  assert.equal(out.text.length, REQ_BODY_CAP);
  assert.equal(out.originalSize, big.length);
  assert.equal(truncateReqBody('').text, '');
  assert.equal(truncateReqBody(null).text, '');
});

test('decodeBody passes text through and decodes base64', () => {
  assert.equal(decodeBody('{"a":1}', ''), '{"a":1}');
  assert.equal(decodeBody('{"a":1}', 'utf-8'), '{"a":1}');
  const unicode = '{"emoji":"✓ café \\"q\\""}';
  const b64 = Buffer.from(unicode, 'utf8').toString('base64');
  assert.equal(decodeBody(b64, 'base64'), unicode);
  assert.equal(decodeBody(b64, 'BASE64'), unicode);
});

test('decodeBody rejects garbage instead of throwing', () => {
  assert.equal(decodeBody('!!!not-base64!!!', 'base64'), '');
  assert.equal(decodeBody('', 'base64'), '');
  assert.equal(decodeBody(null, ''), '');
});

test('isJsonEntry matches mime, extension, and accept header', () => {
  assert.equal(isJsonEntry({ mimeType: 'application/json', url: 'https://a/b' }), true);
  assert.equal(isJsonEntry({ mimeType: 'application/problem+json', url: 'https://a/b' }), true);
  assert.equal(isJsonEntry({ mimeType: '', url: 'https://a/data.json?x=1' }), true);
  assert.equal(isJsonEntry({ mimeType: 'text/html', url: 'https://a/b', accept: 'application/json' }), true);
  assert.equal(isJsonEntry({ mimeType: 'text/html', url: 'https://a/b' }), false);
  assert.equal(isJsonEntry({}), false);
});

test('headersToObject folds duplicates last-wins and ignores junk', () => {
  assert.deepEqual(headersToObject([{ name: 'A', value: '1' }, { name: 'A', value: '2' }]), { A: '2' });
  assert.deepEqual(headersToObject(null), {});
  assert.deepEqual(headersToObject([{ nope: 1 }]), {});
});

test('parseSafe never throws', () => {
  assert.equal(parseSafe('{"a":[1,2]}').ok, true);
  assert.deepEqual(parseSafe('{"a":1}').value, { a: 1 });
  assert.equal(parseSafe('{oops').ok, false);
  assert.equal(parseSafe('').ok, false);
});

const HAR = {
  request: {
    url: 'https://api.example.com/users',
    method: 'post',
    headers: [{ name: 'Accept', value: 'application/json' }],
    postData: { mimeType: 'application/json', text: '{"name":"ada"}' },
  },
  response: {
    status: 201,
    statusText: 'Created',
    content: { mimeType: 'application/json' },
    headers: [{ name: 'Content-Type', value: 'application/json' }],
  },
  time: 12.6,
  startedDatetime: '2026-01-01T00:00:00.000Z',
};

test('makeDevtoolsRecord maps HAR fields and request payload', () => {
  const r = makeDevtoolsRecord({ entry: HAR, bodyText: '{"id":1}', tabId: 7 });
  assert.equal(r.method, 'POST');
  assert.equal(r.status, 201);
  assert.equal(r.timeMs, 13);
  assert.equal(r.source, 'devtools');
  assert.equal(r.tabId, 7);
  assert.equal(r.unparseable, false);
  assert.equal(r.reqBody, '{"name":"ada"}');
  assert.equal(r.reqBodyMime, 'application/json');
  assert.equal(r.reqBodySize, 14);
  assert.equal(r.reqBodyTruncated, false);
  assert.deepEqual(r.resHeaders, { 'Content-Type': 'application/json' });
});

test('makeDevtoolsRecord truncates huge request payloads', () => {
  const entry = {
    ...HAR,
    request: { ...HAR.request, postData: { mimeType: 'text/plain', text: 'z'.repeat(REQ_BODY_CAP + 5) } },
  };
  const r = makeDevtoolsRecord({ entry, bodyText: '{}', tabId: 1 });
  assert.equal(r.reqBodyTruncated, true);
  assert.equal(r.reqBody.length, REQ_BODY_CAP);
});

test('makeDevtoolsRecord flags unparseable bodies', () => {
  const r = makeDevtoolsRecord({ entry: HAR, bodyText: '<html>nope', tabId: 1 });
  assert.equal(r.unparseable, true);
});

test('makePageHookRecord carries request payload through', () => {
  const r = makePageHookRecord({
    url: 'https://a/submit',
    method: 'post',
    status: 200,
    bodyText: '{"ok":true}',
    reqBody: '{"x":1}',
    reqBodyMime: 'application/json',
  });
  assert.equal(r.method, 'POST');
  assert.equal(r.source, 'page-hook');
  assert.equal(r.reqBody, '{"x":1}');
  assert.equal(r.reqBodySize, 7);
  assert.equal(r.unparseable, false);
});

test('isValidHookPayload enforces shape and bounds', () => {
  assert.equal(isValidHookPayload({ url: 'https://a', bodyText: '{}' }), true);
  assert.equal(isValidHookPayload({ url: 'https://a', bodyText: '' }), false);
  assert.equal(isValidHookPayload({ url: 'https://a' }), false);
  assert.equal(isValidHookPayload({ bodyText: '{}' }), false);
  assert.equal(isValidHookPayload(null), false);
  assert.equal(isValidHookPayload('{}'), false);
  assert.equal(
    isValidHookPayload({ url: 'https://a', bodyText: 'x'.repeat(MAX_FORWARD_CHARS + 1) }),
    false,
  );
  assert.equal(
    isValidHookPayload({ url: 'https://a', bodyText: '{}', reqBody: 'x'.repeat(REQ_BODY_CAP + 2048) }),
    false,
  );
  assert.equal(
    isValidHookPayload({ url: 'https://a', bodyText: '{}', reqBody: '{"a":1}' }),
    true,
  );
  assert.equal(
    isValidHookPayload({ url: 'https://a', bodyText: '{}', reqBody: 42 }),
    false,
  );
});

test('formatters behave at boundaries', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(3 * 1024 * 1024), '3.00 MB');
  assert.equal(formatTime(999), '999 ms');
  assert.equal(formatTime(1500), '1.50 s');
  assert.equal(displayPath('https://a/x/y?q=1'), '/x/y?q=1');
  assert.equal(displayPath('not a url'), 'not a url');
  assert.equal(statusClass(0), 'other');
  assert.equal(statusClass(204), '2xx');
  assert.equal(statusClass(301), '3xx');
  assert.equal(statusClass(404), '4xx');
  assert.equal(statusClass(503), '5xx');
});
