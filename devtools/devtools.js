// DevTools page: runs only while DevTools is open. Its only job is to
// register the JSON panel. The panel path is relative to the extension root
// (NOT to this file) — "devtools/panel/panel.html".

chrome.devtools.panels.create('JSON', '', 'devtools/panel/panel.html', (panel) => {
  // Reserved for future onShown/onHidden hooks (e.g. pause when hidden).
});
