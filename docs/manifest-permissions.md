# Manifest & Permissions

`manifest.json` (MV3, `minimum_chrome_version: "116"`). Every key below is load-bearing.

## Key tour

| Key | Value | Why |
|-----|-------|-----|
| `manifest_version` | `3` | MV3 only; no V2 APIs anywhere in the tree |
| `name` / `version` / `description` | `JSON Network Inspector` / `0.1.0` | store-facing identity |
| `minimum_chrome_version` | `"116"` | side-panel APIs stabilized in this range (`sidePanel.open` needs 116; base sidePanel needs 114+) |
| `icons` + `action.default_icon` | `icons/icon-{16,48,128}.png` | real PNGs at exact pixel sizes, generated before being referenced |
| `action` | `{ default_title }`, **no `default_popup`** | empty action keeps the icon click available so `setPanelBehavior({ openPanelOnActionClick: true })` can open the side panel |
| `devtools_page` | `devtools/devtools.html` | shell that registers the JSON panel |
| `side_panel.default_path` | `sidepanel/sidepanel.html` | declaration alone is not openable — the worker's `setPanelBehavior` call is the trigger |
| `background.service_worker` | `background/service-worker.js` | ephemeral coordinator (no DOM, no persistent globals) |
| `permissions` | `sidePanel`, `storage`, `scripting`, `tabs` | see rationale table |
| `optional_host_permissions` | `http://*/*`, `https://*/*` | requested at runtime on the Enable gesture; **no static `host_permissions`** |
| (absent) | no `content_scripts`, no `default_popup`, no `key` | programmatic injection only; no popup competing with the icon click; no auth/identity |

## Permission rationale (review-surface notes)

| Permission | Used by | Justification |
|------------|---------|---------------|
| `sidePanel` | worker (`setPanelBehavior`), sidepanel page | required to host and open the side-panel UI at all |
| `storage` | worker (`session` buffers/flags), both surfaces (`local` settings) | buffers + settings; session area is memory-only |
| `scripting` | worker (`executeScript` hook + bridge + enable flag) | programmatic injection after the user enables capture |
| `tabs` | side panel (`tabs.get`, `tabs.query`, `onActivated`, `onUpdated`) | reads `tab.url`/`tab.title` for labels and tab-follow; without it they silently return `undefined`. `activeTab` is not used because it does not fire from side-panel button clicks |
| optional hosts `http/https */*` | page-hook capture | granted only when the user clicks Enable; keeps install-time warnings minimal |

## Deliberate non-goals

- **No static host permissions or content scripts.** Injection happens only via
  `chrome.scripting.executeScript` after explicit enablement, so review scope
  and ambient exposure stay narrow.
- **No `activeTab`.** It grants on direct gestures (icon click, context menu),
  not on button clicks inside a side panel — `tabs` + optional hosts is the
  correct combination here.
- **No backend/auth.** Local DevTools utility: no accounts, no sync
  requirement; Clerk-style identity would add permissions and bundle cost for
  no benefit.
- **No store listing file.** `CHROMEWEBSTORE.md` is not created until
  publishing is requested.

## Sources (external claims)

- Side Panel API: availability Chrome 114+, `setPanelBehavior({ openPanelOnActionClick })`,
  `sidePanel.open()` Chrome 116+ —
  <https://developer.chrome.com/docs/extensions/reference/api/sidePanel>
- `chrome.action` requires an `"action"` key; no `onClicked` when `default_popup` is set —
  <https://developer.chrome.com/docs/extensions/develop/ui/implement-action>
- `chrome.devtools.network`: HAR entries, body content excluded from HAR, `getContent()` —
  <https://developer.chrome.com/docs/extensions/reference/api/devtools/network>
- `chrome.storage` areas: session is memory-only (10 MB), cleared on
  disable/reload/update/restart —
  <https://developer.chrome.com/docs/extensions/reference/api/storage>
- `chrome.permissions.request` must run inside a user gesture; optional hosts
  requested at runtime — Context7 `/websites/developer_chrome_extensions_reference_api`
  (`chrome.permissions`).
- `world: "MAIN"` vs `"ISOLATED"` execution worlds; `allFrames` injection —
  Context7 `/websites/developer_chrome_extensions_reference_api` (`chrome.scripting`).

---
*Verified against: `manifest.json`, `background/service-worker.js`
(`setPanelBehavior`, permission request, `executeScript` calls),
`sidepanel/sidepanel.js` (`tabs.*` usage). Icon files verified at
`icons/icon-{16,48,128}.png`.*
