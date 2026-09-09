// Shared settings persistence (chrome.storage.local, key `settings`).
// Falls back to in-memory defaults when storage is unavailable (should not
// happen on extension pages, but keeps modules import-safe elsewhere).

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system', // 'light' | 'dark' | 'system'
  prettyDefault: true,
  preserveLog: false,
  maxEntries: 500,
});

const listeners = new Set();
let storageAvailable = typeof chrome !== 'undefined' && !!chrome.storage?.local;

if (storageAvailable) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        const next = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
        for (const fn of listeners) {
          try {
            fn(next);
          } catch (err) {
            console.warn('[settings] listener failed:', err?.message);
          }
        }
      }
    });
  } catch (err) {
    storageAvailable = false;
  }
}

export async function loadSettings() {
  if (!storageAvailable) return { ...DEFAULT_SETTINGS };
  try {
    const data = await chrome.storage.local.get(['settings']);
    return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  } catch (err) {
    console.warn('[settings] load failed:', err?.message);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(partial) {
  const next = { ...DEFAULT_SETTINGS, ...(await loadSettings()), ...partial };
  if (!storageAvailable) return next;
  try {
    await chrome.storage.local.set({ settings: next });
  } catch (err) {
    console.warn('[settings] save failed:', err?.message);
  }
  return next;
}

export function onSettingsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolve 'system' to the OS preference; returns 'light' | 'dark'. */
export function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (err) {
    return 'light';
  }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = resolveTheme(theme);
}
