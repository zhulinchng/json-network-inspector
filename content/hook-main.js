// Page-hook capture (MAIN world — runs in page context, NOT isolated).
// Monkey-patches fetch/XHR to observe JSON traffic, then reports entries via
// window.postMessage. NEVER touches chrome.* APIs here.
//
// Safety rules:
// - Never break page traffic (try/catch everywhere; clone, don't consume).
// - Bound memory on streams: response bodies are read through an explicit
//   reader with a byte cap + timeout, then the reader is cancelled so a
//   never-ending JSON stream cannot grow the page's memory via the tee.
// - Only forward likely-JSON payloads (mime or .json URL) to bound overhead.
// - Request bodies are captured best-effort (string bodies only, 256 KB cap).

(function () {
  'use strict';

  if (window.__jsonInspectorHookInstalled) {
    window.__jsonInspectorEnabled = true;
    return;
  }
  window.__jsonInspectorHookInstalled = true;
  if (window.__jsonInspectorEnabled === undefined) window.__jsonInspectorEnabled = true;

  var MAX_BODY_CHARS = 2 * 1024 * 1024;
  // Below this we truncate (flagged); above it we drop to avoid OOM.
  var MAX_FORWARD_CHARS = 8 * 1024 * 1024;
  var REQ_BODY_CAP = 256 * 1024;
  var READ_TIMEOUT_MS = 30000;
  var MARKER = 'json-network-inspector';

  function isEnabled() {
    return window.__jsonInspectorEnabled !== false;
  }

  function looksLikeJsonUrl(url) {
    try {
      return new URL(url, location.href).pathname.toLowerCase().endsWith('.json');
    } catch (err) {
      return String(url).toLowerCase().split('?')[0].endsWith('.json');
    }
  }

  function looksLikeJsonMime(mime) {
    return String(mime || '').toLowerCase().indexOf('json') !== -1;
  }

  function emit(entry) {
    if (!isEnabled()) return;
    try {
      window.postMessage({ type: 'JSON_CAPTURE', source: MARKER, payload: entry }, '*');
    } catch (err) {
      // Hostile page overriding postMessage; nothing to do.
    }
  }

  function baseEntry(url, method) {
    return {
      url: String(url),
      method: String(method || 'GET').toUpperCase(),
      status: 0,
      statusText: '',
      mimeType: '',
      timeMs: 0,
      startedAt: new Date().toISOString(),
      reqHeaders: {},
      resHeaders: {},
      reqBody: '',
      reqBodyTruncated: false,
      reqBodySize: 0,
      reqBodyMime: '',
      bodyText: '',
    };
  }

  function readInitHeaders(init) {
    var out = {};
    try {
      var h = init && init.headers;
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (value, key) {
          out[key] = value;
        });
      } else if (Array.isArray(h)) {
        h.forEach(function (pair) {
          out[pair[0]] = pair[1];
        });
      } else if (typeof h === 'object') {
        Object.keys(h).forEach(function (k) {
          out[k] = h[k];
        });
      }
    } catch (err) {
      // Best effort only.
    }
    return out;
  }

  function headersToObject(headers) {
    var out = {};
    try {
      headers.forEach(function (value, key) {
        out[key] = value;
      });
    } catch (err) {
      // Opaque responses throw; keep {}.
    }
    return out;
  }

  /**
   * Read a stream to text with a hard cap. Cancels the reader on cap,
   * timeout, or error so abandoned tees cannot buffer unboundedly.
   * Resolves { text, overflow } or null when nothing usable was read.
   */
  function readCapped(stream, cap, timeoutMs) {
    var reader;
    var decoder;
    try {
      reader = stream.getReader();
      decoder = new TextDecoder('utf-8', { fatal: false });
    } catch (err) {
      return Promise.resolve(null);
    }
    var received = 0;
    var chunks = [];
    var finished = false;
    var timer = 0;
    function cleanup() {
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      try {
        reader.cancel();
      } catch (err) {
        // Already closed; ignore.
      }
    }
    return new Promise(function (resolve) {
      timer = setTimeout(function () {
        cleanup();
        resolve(null);
      }, timeoutMs);
      function pump() {
        reader.read().then(
          function (result) {
            if (finished) return;
            if (result.done) {
              cleanup();
              try {
                chunks.push(decoder.decode());
              } catch (err) {
                // Flush failed; keep what we have.
              }
              resolve({ text: chunks.join(''), overflow: false });
              return;
            }
            var value = '';
            try {
              value = decoder.decode(result.value, { stream: true });
            } catch (err) {
              cleanup();
              resolve(null);
              return;
            }
            received += value.length;
            if (received > cap) {
              chunks.push(value.slice(0, Math.max(0, cap - (received - value.length))));
              cleanup();
              resolve({ text: chunks.join(''), overflow: true });
              return;
            }
            chunks.push(value);
            pump();
          },
          function () {
            cleanup();
            resolve(null);
          },
        );
      }
      pump();
    });
  }

  function splitReqBody(text, mime) {
    var source = typeof text === 'string' ? text : '';
    if (source.length <= REQ_BODY_CAP) {
      return { body: source, truncated: false, size: source.length, mime: mime || '' };
    }
    return { body: source.slice(0, REQ_BODY_CAP), truncated: true, size: source.length, mime: mime || '' };
  }

  /**
   * Best-effort Request-object payload read (clone, never the original).
   * Always resolves; bounded by REQ cap + short timeout.
   */
  function readRequestBody(resource) {
    return new Promise(function (resolve) {
      function done(info) {
        resolve(info || { body: '', truncated: false, size: 0, mime: '' });
      }
      try {
        var cloned = resource.clone();
        if (!cloned.body) {
          cloned
            .text()
            .then(function (t) {
              done(splitReqBody(typeof t === 'string' ? t : '', ''));
            })
            .catch(function () {
              done();
            });
          return;
        }
        readCapped(cloned.body, REQ_BODY_CAP + 1024, 5000).then(function (read) {
          if (!read || !read.text) {
            done();
            return;
          }
          done(splitReqBody(read.text, ''));
        });
      } catch (err) {
        // Body already used or unreadable; continue without it.
        done();
      }
    });
  }

  // ---- fetch ----
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (resource, init) {
      var url = '';
      var method = 'GET';
      var isRequestObject = false;
      try {
        if (typeof resource === 'string') {
          url = resource;
        } else if (resource && typeof resource.url === 'string') {
          url = resource.url;
          isRequestObject = true;
          if (resource.method) method = resource.method;
        }
        if (init && init.method) method = init.method;
      } catch (err) {
        return originalFetch.apply(this, arguments);
      }

      var startedAt = Date.now();
      var reqHeaders = readInitHeaders(init);
      // Best-effort request body (string bodies only; uploads stay untouched).
      var reqInfo = { body: '', truncated: false, size: 0, mime: '' };
      try {
        if (init && typeof init.body === 'string') {
          var initMime =
            (init.headers && typeof init.headers.get === 'function'
              ? init.headers.get('content-type')
              : null) || '';
          reqInfo = splitReqBody(init.body, initMime);
        }
      } catch (err) {
        // Ignore; request body stays empty.
      }
      // A Request object's payload must be clone-read BEFORE dispatch: once
      // fetch consumes the original, clone() throws and the body is lost.
      var reqBodyReady = Promise.resolve();
      if (isRequestObject && !reqInfo.body) {
        try {
          reqBodyReady = readRequestBody(resource);
        } catch (err) {
          reqBodyReady = Promise.resolve();
        }
      }

      var promise;
      try {
        promise = originalFetch.apply(this, arguments);
      } catch (err) {
        throw err;
      }

      return promise.then(
        function (response) {
          try {
            if (!isEnabled()) return response;
            var mime = '';
            try {
              mime = response.headers.get('content-type') || '';
            } catch (err) {
              mime = '';
            }
            if (!looksLikeJsonMime(mime) && !looksLikeJsonUrl(url)) return response;
            var entry = baseEntry(url, method);
            entry.mimeType = mime;
            entry.status = response.status;
            entry.statusText = response.statusText;
            entry.reqHeaders = reqHeaders;
            entry.resHeaders = headersToObject(response.headers);
            entry.reqBody = reqInfo.body;
            entry.reqBodyTruncated = reqInfo.truncated;
            entry.reqBodySize = reqInfo.size;
            entry.reqBodyMime = reqInfo.mime;
            var clone;
            try {
              clone = response.clone();
            } catch (err) {
              return response;
            }
            // reqBodyReady was started before dispatch (see above); apply it
            // here so the entry ships complete (bounded: 5 s, then give up).
            var applyReqBody = reqBodyReady.then(function (info) {
              if (info && info.size > 0) {
                entry.reqBody = info.body;
                entry.reqBodyTruncated = info.truncated;
                entry.reqBodySize = info.size;
              }
            });
            if (!clone.body) {
              // No stream (e.g. 204/304): empty bodies are noise, skip.
              return response;
            }
            readCapped(clone.body, MAX_FORWARD_CHARS, READ_TIMEOUT_MS).then(function (read) {
              if (!read || !read.text) return;
              applyReqBody.then(function () {
                if (!isEnabled()) return;
                entry.timeMs = Date.now() - startedAt;
                entry.bodyText = read.text;
                emit(entry);
              });
            });
          } catch (err) {
            // Observation must never break the page.
          }
          return response;
        },
        function (err) {
          throw err;
        },
      );
    };
  }

  // ---- XMLHttpRequest ----
  var OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    var origOpen = OriginalXHR.prototype.open;
    var origSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url) {
      try {
        this.__jniMethod = method;
        this.__jniUrl = url;
      } catch (err) {
        // Ignore.
      }
      return origOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function (body) {
      var xhr = this;
      var startedAt = Date.now();
      var reqInfo = splitReqBody(typeof body === 'string' ? body : '', '');
      function onLoad() {
        try {
          xhr.removeEventListener('load', onLoad);
          if (!isEnabled()) return;
          var url = String(xhr.__jniUrl || location.href);
          var mime = '';
          try {
            mime = xhr.getResponseHeader('content-type') || '';
          } catch (err) {
            mime = '';
          }
          if (!looksLikeJsonMime(mime) && !looksLikeJsonUrl(url)) return;
          var text = '';
          try {
            if (xhr.responseType === '' || xhr.responseType === 'text') {
              text = xhr.responseText || '';
            } else if (xhr.responseType === 'json' && xhr.response !== undefined) {
              text = typeof xhr.response === 'string' ? xhr.response : JSON.stringify(xhr.response);
            } else {
              return; // blob/arraybuffer/document: skip.
            }
          } catch (err) {
            return;
          }
          if (!text || text.length > MAX_FORWARD_CHARS) return;
          var entry = baseEntry(url, xhr.__jniMethod || 'GET');
          entry.status = xhr.status || 0;
          entry.mimeType = mime;
          entry.timeMs = Date.now() - startedAt;
          entry.startedAt = new Date(startedAt).toISOString();
          entry.reqBody = reqInfo.body;
          entry.reqBodyTruncated = reqInfo.truncated;
          entry.reqBodySize = reqInfo.size;
          entry.bodyText = text;
          emit(entry);
        } catch (err) {
          // Observation must never break the page.
        }
      }
      try {
        xhr.addEventListener('load', onLoad);
      } catch (err) {
        // Ignore.
      }
      return origSend.apply(this, arguments);
    };
  }
})();
