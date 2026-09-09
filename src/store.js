// In-memory entry store shared by both surfaces (no chrome.* APIs).
// Ring buffer + filter state + pub/sub. Pause drops incoming entries and
// counts them as missed so the UI can say so honestly.

import { statusClass } from './capture-record.js';

export const DEFAULT_FILTERS = Object.freeze({
  query: '',
  method: 'ALL',
  status: 'ALL',
});

export function createStore({ maxEntries = 500 } = {}) {
  const listeners = new Set();
  let entries = [];
  let filters = { ...DEFAULT_FILTERS };
  let paused = false;
  let missedWhilePaused = 0;
  let preserveLog = false;

  function emit(change) {
    for (const fn of listeners) {
      try {
        fn(change);
      } catch (err) {
        console.warn('[store] listener failed:', err?.message);
      }
    }
  }

  function matchesQuery(entry, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      entry.url.toLowerCase().includes(needle) ||
      (entry.bodyText && entry.bodyText.toLowerCase().includes(needle))
    );
  }

  return {
    add(entry) {
      if (paused) {
        missedWhilePaused += 1;
        emit({ kind: 'missed', missed: missedWhilePaused });
        return null;
      }
      entries.push(entry);
      while (entries.length > maxEntries) entries.shift();
      emit({ kind: 'add', entry });
      return entry;
    },

    clear() {
      entries = [];
      missedWhilePaused = 0;
      emit({ kind: 'clear' });
    },

    setPaused(value) {
      paused = Boolean(value);
      if (!paused) missedWhilePaused = 0;
      emit({ kind: 'paused', paused });
    },

    isPaused() {
      return paused;
    },

    missedCount() {
      return missedWhilePaused;
    },

    setPreserveLog(value) {
      preserveLog = Boolean(value);
      emit({ kind: 'preserve', preserveLog });
    },

    shouldPreserveLog() {
      return preserveLog;
    },

    /** Navigation: clear unless preserve-log is on. Returns true if cleared. */
    handleNavigation() {
      if (preserveLog) return false;
      this.clear();
      return true;
    },

    setFilters(partial) {
      filters = { ...filters, ...partial };
      emit({ kind: 'filter', filters: { ...filters } });
    },

    getFilters() {
      return { ...filters };
    },

    getById(id) {
      return entries.find((e) => e.id === id) || null;
    },

    count() {
      return entries.length;
    },

    getAll() {
      return [...entries];
    },

    /** Clamp the ring size (50–2000) and shed oldest immediately. */
    setMaxEntries(n) {
      const v = Math.floor(Number(n));
      if (!Number.isFinite(v)) return maxEntries;
      maxEntries = Math.min(2000, Math.max(50, v));
      while (entries.length > maxEntries) entries.shift();
      emit({ kind: 'limit', maxEntries });
      return maxEntries;
    },

    getFiltered() {
      const q = filters.query.trim();
      return entries.filter(
        (e) =>
          (filters.method === 'ALL' || e.method === filters.method) &&
          (filters.status === 'ALL' || statusClass(e.status) === filters.status) &&
          matchesQuery(e, q),
      );
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
