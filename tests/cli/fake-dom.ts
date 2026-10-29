// INPUT: Calls a page script makes on document and elements (createElement, append, setAttribute, listeners, a few properties).
// OUTPUT: fakeDocument (with pre-made elements by id), FakeElement/FakeText and the elements/texts walkers for assertions.
// POS: Test-only minimal DOM double for the ms ui page script; it has no HTML parser, so markup in text can never become elements.
export class FakeText {
  readonly data: string;
  constructor(data: string) { this.data = data; }
  get textContent(): string { return this.data; }
}

type Listener = (event: { type: string; target: FakeElement }) => void;

export class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  children: Array<FakeElement | FakeText> = [];
  readonly listeners = new Map<string, Listener[]>();
  open = false;
  checked = false;
  hidden = false;

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  append(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const node of nodes) this.children.push(typeof node === 'string' ? new FakeText(node) : node);
  }
  replaceChildren(...nodes: Array<FakeElement | FakeText | string>): void { this.children = []; this.append(...nodes); }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  fire(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this }); }
  get textContent(): string { return this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.children = [new FakeText(String(value))]; }
}

export function fakeDocument(ids: readonly string[]) {
  const byId = new Map(ids.map(id => [id, new FakeElement('div')]));
  return {
    byId,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
    getElementById: (id: string) => byId.get(id) ?? null,
  };
}

export function elements(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(child => (child instanceof FakeElement ? elements(child) : []))];
}

export function texts(root: FakeElement): string[] {
  return root.children.flatMap(child => (child instanceof FakeElement ? texts(child) : [child.data]));
}
