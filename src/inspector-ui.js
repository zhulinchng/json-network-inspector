// Shared inspector shell: toolbar + request list + detail tabs.
// Used by the DevTools panel and the side panel with different capture
// wiring. All untrusted strings go through textContent.
//
// Filtering lives ONLY here (entryMatches over store.getAll()) so the list
// the user sees is exactly what the count label describes. The store's own
// getFiltered() remains for API compatibility but is not used on this path.

import { createJsonView, copyText, downloadJson } from './json-view.js';
import { appendHighlighted } from './highlight.js';
import { mountToolbar } from './filters.js';
import { applyTheme, loadSettings, onSettingsChanged, saveSettings } from './settings.js';
import {
  displayPath,
  formatSize,
  formatTime,
  parseSafe,
  statusClass,
} from './capture-record.js';

const DETAIL_TABS = ['Pretty', 'Raw', 'Request', 'Headers', 'Timing'];
const BODY_SEARCH_LIMIT = 100 * 1024;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function entryMatches(entry, filters) {
  if (filters.method !== 'ALL' && entry.method !== filters.method) return false;
  if (filters.status !== 'ALL' && statusClass(entry.status) !== filters.status) return false;
  const q = filters.query.trim().toLowerCase();
  if (!q) return true;
  if (entry.url.toLowerCase().includes(q)) return true;
  // Body search scans a prefix so multi-MB payloads stay interactive.
  const haystack = (entry.bodyText || '').slice(0, BODY_SEARCH_LIMIT).toLowerCase();
  return haystack.includes(q);
}

/**
 * Mount the inspector into `root`.
 * opts: { store, badgeText, emptyTitle, emptyHint, hooks: { onClear },
 *         deferSystemTheme } — deferSystemTheme lets the DevTools panel own
 * the 'system' theme (it follows DevTools, not the OS).
 */
export function mountInspector(root, opts) {
  const doc = root.ownerDocument;
  const store = opts.store;
  const hooks = opts.hooks || {};
  const treeView = createJsonView({
    onSelectPath: (path, note) => {
      pathBar.textContent = `${path}${note ? `  ·  ${note}` : ''}`;
    },
  });

  let selectedId = null;
  let activeTab = 'Pretty';
  let renderQueued = false;

  // ---- header ----
  const header = el(doc, 'header', 'app-header');
  header.appendChild(el(doc, 'h1', 'app-title', 'JSON Inspector'));
  header.appendChild(el(doc, 'span', 'source-badge', opts.badgeText || ''));
  header.appendChild(el(doc, 'span', 'header-spacer'));
  const themeBtn = el(doc, 'button', 'theme-btn', 'Theme');
  themeBtn.type = 'button';
  header.appendChild(themeBtn);
  root.appendChild(header);

  // Optional surface slot (side panel injects its capture bar here).
  const slot = el(doc, 'div', 'surface-slot');
  root.appendChild(slot);

  // ---- toolbar ----
  const toolbarHost = el(doc, 'div');
  root.appendChild(toolbarHost);
  const toolbar = mountToolbar(toolbarHost, store, {
    onClear: hooks.onClear,
    onPauseChange: () => queueRender(),
    onPreserveChange: (value) => {
      saveSettings({ preserveLog: value });
    },
  });

  // ---- panes ----
  const panes = el(doc, 'div', 'panes');
  const listPane = el(doc, 'div', 'list-pane');
  listPane.setAttribute('role', 'listbox');
  listPane.setAttribute('aria-label', 'Captured JSON requests');
  const detailPane = el(doc, 'div', 'detail-pane');
  const tabsRow = el(doc, 'div', 'detail-tabs');
  const detailBody = el(doc, 'div', 'detail-body');
  const detailMeta = el(doc, 'div', 'detail-meta');
  const pathBar = el(doc, 'div', 'path-bar', '#');
  panes.appendChild(listPane);
  panes.appendChild(detailPane);
  detailPane.appendChild(tabsRow);
  detailPane.appendChild(detailBody);
  detailPane.appendChild(detailMeta);
  detailPane.appendChild(pathBar);
  root.appendChild(panes);

  const tabButtons = new Map();
  for (const name of DETAIL_TABS) {
    const btn = el(doc, 'button', 'detail-tab' + (name === activeTab ? ' is-active' : ''), name);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      activeTab = name;
      for (const [n, b] of tabButtons) b.classList.toggle('is-active', n === name);
      renderDetail();
    });
    tabButtons.set(name, btn);
    tabsRow.appendChild(btn);
  }
  const actions = el(doc, 'div', 'detail-actions');
  const expandBtn = el(doc, 'button', 'tb-btn', 'Expand all');
  expandBtn.type = 'button';
  expandBtn.title = 'Expand the whole tree (bounded)';
  expandBtn.addEventListener('click', () => treeView.expandAll());
  const collapseBtn = el(doc, 'button', 'tb-btn', 'Collapse');
  collapseBtn.type = 'button';
  collapseBtn.addEventListener('click', () => treeView.collapseAll());
  const copyBtn = el(doc, 'button', 'tb-btn', 'Copy body');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    const entry = store.getById(selectedId);
    if (!entry) return;
    const ok = await copyText(entry.bodyText);
    copyBtn.textContent = ok ? 'Copied ✓' : 'Failed ✕';
    setTimeout(() => {
      copyBtn.textContent = 'Copy body';
    }, 1000);
  });
  const dlBtn = el(doc, 'button', 'tb-btn', 'Download');
  dlBtn.type = 'button';
  dlBtn.addEventListener('click', () => {
    const entry = store.getById(selectedId);
    if (!entry) return;
    downloadJson(suggestFilename(entry), entry.bodyText);
  });
  actions.appendChild(expandBtn);
  actions.appendChild(collapseBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(dlBtn);
  tabsRow.appendChild(actions);

  // ---- theme (synced when another surface changes it) ----
  async function initTheme() {
    const settings = await loadSettings();
    if (!(opts.deferSystemTheme && settings.theme === 'system')) {
      applyTheme(settings.theme);
    }
    themeBtn.textContent = `Theme: ${settings.theme}`;
  }
  themeBtn.addEventListener('click', async () => {
    const settings = await loadSettings();
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(settings.theme) + 1) % order.length];
    await saveSettings({ theme: next });
    if (!(opts.deferSystemTheme && next === 'system')) {
      applyTheme(next);
    }
    themeBtn.textContent = `Theme: ${next}`;
  });
  onSettingsChanged((settings) => {
    if (!(opts.deferSystemTheme && settings.theme === 'system')) {
      applyTheme(settings.theme);
    }
    themeBtn.textContent = `Theme: ${settings.theme}`;
  });
  initTheme();

  // ---- list rendering (batched; keeps huge buffers interactive) ----
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 0);
    schedule(() => {
      renderQueued = false;
      renderList();
    });
  }

  function renderList() {
    const filters = store.getFilters();
    const total = store.count();
    const visible = store.getAll().filter((e) => entryMatches(e, filters));
    toolbar.refreshCounts(total, visible.length);

    listPane.textContent = '';
    if (visible.length === 0) {
      const empty = el(doc, 'div', 'empty-note');
      empty.appendChild(el(doc, 'strong', '', total === 0 ? opts.emptyTitle : 'No matches'));
      empty.appendChild(
        el(doc, 'span', '', total === 0 ? opts.emptyHint : 'Adjust the search or filters above.'),
      );
      listPane.appendChild(empty);
      if (!store.getById(selectedId)) {
        selectedId = null;
        renderDetail();
      }
      return;
    }

    const BATCH = 60;
    let index = 0;
    const frag = doc.createDocumentFragment();
    function appendBatch() {
      const end = Math.min(index + BATCH, visible.length);
      for (; index < end; index += 1) {
        frag.appendChild(buildRow(doc, visible[index]));
      }
      listPane.appendChild(frag);
      if (index < visible.length) {
        const schedule =
          typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (fn) => setTimeout(fn, 0);
        schedule(appendBatch);
      }
    }
    appendBatch();
  }

  function buildRow(doc, entry) {
    const row = el(doc, 'button', 'req-row' + (entry.id === selectedId ? ' is-selected' : ''));
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(entry.id === selectedId));

    const top = el(doc, 'div', 'req-top');
    const method = el(doc, 'span', `method m-${entry.method.toLowerCase()}`, entry.method);
    const status = el(doc, 'span', `status s-${statusClass(entry.status)}`, String(entry.status || '—'));
    status.title = entry.statusText || '';
    const time = el(doc, 'span', 'req-time', formatTime(entry.timeMs));
    top.appendChild(method);
    top.appendChild(status);
    top.appendChild(time);
    row.appendChild(top);

    const url = el(doc, 'div', 'req-url', displayPath(entry.url));
    url.title = entry.url;
    row.appendChild(url);

    const subBits = [formatSize(entry.originalSize || entry.bodyText.length)];
    if (entry.mimeType) subBits.push(entry.mimeType.split(';')[0]);
    if (entry.reqBodySize > 0) subBits.push(`⇅ ${formatSize(entry.reqBodySize)} sent`);
    if (entry.unparseable) subBits.push('not JSON');
    const sub = el(doc, 'div', 'req-sub', subBits.join(' · '));
    if (entry.truncated) {
      sub.appendChild(el(doc, 'span', 'trunc-flag', ' · truncated'));
    }
    row.appendChild(sub);

    row.addEventListener('click', () => {
      selectedId = entry.id;
      const prev = listPane.querySelector('.req-row.is-selected');
      if (prev) {
        prev.classList.remove('is-selected');
        prev.setAttribute('aria-selected', 'false');
      }
      row.classList.add('is-selected');
      row.setAttribute('aria-selected', 'true');
      renderDetail();
    });
    return row;
  }

  // ---- detail ----
  function suggestFilename(entry) {
    let base = 'response';
    try {
      const parts = new URL(entry.url).pathname.split('/').filter(Boolean);
      if (parts.length) base = parts[parts.length - 1].split('.')[0] || base;
    } catch (err) {
      // Keep default.
    }
    const safe = base.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 40) || 'response';
    return `${safe}-${entry.method.toLowerCase()}-${entry.status || 'x'}.json`;
  }

  function banner(text) {
    const node = el(detailBody.ownerDocument, 'div', 'banner', text);
    detailBody.appendChild(node);
  }

  function renderDetail() {
    detailBody.textContent = '';
    pathBar.textContent = '#';
    const entry = store.getById(selectedId);
    if (!entry) {
      const empty = el(doc, 'div', 'empty-note');
      empty.appendChild(el(doc, 'strong', '', 'No request selected'));
      empty.appendChild(el(doc, 'span', '', 'Select a request from the list to inspect it.'));
      detailBody.appendChild(empty);
      detailMeta.textContent = '';
      return;
    }

    detailMeta.textContent =
      `${entry.method} ${entry.url} — ${entry.status}${entry.statusText ? ` ${entry.statusText}` : ''} · ${formatTime(entry.timeMs)} · ${formatSize(entry.originalSize || 0)}`;

    const treeVisible = activeTab === 'Pretty' || activeTab === 'Request';
    expandBtn.style.display = treeVisible ? '' : 'none';
    collapseBtn.style.display = treeVisible ? '' : 'none';

    if (activeTab === 'Request') {
      renderRequestTab(entry);
      return;
    }

    if (entry.truncated) {
      banner(
        `Response exceeded the 2 MB capture cap — showing the first 2 MB of ${formatSize(entry.originalSize)}. Download saves what's shown.`,
      );
    }

    if (activeTab === 'Pretty') {
      const parsed = entry.bodyText ? parseSafe(entry.bodyText) : { ok: false };
      if (!parsed.ok) {
        if (entry.bodyText) banner('Non-JSON response — showing raw text.');
        const pre = el(doc, 'pre', 'raw-pre', entry.bodyText || '(empty body)');
        detailBody.appendChild(pre);
        return;
      }
      const host = el(doc, 'div', 'tree-host');
      detailBody.appendChild(host);
      treeView.render(host, parsed.value);
    } else if (activeTab === 'Raw') {
      const pre = el(doc, 'pre', 'raw-pre');
      const code = el(doc, 'code');
      pre.appendChild(code);
      detailBody.appendChild(pre);
      appendHighlighted(code, entry.bodyText || '');
    } else if (activeTab === 'Headers') {
      renderHeaders(entry);
    } else {
      renderTiming(entry);
    }
  }

  function renderRequestTab(entry) {
    const infoBits = [entry.method];
    if (entry.reqBodyMime) infoBits.push(entry.reqBodyMime.split(';')[0]);
    if (entry.reqBodySize > 0) infoBits.push(formatSize(entry.reqBodySize));
    detailBody.appendChild(el(doc, 'div', 'hdr-section', `Request payload · ${infoBits.join(' · ')}`));
    if (entry.reqBodyTruncated) {
      banner(
        `Request payload exceeded the 256 KB capture cap — showing the first 256 KB of ${formatSize(entry.reqBodySize)}.`,
      );
    }
    if (!entry.reqBody) {
      detailBody.appendChild(el(doc, 'div', 'empty-note', 'No request body captured (GET/HEAD or empty payload).'));
      return;
    }
    const parsed = parseSafe(entry.reqBody);
    if (!parsed.ok) {
      const pre = el(doc, 'pre', 'raw-pre', entry.reqBody);
      detailBody.appendChild(pre);
      return;
    }
    const host = el(doc, 'div', 'tree-host');
    detailBody.appendChild(host);
    treeView.render(host, parsed.value);
  }

  function headerTable(title, obj) {
    detailBody.appendChild(el(doc, 'div', 'hdr-section', title));
    const names = Object.keys(obj || {});
    if (names.length === 0) {
      detailBody.appendChild(el(doc, 'div', 'empty-note', 'None captured.'));
      return;
    }
    const table = el(doc, 'table', 'hdr-table');
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      const tr = el(doc, 'tr');
      tr.appendChild(el(doc, 'th', '', name));
      tr.appendChild(el(doc, 'td', '', String(obj[name])));
      table.appendChild(tr);
    }
    detailBody.appendChild(table);
  }

  function renderHeaders(entry) {
    detailBody.appendChild(el(doc, 'div', 'hdr-section', 'General'));
    const table = el(doc, 'table', 'hdr-table');
    const rows = [
      ['Method', entry.method],
      ['URL', entry.url],
      ['Status', `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ''}`],
      ['MIME', entry.mimeType || '—'],
      ['Started', entry.startedAt],
      ['Source', entry.source],
    ];
    for (const [k, v] of rows) {
      const tr = el(doc, 'tr');
      tr.appendChild(el(doc, 'th', '', k));
      tr.appendChild(el(doc, 'td', '', v));
      table.appendChild(tr);
    }
    detailBody.appendChild(table);
    headerTable('Response headers', entry.resHeaders);
    headerTable('Request headers', entry.reqHeaders);
  }

  function renderTiming(entry) {
    const grid = el(doc, 'div', 'timing-grid');
    const max = Math.max(entry.timeMs, 1);
    const row = (label, ms) => {
      grid.appendChild(el(doc, 'span', '', label));
      const bar = el(doc, 'div', 'timing-bar');
      bar.style.width = `${Math.max(2, Math.round((ms / max) * 220))}px`;
      grid.appendChild(bar);
      grid.appendChild(el(doc, 'span', 'timing-val', formatTime(ms)));
    };
    row('Total', entry.timeMs);
    grid.appendChild(el(doc, 'span', '', 'Started'));
    const started = el(doc, 'span', 'timing-val', entry.startedAt);
    started.style.gridColumn = 'span 2';
    grid.appendChild(started);
    grid.appendChild(el(doc, 'span', '', 'Size'));
    const size = el(doc, 'span', 'timing-val', formatSize(entry.originalSize || 0));
    size.style.gridColumn = 'span 2';
    grid.appendChild(size);
    detailBody.appendChild(grid);
    const note = el(doc, 'div', 'empty-note', 'Phase-level timings (DNS, TLS, TTFB) are not exposed to extensions; DevTools users can compare with the native Network tab.');
    detailBody.appendChild(note);
  }

  // ---- keyboard ----
  root.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && doc.activeElement !== toolbar.searchInput) {
      ev.preventDefault();
      toolbar.searchInput.focus();
    } else if (ev.key === 'Escape' && doc.activeElement === toolbar.searchInput) {
      toolbar.searchInput.value = '';
      store.setFilters({ query: '' });
      toolbar.searchInput.blur();
    }
  });

  store.subscribe((change) => {
    if (change && change.kind === 'filter') queueRender();
    else queueRender();
    if (change && change.kind === 'clear') {
      selectedId = null;
      renderDetail();
    }
  });

  renderList();
  renderDetail();

  return {
    store,
    surfaceSlot: slot,
    select(id) {
      selectedId = id;
      renderList();
      renderDetail();
    },
    refresh: queueRender,
  };
}
