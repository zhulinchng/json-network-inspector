# Architecture

Two independent capture pipelines feed one shared viewer. The pipelines never
talk to each other and there is no cross-surface dedupe: the DevTools panel
shows `source: "devtools"` entries, the side panel shows `source: "page-hook"`
entries, each with a source badge in the header.

## Component map

```mermaid
flowchart TB
    subgraph ext["Extension"]
        dtp["DevTools panel<br/>devtools/panel/panel.js"]
        sp["Side panel<br/>sidepanel/sidepanel.js"]
        sw["Service worker<br/>background/service-worker.js"]
        ui["Shared viewer<br/>src/inspector-ui.js + json-view.js<br/>highlight.js + filters.js + theme.css"]
        model["Shared model<br/>src/capture-record.js<br/>src/store.js + settings.js"]
    end
    subgraph page["Inspected page"]
        hook["hook-main.js (MAIN world)<br/>fetch/XHR patch"]
        bridge["bridge.js (isolated world)<br/>postMessage relay"]
    end
    hook -->|"window.postMessage"| bridge
    bridge -->|"runtime.sendMessage"| sw
    sw -->|"Port 'sidepanel'"| sp
    dtp --> ui
    sp --> ui
    dtp --> model
    sp --> model
```

## Pipeline A — DevTools (full fidelity)

```mermaid
sequenceDiagram
    participant Net as Page network
    participant CDP as chrome.devtools.network
    participant Panel as panel.js
    participant Store as in-memory ring
    participant UI as inspector UI
    Net->>CDP: request finishes (HAR entry)
    CDP->>Panel: onRequestFinished(entry)
    Panel->>Panel: isJsonEntry? getContent() → decodeBody()
    Panel->>Store: add(makeDevtoolsRecord(...))
    Store->>UI: subscribe → render list + detail
```

- Runs only while DevTools is open; the panel owns its buffer and never
  touches the worker for capture.
- Request bodies come from HAR `postData`; response bodies from `getContent()`.
- Covers everything DevTools sees: fetch, XHR, WebSocket, SSE, document loads.

## Pipeline B — page hook (always on)

```mermaid
sequenceDiagram
    participant Page as Page JS (fetch/XHR)
    participant Hook as hook-main.js (MAIN)
    participant Bridge as bridge.js (isolated)
    participant SW as service worker
    participant SP as side panel
    Page->>Hook: patched fetch/XHR response
    Hook->>Hook: mime/.json gate, capped read
    Hook->>Bridge: postMessage(JSON_CAPTURE)
    Bridge->>Bridge: marker + shape validation
    Bridge->>SW: runtime.sendMessage(entry)
    SW->>SW: relay to port + serialized persist
    SW->>SP: Port postMessage → store.add()
```

- Opt-in per tab: the side panel's **Enable capture** button → worker requests
  host permission on the click gesture → injects hook + bridge into all frames.
- The worker keeps per-tab buffers in `chrome.storage.session` so entries
  survive worker restarts and side-panel reconnects.
- Covers fetch/XHR only — never WebSocket, SSE, or navigation loads. The side
  panel says so in a permanent hint bar.

## Storage split

| Data | Where | Lifetime |
|------|-------|----------|
| User settings (`settings` key) | `chrome.storage.local` | persists across restarts |
| Per-tab buffers (`buf:<tabId>`), enable flags (`capture:<tabId>`) | `chrome.storage.session` | memory-only; cleared on disable/reload/update/browser restart |
| Panel list (DevTools surface) | in-memory `createStore` | dies with DevTools |
| Side-panel list | in-memory `createStore` | rebuilt from worker buffer on tab switch/reconnect |

The worker holds **no data** in module globals — only live `Port` objects and
in-flight promise chains (coordination, re-established from storage per event).

## Message protocol (worker)

| Type | Direction | Purpose |
|------|-----------|---------|
| `JSON_CAPTURE` | bridge → worker → panel port | one captured entry |
| `REQUEST_CAPTURE_ENABLE` | side panel → worker | permission request + inject; replies `{ granted, enabled, partial? }` |
| `REQUEST_CAPTURE_DISABLE` | side panel → worker | set `__jsonInspectorEnabled=false`, clear flag |
| `GET_CAPTURE_STATE` | side panel → worker | replies `{ enabled, hasAccess }` |
| `GET_BUFFER` | side panel → worker | replies `{ entries }` for a tab |
| `CLEAR_BUFFER` | side panel → worker | wipe a tab's buffer + badge |
| `PORT_INIT` / `PORT_SWITCH_TAB` | side panel → worker (port) | bind the port to a tab id |

---
*Verified against: `background/service-worker.js`, `content/hook-main.js`,
`content/bridge.js`, `devtools/panel/panel.js`, `sidepanel/sidepanel.js`,
`src/store.js`, `src/settings.js`.*
