// Shared capture-record helpers (no chrome.* APIs — pure functions, unit-safe).
//
// A record is the unit both surfaces render:
// {
//   id, url, method, status, statusText, mimeType,
//   timeMs, startedAt (ISO), tabId,
//   reqHeaders: Object, resHeaders: Object,
//   bodyText, truncated: bool, originalSize: number, unparseable: bool,
//   source: 'devtools' | 'page-hook'
// }

export const MAX_BODY_CHARS = 2 * 1024 * 1024;

export const REQ_BODY_CAP = 256 * 1024;

// Bodies beyond this are dropped, not truncated: materializing them would
// risk OOM in the worker/renderer. Everything below it is truncated to
// MAX_BODY_CHARS with a flag instead of being silently dropped.
export const MAX_FORWARD_CHARS = 8 * 1024 * 1024;

/**
 * Decode a getContent() payload. The Promise form resolves
 * { content, encoding }; encoding may be 'base64' for non-textual transfers.
 * Returns '' when undecodable (caller skips the entry).
 */
export function decodeBody(content, encoding) {
  if (typeof content !== 'string' || content.length === 0) return '';
  if (!String(encoding || '').toLowerCase().includes('base64')) return content;
  try {
    const bin = atob(content.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i) & 0xff;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (err) {
    return '';
  }
}

/** Cap request payloads (uploads can be huge; we only need the JSON head). */
export function truncateReqBody(text) {
  const source = typeof text === 'string' ? text : '';
  if (source.length <= REQ_BODY_CAP) {
    return { text: source, truncated: false, originalSize: source.length };
  }
  return { text: source.slice(0, REQ_BODY_CAP), truncated: true, originalSize: source.length };
}

let idCounter = 0;

export function makeId() {
  idCounter += 1;
  return `r${Date.now().toString(36)}-${idCounter}`;
}

/** Cap stored body text; returns { text, truncated, originalSize }. */
export function truncateBody(text) {
  const originalSize = typeof text === 'string' ? text.length : 0;
  if (originalSize <= MAX_BODY_CHARS) {
    return { text: text || '', truncated: false, originalSize };
  }
  return { text: text.slice(0, MAX_BODY_CHARS), truncated: true, originalSize };
}

/** True when the response is probably JSON (HAR entry shape). */
export function isJsonEntry({ mimeType = '', url = '', accept = '' } = {}) {
  const mime = String(mimeType).toLowerCase();
  if (mime.includes('json')) return true;
  try {
    if (new URL(url).pathname.toLowerCase().endsWith('.json')) return true;
  } catch (err) {
    if (String(url).toLowerCase().split('?')[0].endsWith('.json')) return true;
  }
  return String(accept).toLowerCase().includes('json');
}

/** HAR [{name, value}] headers → plain object (last value wins). */
export function headersToObject(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (h && typeof h.name === 'string') out[h.name] = h.value;
  }
  return out;
}

/** Parse JSON without ever throwing. Marks unparseable instead of guessing. */
export function parseSafe(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** Build a record from a DevTools HAR entry + fetched body text. */
export function makeDevtoolsRecord({ entry, bodyText, tabId }) {
  const { text, truncated, originalSize } = truncateBody(bodyText || '');
  const acceptHeader =
    entry.request?.headers?.find((h) => h.name?.toLowerCase() === 'accept')?.value || '';
  const parsed = text ? parseSafe(text) : { ok: false, error: 'empty body' };
  const req = truncateReqBody(entry.request?.postData?.text || '');
  return {
    id: makeId(),
    url: entry.request?.url || '',
    method: (entry.request?.method || 'GET').toUpperCase(),
    status: entry.response?.status || 0,
    statusText: entry.response?.statusText || '',
    mimeType: entry.response?.content?.mimeType || '',
    timeMs: Math.round(entry.time || 0),
    startedAt: entry.startedDatetime || new Date().toISOString(),
    tabId: tabId ?? null,
    reqHeaders: headersToObject(entry.request?.headers),
    resHeaders: headersToObject(entry.response?.headers),
    reqBody: req.text,
    reqBodyTruncated: req.truncated,
    reqBodySize: req.originalSize,
    reqBodyMime: entry.request?.postData?.mimeType || '',
    bodyText: text,
    truncated,
    originalSize,
    unparseable: text.length > 0 && !parsed.ok,
    source: 'devtools',
    _accept: acceptHeader,
  };
}

/** Build a record from a page-hook capture event payload. */
export function makePageHookRecord(payload) {
  const { text, truncated, originalSize } = truncateBody(payload.bodyText || '');
  const parsed = text ? parseSafe(text) : { ok: false, error: 'empty body' };
  const req = truncateReqBody(payload.reqBody || '');
  return {
    id: makeId(),
    url: payload.url || '',
    method: (payload.method || 'GET').toUpperCase(),
    status: payload.status || 0,
    statusText: payload.statusText || '',
    mimeType: payload.mimeType || '',
    timeMs: Math.round(payload.timeMs || 0),
    startedAt: payload.startedAt || new Date().toISOString(),
    tabId: payload.tabId ?? null,
    reqHeaders: payload.reqHeaders && typeof payload.reqHeaders === 'object' ? payload.reqHeaders : {},
    resHeaders: payload.resHeaders && typeof payload.resHeaders === 'object' ? payload.resHeaders : {},
    reqBody: req.text,
    reqBodyTruncated: req.truncated,
    reqBodySize: req.originalSize,
    reqBodyMime: typeof payload.reqBodyMime === 'string' ? payload.reqBodyMime : '',
    bodyText: text,
    truncated,
    originalSize,
    unparseable: text.length > 0 && !parsed.ok,
    source: 'page-hook',
  };
}

/** Validate an inbound page-hook payload before it becomes a record. */
export function isValidHookPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.url !== 'string' || payload.url.length === 0) return false;
  if (typeof payload.bodyText !== 'string' || payload.bodyText.length === 0) return false;
  if (payload.bodyText.length > MAX_FORWARD_CHARS) return false;
  if (payload.reqBody !== undefined) {
    if (typeof payload.reqBody !== 'string') return false;
    if (payload.reqBody.length > REQ_BODY_CAP + 1024) return false;
  }
  return true;
}

export function formatSize(chars) {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTime(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Display form of a URL: path + query, full URL kept in `title`. */
export function displayPath(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search + u.hash) || '/';
  } catch (err) {
    return url;
  }
}

export function statusClass(status) {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500) return '5xx';
  return 'other';
}
