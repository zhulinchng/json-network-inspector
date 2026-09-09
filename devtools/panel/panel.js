// DevTools JSON panel: full-fidelity capture via chrome.devtools.network.
// Owns its in-memory buffer (this context dies with DevTools); the service
// worker is only touched for shared settings (theme), handled in src/.

import { createStore } from '../../src/store.js';
import { mountInspector } from '../../src/inspector-ui.js';
import {
  decodeBody,
  isJsonEntry,
  makeDevtoolsRecord,
  MAX_FORWARD_CHARS,
} from '../../src/capture-record.js';
import { loadSettings } from '../../src/settings.js';

const store = createStore({ maxEntries: 500 });

const inspector = mountInspector(document.getElementById('app'), {
  store,
  badgeText: 'DevTools',
  emptyTitle: 'No JSON captured yet',
  emptyHint: 'Reload the inspected page — JSON responses will appear here.',
  hooks: {},
});

async function initFromSettings() {
  try {
    const settings = await loadSettings();
    store.setPreserveLog(Boolean(settings.preserveLog));
    if (Number.isFinite(settings.maxEntries)) {
      store.setMaxEntries(settings.maxEntries);
    }
    followDevToolsTheme(settings.theme);
  } catch (err) {
    console.warn('[panel] settings load failed:', err?.message);
  }
}

/**
 * When the user leaves theme on 'system', follow the DevTools theme instead
 * of the OS preference — otherwise a dark DevTools gets a blinding panel.
 * themeName is 'default' (light) or 'dark' per the canonical API types.
 */
function followDevToolsTheme(configured) {
  try {
    const panels = chrome?.devtools?.panels;
    if (!panels || typeof panels.themeName !== 'string') return;
    if (configured !== 'system') return;
    const apply = (name) => {
      document.documentElement.dataset.theme = name === 'dark' ? 'dark' : 'light';
    };
    apply(panels.themeName);
    if (typeof panels.setThemeChangeHandler === 'function') {
      panels.setThemeChangeHandler(apply);
    }
  } catch (err) {
    // Theme follow is cosmetic; fall back to settings-driven theme.
  }
}

function acceptOf(entry) {
  try {
    const found = (entry.request?.headers || []).find(
      (h) => h.name && h.name.toLowerCase() === 'accept',
    );
    return found ? found.value : '';
  } catch (err) {
    return '';
  }
}

/**
 * getContent() has two signatures across Chrome versions: Promise form
 * resolving { content, encoding } and callback form (content, encoding).
 * Probe instead of assuming; always resolve (never hang the entry).
 */
function getBodyParts(request) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (content, encoding) => {
      if (settled) return;
      settled = true;
      resolve({ content: typeof content === 'string' ? content : '', encoding: encoding || '' });
    };
    try {
      const maybe = request.getContent();
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(
          (result) => {
            // Canonical: { content, encoding }. Tolerate legacy shapes.
            if (typeof result === 'string') done(result, '');
            else if (result && typeof result.content === 'string') done(result.content, result.encoding);
            else if (Array.isArray(result)) done(result[0], result[1]);
            else done('', '');
          },
          () => done('', ''),
        );
      } else if (typeof maybe === 'string') {
        done(maybe, '');
      } else {
        // Older shape returned undefined synchronously; try callback form.
        request.getContent((content, encoding) => done(content, encoding));
      }
    } catch (err) {
      try {
        request.getContent((content, encoding) => done(content, encoding));
      } catch (err2) {
        done('', '');
      }
    }
    // Safety net: never leave the entry hanging.
    setTimeout(() => done('', ''), 10000);
  });
}

async function handleFinished(harEntry) {
  try {
    const mimeType = harEntry?.response?.content?.mimeType || '';
    const url = harEntry?.request?.url || '';
    if (!isJsonEntry({ mimeType, url, accept: acceptOf(harEntry) })) return;

    const { content, encoding } = await getBodyParts(harEntry);
    const bodyText = decodeBody(content, encoding);
    if (!bodyText) return; // e.g. cached/empty body with no content exposed.
    // Truncation (flagged in the UI) happens in makeDevtoolsRecord; only
    // pathological multi-MB dumps are dropped to protect the renderer.
    if (bodyText.length > MAX_FORWARD_CHARS) return;

    const record = makeDevtoolsRecord({
      entry: harEntry,
      bodyText,
      tabId: chrome.devtools.inspectedWindow.tabId,
    });
    store.add(record);
  } catch (err) {
    console.warn('[panel] request handling failed:', err?.message);
  }
}

chrome.devtools.network.onRequestFinished.addListener(handleFinished);

chrome.devtools.network.onNavigated.addListener(() => {
  store.handleNavigation();
});

initFromSettings();
