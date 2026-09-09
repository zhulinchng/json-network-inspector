// JSON Network Inspector — background service worker.
//
// Lifetime: Chrome may terminate this worker at any time. No capture state or
// settings live in module globals — everything persistent goes to
// chrome.storage (local for settings, session for ephemeral capture buffers).
// The `livePorts` set and `bufferChains` map below hold only live Port
// objects and in-flight coordination promises (re-established from storage on
// the next event), never data.

const HOOK_FILES_MAIN = ['content/hook-main.js'];
const BRIDGE_FILES_ISOLATED = ['content/bridge.js'];
const BUFFER_KEY_PREFIX = 'buf:';
const BUFFER_LIMIT = 100;
// Session buffers stay small enough for quota and message transport: entries
// beyond ~4 MB total are shed oldest-first before writing.
const BUFFER_BYTE_BUDGET = 4 * 1024 * 1024;

/** Live side-panel ports. Entries: { port, tabId }. */
const livePorts = new Set();
/** Per-tab persist serialization chains (coordination only, not data). */
const bufferChains = new Map();

async function readSession(keys) {
  try {
    return await chrome.storage.session.get(keys);
  } catch (err) {
    console.warn('[worker] session read failed:', err?.message);
    return {};
  }
}

function bufferKey(tabId) {
  return `${BUFFER_KEY_PREFIX}${tabId}`;
}

function enabledKey(tabId) {
  return `capture:${tabId}`;
}

async function isCaptureEnabled(tabId) {
  const data = await readSession([enabledKey(tabId)]);
  return data[enabledKey(tabId)] === true;
}

async function writeSessionFlag(tabId, enabled) {
  try {
    await chrome.storage.session.set({ [enabledKey(tabId)]: enabled });
  } catch (err) {
    console.warn('[worker] session flag write failed:', err?.message);
  }
}

async function hasHostAccess() {
  try {
    return await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  } catch (err) {
    return false;
  }
}

/**
 * Inject the hook + bridge into a tab, including subframes (allFrames) so
 * iframe traffic is captured too. Some frames (about:blank, racing
 * navigations) may refuse injection — fall back to top-frame-only rather
 * than failing the whole enable. Returns { partial }.
 */
async function injectHook(tabId) {
  const allFrames = { tabId, allFrames: true };
  const topOnly = { tabId };
  try {
    await chrome.scripting.executeScript({ target: allFrames, world: 'MAIN', files: HOOK_FILES_MAIN });
    await chrome.scripting.executeScript({
      target: allFrames,
      world: 'ISOLATED',
      files: BRIDGE_FILES_ISOLATED,
    });
    await chrome.scripting.executeScript({
      target: allFrames,
      world: 'MAIN',
      func: () => {
        window.__jsonInspectorEnabled = true;
      },
    });
    return { partial: false };
  } catch (err) {
    console.warn('[worker] all-frames inject failed, retrying top frame:', err?.message);
    await chrome.scripting.executeScript({ target: topOnly, world: 'MAIN', files: HOOK_FILES_MAIN });
    await chrome.scripting.executeScript({
      target: topOnly,
      world: 'ISOLATED',
      files: BRIDGE_FILES_ISOLATED,
    });
    await chrome.scripting.executeScript({
      target: topOnly,
      world: 'MAIN',
      func: () => {
        window.__jsonInspectorEnabled = true;
      },
    });
    return { partial: true };
  }
}

function roughSize(list) {
  let bytes = 0;
  for (const e of list) {
    bytes += (e?.bodyText?.length || 0) + (e?.url?.length || 0) + (e?.reqBody?.length || 0) + 512;
  }
  return bytes;
}

/**
 * Persist a tab buffer, shedding oldest entries until it fits quota/budget.
 * Returns the list that was actually stored, or null when nothing could be
 * stored (storage keeps its previous good state in that case).
 */
async function persistBuffer(key, list) {
  let candidate = list;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    while (roughSize(candidate) > BUFFER_BYTE_BUDGET && candidate.length > 1) {
      candidate = candidate.slice(Math.ceil(candidate.length / 4));
    }
    try {
      await chrome.storage.session.set({ [key]: candidate });
      return candidate;
    } catch (err) {
      if (candidate.length <= 1) {
        console.warn('[worker] buffer write failed, keeping previous state:', err?.message);
        return null;
      }
      candidate = candidate.slice(Math.ceil(candidate.length / 2));
    }
  }
  return null;
}

function appendToBufferInner(tabId, entry) {
  return (async () => {
    const key = bufferKey(tabId);
    const data = await readSession([key]);
    const list = Array.isArray(data[key]) ? data[key] : [];
    list.push(entry);
    while (list.length > BUFFER_LIMIT) list.shift();
    return persistBuffer(key, list);
  })();
}

/**
 * Serialized buffer append. Concurrent JSON_CAPTURE events otherwise
 * read-modify-write the same stored list and silently lose entries.
 */
function appendToBuffer(tabId, entry) {
  const prev = bufferChains.get(tabId) || Promise.resolve();
  const next = prev.then(
    () => appendToBufferInner(tabId, entry),
    () => appendToBufferInner(tabId, entry),
  );
  bufferChains.set(tabId, next);
  next.finally(() => {
    if (bufferChains.get(tabId) === next) bufferChains.delete(tabId);
  });
  return next;
}

async function updateBadge(tabId, count) {
  try {
    if (count === undefined) {
      const data = await readSession([bufferKey(tabId)]);
      count = Array.isArray(data[bufferKey(tabId)]) ? data[bufferKey(tabId)].length : 0;
    }
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 999)) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4F46E5' });
  } catch (err) {
    // Badge is cosmetic; tab may be gone.
  }
}

function relayToPanel(tabId, message) {
  for (const item of livePorts) {
    if (item.tabId === tabId) {
      try {
        item.port.postMessage(message);
      } catch (err) {
        // Dead port; onDisconnect cleanup handles removal.
      }
    }
  }
}

async function handleCapture(entry, senderTabId) {
  if (senderTabId == null) return;
  // Relay first (live UI stays snappy), persist serialized right after.
  relayToPanel(senderTabId, { type: 'JSON_CAPTURE', entry });
  try {
    const stored = await appendToBuffer(senderTabId, entry);
    await updateBadge(senderTabId, stored ? stored.length : undefined);
  } catch (err) {
    console.warn('[worker] capture persist failed:', err?.message);
  }
}

// ---------------------------------------------------------------------------
// Message handling. Async branches use IIFE + `return true` uniformly.
// EXCEPTION: REQUEST_CAPTURE_ENABLE calls chrome.permissions.request()
// synchronously as the very first statement — no await before it — because
// the user gesture expires after any async hop.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'JSON_CAPTURE') {
    // Fire-and-forget from the bridge; validate shape before storing.
    if (message.entry && typeof message.entry.url === 'string') {
      handleCapture(message.entry, sender.tab?.id);
    }
    return false;
  }

  if (message.type === 'REQUEST_CAPTURE_ENABLE') {
    const tabId = message.tabId;
    chrome.permissions
      .request({ origins: ['http://*/*', 'https://*/*'] })
      .then((granted) => {
        (async () => {
          if (!granted) {
            sendResponse({ granted: false, enabled: false });
            return;
          }
          try {
            const { partial } = await injectHook(tabId);
            await writeSessionFlag(tabId, true);
            sendResponse({ granted: true, enabled: true, partial });
          } catch (err) {
            console.warn('[worker] inject failed:', err?.message);
            sendResponse({ granted: true, enabled: false, error: String(err?.message || err) });
          }
        })();
      })
      .catch((err) => {
        sendResponse({ granted: false, enabled: false, error: String(err?.message || err) });
      });
    return true;
  }

  if (message.type === 'REQUEST_CAPTURE_DISABLE') {
    (async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: message.tabId, allFrames: true },
          world: 'MAIN',
          func: () => {
            window.__jsonInspectorEnabled = false;
          },
        });
      } catch (err) {
        // Tab may be gone or inaccessible; flag clear still applies.
      }
      await writeSessionFlag(message.tabId, false);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'GET_CAPTURE_STATE') {
    (async () => {
      const [enabled, access] = await Promise.all([
        isCaptureEnabled(message.tabId),
        hasHostAccess(),
      ]);
      sendResponse({ enabled, hasAccess: access });
    })();
    return true;
  }

  if (message.type === 'GET_BUFFER') {
    (async () => {
      const key = bufferKey(message.tabId);
      const data = await readSession([key]);
      sendResponse({ entries: Array.isArray(data[key]) ? data[key] : [] });
    })();
    return true;
  }

  if (message.type === 'CLEAR_BUFFER') {
    (async () => {
      try {
        await chrome.storage.session.set({ [bufferKey(message.tabId)]: [] });
      } catch (err) {
        console.warn('[worker] clear failed:', err?.message);
      }
      await updateBadge(message.tabId, 0);
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Long-lived side-panel ports.
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  const item = { port, tabId: null };
  livePorts.add(item);
  port.onMessage.addListener((msg) => {
    if (msg && (msg.type === 'PORT_INIT' || msg.type === 'PORT_SWITCH_TAB')) {
      item.tabId = msg.tabId ?? null;
    }
  });
  port.onDisconnect.addListener(() => {
    livePorts.delete(item);
  });
});

// ---------------------------------------------------------------------------
// Tab lifecycle: cleanup on close, re-inject after navigation when enabled.
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    try {
      await chrome.storage.session.remove([bufferKey(tabId), enabledKey(tabId)]);
    } catch (err) {
      // Ignore.
    }
    bufferChains.delete(tabId);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  (async () => {
    const [enabled, access] = await Promise.all([
      isCaptureEnabled(tabId),
      hasHostAccess(),
    ]);
    if (!enabled || !access) return;
    try {
      await injectHook(tabId);
    } catch (err) {
      // Restricted pages (chrome://, web store) reject injection; ignore.
    }
  })();
});

// ---------------------------------------------------------------------------
// Install: defaults + one-tap side-panel open on action click.
// Property MUST be `openPanelOnActionClick` (the `...IconClick` variant
// throws a synchronous TypeError that kills the worker).
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (err) {
      console.warn('[worker] setPanelBehavior failed:', err?.message);
    }
    if (details.reason === 'install') {
      try {
        const current = await chrome.storage.local.get(['settings']);
        if (!current.settings) {
          await chrome.storage.local.set({
            settings: { theme: 'system', prettyDefault: true, preserveLog: false, maxEntries: 500 },
          });
        }
      } catch (err) {
        console.warn('[worker] default settings failed:', err?.message);
      }
    }
  })();
});
