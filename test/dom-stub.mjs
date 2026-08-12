// public/app.js を Node 上で動かすための最小 DOM スタブ。
// test/smoke.mjs（起動中のサーバに繋ぐ手動確認）と test/ui.test.mjs（固定データで CI）が共有する。
//
// **app.js で新しい DOM API を使ったら、ここに足すこと。**
// 見た目は検証できない。クラッシュ・件数・テキストの検証用。

export function createElement(tag) {
  const node = {
    tag,
    id: '',
    className: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    title: '',
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    classList: {
      add(name) {
        node.className = [...new Set([...node.className.split(' ').filter(Boolean), name])].join(' ');
      },
      remove(name) {
        node.className = node.className.split(' ').filter((c) => c && c !== name).join(' ');
      },
      contains(name) {
        return node.className.split(' ').includes(name);
      },
    },
    // レイアウトは持たないので 0 を返す（app.js 側は数値が取れないときは CSS 任せにする）
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    style: {
      setProperty(name, value) {
        node.attributes[`style:${name}`] = value;
      },
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
      if (name === 'value') node.value = value;
      if (name === 'class') node.className = value;
    },
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    append(...items) {
      for (const item of items) node.children.push(item);
    },
    replaceChildren(...items) {
      // 本物の DOM は null を文字列 "null" として挿入する。それを再現しないと
      // 「画面に null と出る」バグをテストで拾えない（app.js 側は setChildren() を使う）
      node.children = items.map((item) =>
        item === null || item === undefined ? { tag: '#text', textContent: String(item), children: [] } : item
      );
    },
    addEventListener(type, handler) {
      (node.listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    matches() {
      return false;
    },
    querySelector() {
      return null;
    },
  };
  return node;
}

/**
 * document / localStorage / fetch のスタブを globalThis に入れる。
 * @param {(input: string, init?: object) => Promise<Response>} fetchImpl
 * @returns {{ byId: (id: string) => object, elements: Map<string, object>, calls: () => number }}
 */
export function installDom(fetchImpl) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) {
      const node = createElement('div');
      node.id = id;
      // index.html で checked が付いている要素の初期値を再現する
      if (id === 'autoRefresh') node.checked = true;
      elements.set(id, node);
    }
    return elements.get(id);
  };

  globalThis.document = {
    documentElement: createElement('html'),
    visibilityState: 'visible',
    createElement,
    // Material Symbols のアイコンは SVG なので createElementNS を通る
    createElementNS: (namespace, tag) => createElement(tag),
    getElementById: byId,
    addEventListener() {},
  };

  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };

  let calls = 0;
  globalThis.fetch = (input, init) => {
    calls += 1;
    return fetchImpl(input, init);
  };

  return { byId, elements, calls: () => calls };
}

/** 溜めたリスナーを発火させる（クリックや変更の再現） */
export function fire(node, type, event = {}) {
  for (const handler of node?.listeners?.[type] ?? []) handler({ preventDefault() {}, stopPropagation() {}, ...event });
}

/** 子孫からクラス名で集める */
export function findAll(node, className, found = []) {
  for (const child of node?.children ?? []) {
    if (child.className === className) found.push(child);
    findAll(child, className, found);
  }
  return found;
}

/** 子孫のテキストを連結する */
export function text(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.textContent;
  return (node.textContent ?? '') + (node.children ?? []).map(text).join('');
}

/** 描画が落ち着くまで待つ（カード/行/空表示のどれかが出るまで） */
export async function settle(list, { tries = 300, intervalMs = 100 } = {}) {
  const done = () =>
    findAll(list, 'card').length > 0 || findAll(list, 'pr').length > 0 || list.children.some((n) => n.className === 'empty');
  for (let i = 0; i < tries && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return done();
}
