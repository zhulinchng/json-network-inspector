// Minimal JSON syntax highlighter that never uses innerHTML on untrusted
// input. Tokenizes the source text and appends <span> nodes with textContent,
// so response bodies cannot inject markup.

const TOKEN_RE =
  /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export const HIGHLIGHT_CLASSES = Object.freeze({
  key: 'tok-key',
  string: 'tok-str',
  number: 'tok-num',
  literal: 'tok-lit',
  punct: 'tok-punct',
});

/**
 * Append highlighted JSON source text into `container` (a <code>/<pre>).
 * Falls back to plain text when the source is not valid JSON.
 */
export function appendHighlighted(container, sourceText) {
  container.textContent = '';
  const doc = container.ownerDocument;
  const frag = doc.createDocumentFragment();
  let lastIndex = 0;
  let matched = false;

  TOKEN_RE.lastIndex = 0;
  for (;;) {
    const m = TOKEN_RE.exec(sourceText);
    if (!m) break;
    matched = true;
    if (m.index > lastIndex) {
      const plain = doc.createElement('span');
      plain.className = HIGHLIGHT_CLASSES.punct;
      plain.textContent = sourceText.slice(lastIndex, m.index);
      frag.appendChild(plain);
    }
    const span = doc.createElement('span');
    if (m[1] !== undefined) {
      span.className = m[2] ? HIGHLIGHT_CLASSES.key : HIGHLIGHT_CLASSES.string;
    } else if (m[3] !== undefined) {
      span.className = HIGHLIGHT_CLASSES.literal;
    } else {
      span.className = HIGHLIGHT_CLASSES.number;
    }
    span.textContent = m[0];
    frag.appendChild(span);
    lastIndex = m.index + m[0].length;
  }

  if (!matched) {
    container.textContent = sourceText;
    return;
  }
  if (lastIndex < sourceText.length) {
    const tail = doc.createElement('span');
    tail.className = HIGHLIGHT_CLASSES.punct;
    tail.textContent = sourceText.slice(lastIndex);
    frag.appendChild(tail);
  }
  container.appendChild(frag);
}
