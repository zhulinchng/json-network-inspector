// Minimal DOM stand-in for renderer unit tests. Implements just enough
// (createElement, textContent semantics, appendChild, listeners, attributes)
// to exercise highlight.js / json-view.js escaping and structure logic.

export class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this._text = null;
    this.className = '';
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.title = '';
    this.type = '';
    this.value = '';
    this.disabled = false;
    this.ownerDocument = null;
  }

  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }

  get textContent() {
    return this._text ?? this.children.map((c) => c.textContent).join('');
  }

  appendChild(c) {
    this._text = null;
    this.children.push(c);
    return c;
  }

  append(...cs) {
    cs.forEach((c) => this.appendChild(c));
    return cs[cs.length - 1];
  }

  addEventListener(t, f) {
    (this.listeners[t] ??= []).push(f);
  }

  setAttribute(k, v) {
    this.attrs[k] = v;
  }

  getAttribute(k) {
    return this.attrs[k];
  }

  querySelector() {
    return null;
  }

  get classList() {
    const self = this;
    return {
      add(c) {
        self.className += ` ${c}`;
      },
      remove() {},
      toggle() {},
    };
  }

  click() {
    for (const f of this.listeners.click || []) f({ stopPropagation() {} });
  }
}

export function makeDocument() {
  const doc = {
    activeElement: null,
    createElement: (t) => {
      const n = new FakeEl(t);
      n.ownerDocument = doc;
      return n;
    },
    createDocumentFragment: () => {
      const n = new FakeEl('frag');
      n.ownerDocument = doc;
      return n;
    },
  };
  return doc;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Serialize a fake tree to HTML-ish text for assertions. */
export function serialize(n) {
  if (n.tag === 'frag') return n.children.map(serialize).join('');
  const inner = n._text !== null ? esc(n._text) : n.children.map(serialize).join('');
  return `<${n.tag} class="${n.className}">${inner}</${n.tag}>`;
}
