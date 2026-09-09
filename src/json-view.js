// Collapsible JSON tree renderer shared by both surfaces.
// All untrusted strings go through textContent — never innerHTML.
//
// Usage:
//   const view = createJsonView({ onSelectPath });
//   view.render(container, value);   // value = parsed JSON
//   view.expandAll(); view.collapseAll();

import { formatSize } from './capture-record.js';

export const TREE_MAX_DEPTH = 5;
export const TREE_NODE_BUDGET = 2000;

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // Clipboard API may be unavailable (permissions); fallback to selection.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (err2) {
      return false;
    }
  }
}

export function downloadJson(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function pointerEscape(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function previewOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length})`;
  switch (typeof value) {
    case 'object':
      return `Object(${Object.keys(value).length})`;
    case 'string':
      return value.length > 80 ? `“${value.slice(0, 80)}…”` : `“${value}”`;
    default:
      return String(value);
  }
}

function valueClass(value) {
  if (value === null) return 'v-null';
  if (Array.isArray(value)) return 'v-container';
  switch (typeof value) {
    case 'object':
      return 'v-container';
    case 'string':
      return 'v-str';
    case 'number':
      return 'v-num';
    case 'boolean':
      return 'v-bool';
    default:
      return 'v-other';
  }
}

export function createJsonView({ onSelectPath } = {}) {
  const expandedPaths = new Set();
  let nodeBudget = TREE_NODE_BUDGET;
  let current = { container: null, value: undefined };

  function isContainer(value) {
    return value !== null && typeof value === 'object';
  }

  function childCount(value) {
    return Array.isArray(value) ? value.length : Object.keys(value).length;
  }

  function render(container, value) {
    current = { container, value };
    nodeBudget = TREE_NODE_BUDGET;
    expandedPaths.clear();
    draw();
  }

  function draw() {
    const { container, value } = current;
    if (!container) return;
    container.textContent = '';
    const state = { nodes: 0, capped: false };
    const doc = container.ownerDocument;
    if (value === undefined) {
      const empty = doc.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = 'No value to display.';
      container.appendChild(empty);
      return;
    }
    container.appendChild(buildNode(doc, value, null, '', 0, state));
    if (state.capped) {
      const more = doc.createElement('button');
      more.type = 'button';
      more.className = 'tree-more';
      more.textContent = `Large payload: showing first ${nodeBudget} nodes — Show more`;
      more.addEventListener('click', () => {
        nodeBudget += TREE_NODE_BUDGET;
        draw();
      });
      container.appendChild(more);
    }
  }

  function buildNode(doc, value, key, path, depth, state) {
    const row = doc.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = path || '(root)';

    const container = isContainer(value);
    const count = container ? childCount(value) : 0;
    // Beyond the depth cap a container starts collapsed unless expanded.
    let collapsed = container && count > 0 && depth >= TREE_MAX_DEPTH && !expandedPaths.has(path);

    if (container && count > 0) {
      const toggle = doc.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tree-toggle' + (collapsed ? ' is-collapsed' : '');
      toggle.textContent = collapsed ? '▸' : '▾';
      toggle.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (expandedPaths.has(path)) expandedPaths.delete(path);
        else expandedPaths.add(path);
        draw();
      });
      row.appendChild(toggle);
    } else {
      const spacer = doc.createElement('span');
      spacer.className = 'tree-spacer';
      row.appendChild(spacer);
    }

    if (key !== null && key !== undefined) {
      const keyEl = doc.createElement('span');
      keyEl.className = 'tree-key';
      keyEl.textContent = Array.isArray(value) ? key : String(key);
      row.appendChild(keyEl);
      const colon = doc.createElement('span');
      colon.className = 'tree-colon';
      colon.textContent = ': ';
      row.appendChild(colon);
    }

    const valEl = doc.createElement('span');
    valEl.className = `tree-val ${valueClass(value)}`;
    valEl.textContent = collapsed || !container ? previewOf(value) : Array.isArray(value) ? `[${count}]` : `{${count}}`;
    row.appendChild(valEl);

    // Hover actions: copy path / copy value.
    const actions = doc.createElement('span');
    actions.className = 'tree-actions';
    const copyPathBtn = doc.createElement('button');
    copyPathBtn.type = 'button';
    copyPathBtn.className = 'mini-btn';
    copyPathBtn.textContent = 'path';
    copyPathBtn.title = 'Copy JSON pointer path';
    copyPathBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await copyText(path || '#');
      flash(copyPathBtn, ok);
      if (onSelectPath) onSelectPath(path || '#', ok ? 'Path copied' : 'Copy failed');
    });
    const copyValBtn = doc.createElement('button');
    copyValBtn.type = 'button';
    copyValBtn.className = 'mini-btn';
    copyValBtn.textContent = 'value';
    copyValBtn.title = 'Copy value as JSON';
    copyValBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      let text = '';
      try {
        text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      } catch (err) {
        text = String(value);
      }
      const ok = await copyText(text);
      flash(copyValBtn, ok);
    });
    actions.appendChild(copyPathBtn);
    actions.appendChild(copyValBtn);
    row.appendChild(actions);

    row.addEventListener('click', () => {
      const prev = current.container?.querySelector('.tree-row.is-selected');
      if (prev) prev.classList.remove('is-selected');
      row.classList.add('is-selected');
      if (onSelectPath) onSelectPath(path || '#', `${formatSize(JSON.stringify(value)?.length || 0)}`);
    });

    const wrap = doc.createElement('div');
    wrap.className = 'tree-node';
    wrap.appendChild(row);

    if (container && count > 0 && !collapsed) {
      const kids = doc.createElement('div');
      kids.className = 'tree-kids';
      const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
      for (const [k, v] of entries) {
        state.nodes += 1;
        if (state.nodes > nodeBudget) {
          state.capped = true;
          break;
        }
        const childPath = `${path}/${pointerEscape(k)}`;
        kids.appendChild(buildNode(doc, v, k, childPath, depth + 1, state));
        if (state.capped) break;
      }
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function flash(btn, ok) {
    const original = btn.textContent;
    btn.textContent = ok ? '✓' : '✕';
    setTimeout(() => {
      btn.textContent = original;
    }, 900);
  }

  return {
    render,
    expandAll() {
      // Expand by lifting the depth cap: mark every container path expanded.
      // Walk the current value collecting paths (bounded to keep it cheap).
      const paths = [];
      const stack = [{ value: current.value, path: '', depth: 0 }];
      while (stack.length && paths.length < 5000) {
        const { value, path, depth } = stack.pop();
        if (value !== null && typeof value === 'object') {
          paths.push(path);
          const entries = Array.isArray(value)
            ? value.map((v, i) => [i, v])
            : Object.entries(value);
          for (const [k, v] of entries) {
            stack.push({ value: v, path: `${path}/${pointerEscape(k)}`, depth: depth + 1 });
          }
        }
      }
      for (const p of paths) expandedPaths.add(p);
      nodeBudget = Math.max(nodeBudget, 20000);
      draw();
    },
    collapseAll() {
      expandedPaths.clear();
      nodeBudget = TREE_NODE_BUDGET;
      draw();
    },
  };
}
