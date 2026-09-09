// Isolated-world bridge: relays page-hook captures to the service worker.
// Accepts ONLY our own marker + shape from window.postMessage; everything
// else is ignored. Classic script (no imports) for executeScript injection.

(function () {
  'use strict';

  if (window.__jsonInspectorBridgeInstalled) return;
  window.__jsonInspectorBridgeInstalled = true;

  var MARKER = 'json-network-inspector';
  var MAX_BODY_CHARS = 2 * 1024 * 1024;

  function isValidPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.url !== 'string' || payload.url.length === 0) return false;
    if (typeof payload.bodyText !== 'string' || payload.bodyText.length === 0) return false;
    if (payload.bodyText.length > MAX_BODY_CHARS + 1024) return false;
    // Request payloads are capped upstream; reject spoofed oversized ones
    // here so they never reach the worker buffer.
    if (payload.reqBody !== undefined) {
      if (typeof payload.reqBody !== 'string') return false;
      if (payload.reqBody.length > 257 * 1024) return false;
    }
    return true;
  }

  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== 'JSON_CAPTURE' || data.source !== MARKER) return;
      if (!isValidPayload(data.payload)) return;
      // Fire-and-forget; the worker stores + relays to the side panel.
      chrome.runtime.sendMessage({ type: 'JSON_CAPTURE', entry: data.payload });
    } catch (err) {
      // Never break the page.
    }
  });
})();
