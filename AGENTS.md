# Repository Guidelines

Vanilla-JS MV3 Chrome extension: a DevTools "JSON" panel (full-fidelity
bodies) plus an always-on side panel fed by an opt-in page hook. Zero
dependencies, no build step, local-only (no backend, accounts, or analytics).
Design detail lives in `docs/`; this file is the operating manual.

## Commands

- `npm test` → `node --test test/` — stdlib only. Must be green before
  finishing any behavior change.
- `node --check <file>` — syntax-check one file.
- Manual QA: load unpacked, open `test-fixture.html`, exercise the DevTools
  panel + side panel per `docs/testing.md`.
- `package.json` exists only for ESM + the test script; Chrome ignores it.
  No lint, formatter, or build — do not add tooling unasked.

## Architecture & Data Flow

Two independent pipelines, no cross-surface dedupe — each surface owns its
source:

- **DevTools** (`devtools/`): `onRequestFinished` (HAR) → JSON gate →
  dual-signature `getContent()` → record → panel-owned in-memory ring.
  Dies with DevTools; never depends on the worker for capture.
- **Page hook** (`content/` → `background/` → `sidepanel/`): MAIN-world
  fetch/XHR patch → `postMessage` → isolated bridge (validates shape +
  bounds) → worker relays to side-panel ports, then persists per-tab buffers
  in `chrome.storage.session`. Side panel re-validates before rendering.
- **Shared viewer** (`src/`): both surfaces call `mountInspector(root,
  opts)`; filtering only via `entryMatches` over `store.getAll()`.
- Caps/truncation policy lives in one table in `src/capture-record.js` —
  read it, don't restate it here.

## Key Directories & Files

- `manifest.json` — MV3 keys, entry points, permission set (min version,
  hosts, and permissions are authoritative here).
- `background/service-worker.js` — ephemeral coordinator: top-level
  listeners, port relay, serialized buffer writes. Holds no data in module
  globals (live ports + chains only).
- `content/hook-main.js` (MAIN world: page globals only, never `chrome.*`)
  + `content/bridge.js` (isolated: `chrome.runtime` only).
- `src/` — pure modules: `capture-record.js` (factories, caps, gates),
  `store.js` (ring + filter state), `inspector-ui.js`, `json-view.js`,
  `highlight.js`, `filters.js`, `settings.js` (storage key `settings`),
  `theme.css`.
- `test/` (`node:test` + `test/fake-dom.js` harness),
  `test-fixture.html` (manual traffic buttons), `docs/` (per-area design
  docs), `icons/` (PNGs referenced by the manifest).

## Code Conventions

- Async/await throughout, no `.then()` chains; `onMessage` async branches
  use IIFE + `return true`.
- Never break the page: every hook observation point is try/catch;
  originals always invoked with original arguments.
- Truncate-don't-drop oversized bodies; always flag and banner it.
  No static `content_scripts` — programmatic injection after opt-in only.
- `chrome.permissions.request()` must be the first synchronous statement in
  its listener (no `await` before it — the gesture dies).
- Render untrusted strings via `textContent` only:

```js
// ✅ Good — hostile bodies/keys cannot inject markup
el.textContent = value;
// 🚫 Never — no innerHTML on captured data, no eval/new Function,
//   no inline <script> or inline handlers in any HTML shell
```

## Testing & QA

- `test/*.test.js` cover records, rendering, and the store. Write
  failing-first regression tests for bug fixes; throwaway scripts for
  one-off checks.
- Test behavior, boundaries, and invariants — not wiring, defaults, or
  forwarding. Deterministic, isolated, full-suite-safe. Delete tests that
  pin incidental behavior instead of re-pinning them.
- Test-only DOM needs go in `test/fake-dom.js` — never add jsdom or other
  deps.
- Update the affected `docs/` file's claims in the same change as any
  behavior change.

## Runtime & Tooling

- Node (ESM) for tests; no installed dependencies. Ship source files
  directly — no bundler, framework, or build.
- Chrome floor is declared in `manifest.json`; code must keep the callback
  fallback wherever a newer Promise-form API is used.

## Boundaries

- ✅ Always: run `npm test` after behavior changes; migrate every caller on
  refactors; keep worker state in storage, not globals.
- ⚠️ Ask first: new permissions, new host access, new dependencies,
  publishing/store-listing docs.
- 🚫 Never: `eval`/`new Function`/inline scripts; static `content_scripts`;
  network calls, analytics, or sync backends; committing secrets.
