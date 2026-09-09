// Side panel: always-on JSON capture via the page hook (no DevTools needed).
// Follows the active tab: switching tabs reloads that tab's buffered entries.
// Page-hook traffic misses non-fetch resources (WebSocket/SSE/navigation) —
// the DevTools panel covers those; the hint below says so.

import { createStore } from '../src/store.js';
import { mountInspector } from '../src/inspector-ui.js';
import {
  isValidHookPayload,
  makePageHookRecord,
} from '../src/capture-record.js';
import { loadSettings } from '../src/settings.js';

const store = createStore({ maxEntries: 500 });

const inspector = mountInspector(document.getElementById('app'), {
  store,
  badgeText: 'page hook',
  emptyTitle: 'No JSON captured on this tab',
  emptyHint: 'Enable capture above, then use the page — fetch/XHR JSON will appear here.',
  hooks: {
    onClear: async () => {
      if (currentTabId != null) {
        try {
          await chrome.runtime.sendMessage({ type: 'CLEAR_BUFFER', tabId: currentTabId });
        } catch (err) {
          console.warn('[sidepanel] clear buffer failed:', err?.message);
        }
      }
    },
  },
});

const doc = document;
let currentTabId = null;
let port = null;

function el(tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- capture bar (injected into the inspector's surface slot) ----
const captureBar = el('div', 'capture-bar');
const dot = el('span', 'capture-dot');
const captureText = el('span', 'capture-text', 'Checking capture state…');
const captureBtn = el('button', 'capture-btn is-off', 'Enable capture');
captureBtn.type = 'button';
captureBar.appendChild(dot);
captureBar.appendChild(captureText);
captureBar.appendChild(captureBtn);
inspector.surfaceSlot.appendChild(captureBar);

const hint = el(
  'div',
  'capture-hint',
  'Tip: the page hook sees fetch/XHR only. For WebSocket, SSE, and document loads, use the DevTools → JSON tab.',
);
inspector.surfaceSlot.appendChild(hint);

function setBar({ enabled, tabLabel }) {
  dot.classList.toggle('is-on', Boolean(enabled));
  captureBtn.textContent = enabled ? 'Disable' : 'Enable capture';
  captureBtn.classList.toggle('is-off', !enabled);
  captureText.textContent = enabled
    ? `Capturing JSON on ${tabLabel}`
    : `Capture off — ${tabLabel}`;
}

captureBtn.addEventListener('click', async () => {
  if (currentTabId == null) return;
  captureBtn.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_STATE', tabId: currentTabId });
    if (state && state.enabled) {
      await chrome.runtime.sendMessage({ type: 'REQUEST_CAPTURE_DISABLE', tabId: currentTabId });
    } else {
      const result = await chrome.runtime.sendMessage({
        type: 'REQUEST_CAPTURE_ENABLE',
        tabId: currentTabId,
      });
      if (result && !result.granted) {
        captureText.textContent = 'Host permission denied — capture needs it for this site.';
        return;
      }
      if (result && result.error) {
        captureText.textContent = `Could not inject into this page (${result.error}). Try a regular http(s) page.`;
        return;
      }
      await refreshState();
      if (result && result.partial) {
        captureText.textContent += ' (top frame only — some subframes refused injection)';
      }
      return;
    }
    await refreshState();
  } catch (err) {
    captureText.textContent = `Capture toggle failed: ${err?.message || err}`;
  } finally {
    captureBtn.disabled = false;
  }
});

// ---- worker port (live relay; reconnects if the worker restarts) ----
function connectPort() {
  try {
    if (port) port.disconnect();
  } catch (err) {
    // Ignore.
  }
  const tabId = currentTabId;
  port = chrome.runtime.connect({ name: 'sidepanel' });
  if (tabId != null) {
    try {
      // Re-announce on every (re)connect: a worker restart wipes the
      // worker-side tab mapping, and without this live relay goes silent.
      port.postMessage({ type: 'PORT_INIT', tabId });
    } catch (err) {
      // Will retry on next tab event.
    }
    // Catch up on entries persisted while we were disconnected.
    loadBuffer(tabId);
  }
  port.onMessage.addListener((msg) => {
    // Relay is already tab-scoped worker-side; accept everything on this port.
    if (msg && msg.type === 'JSON_CAPTURE' && isValidHookPayload(msg.entry)) {
      store.add(makePageHookRecord(msg.entry));
    }
  });
  port.onDisconnect.addListener(() => {
    // Worker restarted; reconnect shortly so live relay resumes.
    setTimeout(connectPort, 1000);
  });
}

// ---- tab tracking ----
async function describeTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      try {
        return new URL(tab.url).host || tab.url;
      } catch (err) {
        return tab.url;
      }
    }
    return tab.title || `tab ${tabId}`;
  } catch (err) {
    return `tab ${tabId}`;
  }
}

async function loadBuffer(tabId) {
  try {
    const { entries } = await chrome.runtime.sendMessage({ type: 'GET_BUFFER', tabId });
    store.clear();
    for (const raw of entries || []) {
      if (isValidHookPayload(raw)) store.add(makePageHookRecord(raw));
    }
  } catch (err) {
    console.warn('[sidepanel] buffer load failed:', err?.message);
  }
}

async function refreshState() {
  if (currentTabId == null) return;
  try {
    const state = await chrome.runtime.sendMessage({
      type: 'GET_CAPTURE_STATE',
      tabId: currentTabId,
    });
    setBar({ enabled: Boolean(state && state.enabled), tabLabel: await describeTab(currentTabId) });
  } catch (err) {
    setBar({ enabled: false, tabLabel: await describeTab(currentTabId) });
  }
}

async function switchToTab(tabId) {
  currentTabId = tabId;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) lastSeenUrl = tab.url;
  } catch (err) {
    // Tab may be gone; lastSeenUrl stays as-is.
  }
  if (port) {
    try {
      port.postMessage({ type: 'PORT_SWITCH_TAB', tabId });
    } catch (err) {
      connectPort();
    }
  }
  await loadBuffer(tabId);
  await refreshState();
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  (async () => {
    await switchToTab(activeInfo.tabId);
  })();
});

let lastSeenUrl = null;

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== currentTabId) return;
  if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
    (async () => {
      // Navigation wipes MAIN-world patches; the worker re-injects when
      // enabled. A genuinely new URL means fresh traffic: reset the buffer
      // unless preserve-log is on.
      const url = tab?.url || changeInfo.url || null;
      if (url && lastSeenUrl && url !== lastSeenUrl && !store.shouldPreserveLog()) {
        store.clear();
        try {
          await chrome.runtime.sendMessage({ type: 'CLEAR_BUFFER', tabId });
        } catch (err) {
          console.warn('[sidepanel] clear on navigation failed:', err?.message);
        }
      }
      if (url) lastSeenUrl = url;
      await loadBuffer(tabId);
      await refreshState();
    })();
  }
});
async function init() {
  try {
    const settings = await loadSettings();
    store.setPreserveLog(Boolean(settings.preserveLog));
    if (Number.isFinite(settings.maxEntries)) {
      store.setMaxEntries(settings.maxEntries);
    }
  } catch (err) {
    console.warn('[sidepanel] settings load failed:', err?.message);
  }
  connectPort();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      if (tab.url) lastSeenUrl = tab.url;
      await switchToTab(tab.id);
    } else {
      captureText.textContent = 'No active tab found.';
    }
  } catch (err) {
    captureText.textContent = `Cannot read tabs: ${err?.message || err}`;
  }
}

init();
