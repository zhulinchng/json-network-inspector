# JSON Network Inspector — Documentation

A Manifest V3 Chrome extension that inspects JSON exchanged between pages and
their servers. Two capture surfaces share one viewer:

- **DevTools “JSON” tab** — full-fidelity bodies, headers, and timing via
  `chrome.devtools.network`. Requires DevTools open on the inspected page.
- **Side panel (“page hook”)** — always-on capture via an opt-in
  fetch/XHR patch. Works with DevTools closed.

Vanilla JS, zero dependencies, no build step. All data stays on-device; no
accounts, no backend, no network calls made by the extension itself.

## Reading map

| File | What it covers |
|------|----------------|
| `architecture.md` | Components, the two capture pipelines, storage split, message protocol |
| `manifest-permissions.md` | Every manifest key and why it exists; review-surface rationale |
| `devtools-panel.md` | DevTools capture path: HAR entry → record → ring buffer |
| `page-hook.md` | MAIN-world fetch/XHR patch, bridge validation, enable/disable flow |
| `service-worker.md` | Relay, per-tab buffers, badge, lifecycle, navigation re-inject |
| `data-model.md` | Record shape, size caps, store ring, settings |
| `viewer-ui.md` | Shared inspector: list, detail tabs, tree view, toolbar, themes |
| `testing.md` | Automated suite (30 tests), fixture page, manual checklist |
| `security-privacy.md` | Local-only posture, CSP compliance, validation layers, spoofing analysis |

## Repository map

```text
manifest.json            MV3 manifest (action, devtools_page, side_panel, …)
background/service-worker.js   ephemeral coordinator: relay + buffers + badge
content/hook-main.js     MAIN-world fetch/XHR patch (page context, no chrome.*)
content/bridge.js        isolated-world relay: postMessage → runtime.sendMessage
devtools/devtools.html|js      registers the JSON panel (extension-root path)
devtools/panel/          panel shell + capture logic (own in-memory buffer)
sidepanel/               panel shell + capture bar, tab follow, port relay
src/                     shared model/store/viewer (imported by both surfaces)
test/                    node:test suite (stdlib only) + fake-dom.js harness
test-fixture.html        manual verification page (7 traffic buttons)
package.json             ESM marker + `npm test` only; Chrome ignores it
```

## Quickstart (maintainer)

```sh
npm test                                   # 30/30 via node --test test/
node --check <file>                        # syntax check, no build exists
# Load unpacked: chrome://extensions → Developer mode → Load unpacked → repo root
```

## Conventions used in these docs

- `source:` / `badge:` labels (`DevTools`, `page hook`) are literal UI strings.
- Byte caps are named constants; the tables in `data-model.md` give exact values.
- “Verified against” footers name the files (and tests) each claim was checked against.
- External Chrome API claims cite the reference docs (see `manifest-permissions.md`
  sources); behavior claims cite code symbols.

---
*Verified against: `manifest.json`, `package.json`, repo tree at commit `4436e8c`.*
