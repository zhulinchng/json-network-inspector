# Testing & Verification

## Automated suite: 30 tests, stdlib only

`npm test` → `node --test test/`. No test dependencies, no build.
`package.json` (`type: module`, private) exists only so Node treats sources
as ESM; Chrome ignores it.

| File | Tests | Covers |
|------|-------|--------|
| `test/capture-record.test.js` | 13 | `truncateBody`/`truncateReqBody` caps + flags, `decodeBody` text/base64/garbage, `isJsonEntry` mime/extension/accept, `headersToObject` folding, `parseSafe`, `makeDevtoolsRecord` HAR mapping + payload truncation + unparseable flag, `makePageHookRecord` payload carry-through, `isValidHookPayload` shape/bounds, formatter boundaries |
| `test/render.test.js` | 8 | highlighter escaping + token classes + non-JSON fallback, tree structure + hostile-key escaping, node-budget “Show more”, depth-cap collapse, copy-path pointer reporting, `entryMatches` method/status/URL + body-prefix limit |
| `test/store.test.js` | 9 | add/getById/count/clear, ring eviction, `setMaxEntries` clamp + shed + garbage rejection, pause/missed/resume, navigation vs preserve-log, filter defaults/update/match, `getAll` copy semantics, subscribe/unsubscribe, throwing-listener isolation |
| `test/fake-dom.js` | — | minimal DOM harness (elements, textContent, events) for renderer tests |

Suite history: the tests caught a real total-capture outage (`idCounter`
declaration lost — `makeId` threw on every record) before it shipped.

## Fixture page (`test-fixture.html`)

Manual verification page firing real traffic. Seven buttons:

1. `fireFetch` — GET JSON via fetch (baseline capture)
2. `fireXhr` — GET JSON via XHR
3. `fireHtml` — HTML fetch (extension must ignore)
4. `fireError` — 404-ish fetch (should appear with 4xx badge)
5. `firePost` — POST with JSON init body (Request tab)
6. `firePostReq` — POST via `Request` object (clone-read path)
7. `fireXhrPost` — XHR POST with JSON body (`send()` arg path)

Results append to an `aria-live` log without breaking the page.

## Live browser verification (performed)

- Headless `--load-extension`: exit 0, no manifest/worker errors.
- Hook exercised in real Chromium against a local server: init-body POST,
  Request-object POST, and XHR POST bodies all captured; a 3.2 MB JSON body
  forwarded intact (record layer truncates flagged at 2 MB); HTML ignored;
  page traffic unbroken.
- Post-fix retest confirmed the Request-object path after the pre-dispatch
  clone-read fix.

## Manual checklist (maintainer)

- [ ] Load unpacked → DevTools → JSON tab → reload fixture: two JSON
  requests listed with method badge, status, timing; Pretty tree
  expands/collapses; Headers/Raw/Request/Timing tabs render; search narrows;
  copy-path and download produce correct output.
- [ ] Icon click opens side panel → Enable capture → accept hosts → fire
  fetch: `page-hook` badge entries + incrementing action badge; pause stops
  growth; clear empties; theme toggle survives close/reopen.
- [ ] Stop the worker (`chrome://serviceworker-internals`): capture
  continues, settings persist, side panel reconnects (~1 s) and catches up.
- [ ] 5 MB+ JSON response: entry flagged truncated, download works.
- [ ] Extension consoles show zero CSP/`eval`/inline-script errors.

---
*Verified against: `package.json`, `test/` (13 + 8 + 9 = 30 cases),
`test-fixture.html` (7 button ids), and the recorded verification runs
(headless exit 0; live POST/3.2 MB/HTML/page-intact results).*
