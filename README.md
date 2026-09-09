# JSON Network Inspector

A Manifest V3 Chrome extension that inspects JSON exchanged between pages
and their servers. Vanilla JS, zero dependencies, no build step. All data
stays on-device — no accounts, no backend, and the extension makes no
network calls of its own.

Two capture surfaces share one viewer:

- **DevTools “JSON” tab** — full-fidelity bodies, headers, and timing via
  `chrome.devtools.network`. Requires DevTools open on the inspected page.
- **Side panel (“page hook”)** — always-on capture via an opt-in
  fetch/XHR patch. Works with DevTools closed.

## Use it

1. Open `chrome://extensions`, enable Developer mode, **Load unpacked** →
   select the repo root.
2. Open DevTools on any page → **JSON** tab, then reload the page.
3. Or click the extension icon to open the side panel → **Enable capture
   on this tab**, accept host access, and trigger page traffic.

`test-fixture.html` (repo root) fires sample fetch/XHR traffic for trying
both surfaces.

## Develop

```sh
npm test               # node:test suite, stdlib only — keep green
node --check <file>    # syntax check; there is no build step
```

`package.json` exists only for ESM + the test script; Chrome ignores it.
Agent-oriented working rules live in `AGENTS.md`.

## Docs

| File | What it covers |
|------|----------------|
| `architecture.md` | Components, the two capture pipelines, storage split, message protocol |
| `manifest-permissions.md` | Every manifest key and why it exists; review-surface rationale |
| `devtools-panel.md` | DevTools capture path: HAR entry → record → ring buffer |
| `page-hook.md` | MAIN-world fetch/XHR patch, bridge validation, enable/disable flow |
| `service-worker.md` | Relay, per-tab buffers, badge, lifecycle, navigation re-inject |
| `data-model.md` | Record shape, size caps, store ring, settings |
| `viewer-ui.md` | Shared inspector: list, detail tabs, tree view, toolbar, themes |
| `testing.md` | Automated suite, fixture page, manual checklist |
| `security-privacy.md` | Local-only posture, CSP compliance, validation layers, spoofing analysis |

Conventions in these docs: `source:`/`badge:` labels are literal UI strings;
byte caps are named constants (exact values in `data-model.md`); “Verified
against” footers name the files each claim was checked against.
