// Shared toolbar: search + method/status filters + pause/clear/preserve-log.
// Mounts DOM into a host element; all strings via textContent.

const METHODS = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const STATUSES = ['ALL', '2xx', '3xx', '4xx', '5xx', 'other'];

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labeledSelect(doc, labelText, options, initial, onChange) {
  const label = el(doc, 'label', 'tb-field');
  const caption = el(doc, 'span', 'tb-caption', labelText);
  const select = el(doc, 'select', 'tb-select');
  for (const opt of options) {
    const o = el(doc, 'option', '', opt === 'ALL' ? `${labelText}: all` : opt);
    o.value = opt;
    if (opt === initial) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener('change', () => onChange(select.value));
  label.appendChild(caption);
  label.appendChild(select);
  return label;
}

/**
 * Mount the shared toolbar.
 * store: entry store. hooks: { onClear, onPauseChange } for surface extras.
 * Returns { searchInput, refreshCounts }.
 */
export function mountToolbar(host, store, hooks = {}) {
  const doc = host.ownerDocument;
  host.textContent = '';
  const bar = el(doc, 'div', 'toolbar');

  const searchWrap = el(doc, 'label', 'tb-search');
  const searchInput = el(doc, 'input', 'tb-input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Filter by URL or body  ( / )';
  searchInput.setAttribute('aria-label', 'Filter requests by URL or body');
  searchInput.value = store.getFilters().query;
  searchWrap.appendChild(searchInput);
  bar.appendChild(searchWrap);

  let debounce = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      store.setFilters({ query: searchInput.value });
    }, 150);
  });

  const filters = store.getFilters();
  bar.appendChild(
    labeledSelect(doc, 'Method', METHODS, filters.method, (v) => store.setFilters({ method: v })),
  );
  bar.appendChild(
    labeledSelect(doc, 'Status', STATUSES, filters.status, (v) => store.setFilters({ status: v })),
  );

  const pauseBtn = el(doc, 'button', 'tb-btn', 'Pause');
  pauseBtn.type = 'button';
  pauseBtn.title = 'Pause capture (incoming entries are dropped)';
  pauseBtn.setAttribute('aria-pressed', 'false');
  pauseBtn.addEventListener('click', () => {
    const next = !store.isPaused();
    store.setPaused(next);
    if (hooks.onPauseChange) hooks.onPauseChange(next);
  });
  bar.appendChild(pauseBtn);

  const clearBtn = el(doc, 'button', 'tb-btn', 'Clear');
  clearBtn.type = 'button';
  clearBtn.title = 'Clear captured entries';
  clearBtn.addEventListener('click', async () => {
    store.clear();
    if (hooks.onClear) await hooks.onClear();
  });
  bar.appendChild(clearBtn);

  const preserveLabel = el(doc, 'label', 'tb-check');
  const preserveBox = el(doc, 'input', 'tb-box');
  preserveBox.type = 'checkbox';
  preserveBox.checked = store.shouldPreserveLog();
  preserveBox.addEventListener('change', () => {
    store.setPreserveLog(preserveBox.checked);
    if (hooks.onPreserveChange) hooks.onPreserveChange(preserveBox.checked);
  });
  preserveLabel.appendChild(preserveBox);
  preserveLabel.appendChild(el(doc, 'span', '', 'Preserve log'));
  bar.appendChild(preserveLabel);

  const count = el(doc, 'span', 'tb-count', '0');
  count.title = 'Captured entries';
  bar.appendChild(count);

  const pausedNote = el(doc, 'span', 'tb-paused is-hidden', 'paused');
  bar.appendChild(pausedNote);

  host.appendChild(bar);

  function refresh(entryCount, filteredCount) {
    count.textContent = `${filteredCount} / ${entryCount}`;
    const isPaused = store.isPaused();
    pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-pressed', String(isPaused));
    pausedNote.classList.toggle('is-hidden', !isPaused);
    const missed = store.missedCount();
    pausedNote.textContent = isPaused ? `paused${missed ? ` · ${missed} missed` : ''}` : '';
  }

  return { searchInput, refreshCounts: refresh };
}
