# Viewer UI (shared)

Both surfaces mount the same inspector (`mountInspector(root, opts)` in
`src/inspector-ui.js`) with different `store`, `badgeText` (`'DevTools'` /
`'page hook'`), empty-state copy, and hooks. The side panel additionally
injects its capture bar + hint into the returned `surfaceSlot`.

## Layout

Header (`JSON Inspector` + source badge + theme button) → optional surface
slot → toolbar → two panes: request list (left) and detail (right). Under
700 px (`@media (max-width: 700px)` in `theme.css`) the panes stack
vertically. Themes are CSS variables under `:root[data-theme='light'|'dark']`;
`applyTheme` sets `document.documentElement.dataset.theme`.

## List

- Rows show method badge, status (class-colored, `statusText` on hover),
  duration, URL path (`displayPath`; full URL on hover), and a sub-line: size,
  MIME head, `⇅ <size> sent` when a request body exists, `not JSON` flag, and
  a `truncated` marker.
- Rendering is batched (60 rows per `requestAnimationFrame`, `setTimeout`
  fallback) so large buffers stay interactive; renders are coalesced through
  `queueRender`.
- Count label reads `<visible> / <total>` — and filtering happens **only**
  here, via `entryMatches` over `store.getAll()`, so the label cannot lie.
- Empty states distinguish “nothing captured” (per-surface hint) from “no
  matches” (adjust filters).

## Detail tabs (`Pretty` / `Raw` / `Request` / `Headers` / `Timing`)

- Meta line: `METHOD url — status text · duration · size`. Expand/Collapse
  buttons show only on tree tabs.
- **Pretty**: collapsible tree for parsed JSON; unparseable bodies render as
  raw text with a “Non-JSON response” banner. Truncated bodies get a banner
  naming the 2 MB cap and original size (“Download saves what's shown”).
- **Raw**: syntax-highlighted source (`appendHighlighted`).
- **Request**: payload tree with method/MIME/size header; 256 KB banner when
  truncated; “No request body captured” note for empty payloads; non-JSON
  payloads as raw text.
- **Headers**: General table (method, URL, status, MIME, started, source)
  plus alphabetically sorted request/response header tables (“None captured”
  when empty).
- **Timing**: single `Total` bar (width scaled to 220 px) + started/size rows,
  with an explicit note that phase-level timings (DNS/TLS/TTFB) are not
  exposed to extensions — compare with the native Network tab.
- Actions: **Expand all** (bounded: 5 000 paths, 20 000-node budget),
  **Collapse**, **Copy body** (✓/✕ feedback, 1 s), **Download** (filename
  from URL's last path segment sanitized to 40 chars + method + status).
- Keyboard: `/` focuses search, `Esc` clears it (scoped to the mounted root).

## Tree view (`src/json-view.js`)

- Containers start expanded to `TREE_MAX_DEPTH` (5); deeper levels collapse
  until clicked (expanded paths tracked per render).
- Node budget `TREE_NODE_BUDGET` (2000): past it, rendering stops and a
  “Large payload: showing first N nodes — Show more” button adds 2000 more
  per click.
- Collapsed/leaf previews: `Array(n)`, `Object(n)`, quoted strings (80-char
  cap), `null`, primitives; expanded containers show `[n]`/`{n}`.
- Each row offers **path** (copies the JSON-pointer path, `~0`/`~1` escaped)
  and **value** (raw string or pretty JSON) copy buttons with ✓/✕ flash;
  clicking a row reports `path · size` to the path bar.
- `copyText` tries `navigator.clipboard.writeText`, falling back to a hidden
  textarea + `execCommand('copy')`. `downloadJson` uses a Blob URL revoked
  after 5 s.
- All untrusted strings go through `textContent` — never `innerHTML`.

## Highlighter (`src/highlight.js`)

Regex tokenizer over the source text: quoted keys (`tok-key`), strings
(`tok-str`), numbers (`tok-num`), `true`/`false`/`null` (`tok-lit`),
everything between tokens (`tok-punct`) — all appended as spans with
`textContent`, so hostile bodies cannot inject markup. Sources with zero
tokens fall back to plain text.

## Toolbar (`src/filters.js`)

- Search (`type="search"`, “Filter by URL or body ( / )”) debounced 150 ms
  into `store.setFilters({ query })`.
- Method dropdown: ALL/GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD. Status
  dropdown: ALL/2xx/3xx/4xx/5xx/other.
- **Pause** drops incoming entries and shows `paused · N missed`; **Resume**
  resets. **Clear** empties the store and calls the surface's `onClear`
  (side panel also clears the worker buffer). **Preserve log** checkbox
  persists via `onPreserveChange → saveSettings({ preserveLog })`.

## Filtering semantics (`entryMatches`)

Method and status-class must match; the query matches URL substring first,
then a **100 KB body prefix** (`BODY_SEARCH_LIMIT`) so multi-MB payloads
stay interactive. Case-insensitive throughout.

## Theme sync

The header button cycles `system → light → dark`, persisting each step; a
`storage.onChanged` subscriber applies remote changes live, so toggling in
one surface updates the other. The DevTools panel additionally forces the
DevTools theme when the setting is `system` (see `devtools-panel.md`).

---
*Verified against: `src/inspector-ui.js` (tabs, batches, rows, banners,
timing note, keyboard, theme wiring, `surfaceSlot`), `src/json-view.js`
(depth/node budgets, pointer escaping, copy/download), `src/highlight.js`
(token classes, textContent-only, fallback), `src/filters.js` (debounce,
option lists, pause/missed, preserve wiring), `src/theme.css` (variables,
700 px breakpoint). Covered by `test/render.test.js` (8 tests).*
