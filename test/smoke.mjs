// public/app.js の描画パスを Node 上で実行するスモークテスト。
// ブラウザを開かずに「実データで描画が例外なく通るか」「何件どう表示されるか」を確認できる。
// 最小限の DOM スタブなので見た目は検証できない（クラッシュと件数・テキストの検証用）。
//
//   node test/smoke.mjs            → 起動中のサーバ (config.json の port) に繋いで確認
//   node test/smoke.mjs --base http://127.0.0.1:9999
//   node test/smoke.mjs --print    → 組み立てられた DOM をテキストで出力

import { loadConfig } from '../src/config.mjs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};

const config = await loadConfig();
const base = argValue('base') ?? `http://127.0.0.1:${config.port}`;

/* ---------------- 最小 DOM スタブ ---------------- */

let idCounter = 0;

function createElement(tag) {
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
    setAttribute(name, value) {
      node.attributes[name] = value;
      if (name === 'value') node.value = value;
    },
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    append(...items) {
      for (const item of items) node.children.push(item);
    },
    replaceChildren(...items) {
      node.children = items.filter((item) => item !== null && item !== undefined);
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
    get firstChild() {
      return node.children[0] ?? null;
    },
  };
  node.uid = ++idCounter;
  return node;
}

const elements = new Map();
function byId(id) {
  if (!elements.has(id)) {
    const node = createElement('div');
    node.id = id;
    // index.html で checked が付いている要素の初期値を再現する
    if (id === 'autoRefresh') node.checked = true;
    elements.set(id, node);
  }
  return elements.get(id);
}

globalThis.document = {
  documentElement: createElement('html'),
  visibilityState: 'visible',
  createElement,
  createTextNode: (text) => ({ tag: '#text', textContent: String(text), children: [] }),
  getElementById: byId,
  addEventListener() {},
};

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

/* ---------------- fetch を対象サーバへ向ける ---------------- */

const nativeFetch = globalThis.fetch;
let apiCalls = 0;
globalThis.fetch = (input, init) => {
  apiCalls += 1;
  const url = typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input;
  return nativeFetch(url, init);
};

/* ---------------- 実行 ---------------- */

const failures = [];
process.on('unhandledRejection', (err) => failures.push(`unhandledRejection: ${err?.stack ?? err}`));
process.on('uncaughtException', (err) => failures.push(`uncaughtException: ${err?.stack ?? err}`));

console.log(`smoke: ${base} に接続します`);
await import('../public/app.js');

// app.js 末尾の load() の完了を待つ。
// 初期表示のスケルトンでも children は増えるので、本描画（.pr / .empty）かエラー表示を待つ。
const settled = () =>
  byId('list').children.some((node) => node.className === 'pr' || node.className === 'empty') ||
  (byId('banner').hidden === false && byId('banner').textContent.length > 0);
for (let i = 0; i < 300 && !settled(); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function text(node, depth = 0) {
  if (!node) return '';
  if (node.tag === '#text') return node.textContent;
  const own = node.textContent ?? '';
  const inner = node.children.map((child) => text(child, depth + 1)).join('');
  return own + inner;
}

const list = byId('list');
const kpis = byId('kpis');
const banner = byId('banner');

const rows = list.children.filter((node) => node.className === 'pr');
const headings = list.children.filter((node) => node.className === 'group-heading');

const checks = [
  ['API を呼び出した', apiCalls > 0],
  ['スケルトンが実データに置き換わった', !list.children.some((n) => n.className === 'skeleton')],
  ['PR 行が描画された', rows.length > 0],
  ['グループ見出しが描画された', headings.length > 0],
  ['KPI タイルが4枚ある', kpis.children.length === 4],
  ['取得時刻が入っている', byId('fetched').textContent.length > 0],
  ['ログインユーザが入っている', byId('viewer').textContent.startsWith('@')],
  ['状態フィルタのチップが4つある', byId('bucketFilter').children.length === 4],
  ['リポジトリ選択肢が2つ以上ある', byId('repoFilter').children.length >= 2],
  ['フッタに情報が入っている', byId('footerInfo').textContent.includes('表示')],
  ['エラーバナーが出ていない', banner.hidden === true || banner.textContent === ''],
];

console.log('');
for (const [label, ok] of checks) {
  console.log(`${ok ? '  ok  ' : '  NG  '} ${label}`);
  if (!ok) failures.push(label);
}

console.log('');
console.log(`PR行: ${rows.length} 件 / 見出し: ${headings.map((h) => h.textContent).join(', ')}`);
console.log(`KPI: ${kpis.children.map((tile) => text(tile)).join(' | ')}`);
if (!banner.hidden && banner.textContent) console.log(`banner: ${banner.textContent}`);

// 展開（詳細描画）も一度通す
const firstRow = rows[0]?.children[0];
if (firstRow) {
  for (const handler of firstRow.listeners.click ?? []) handler({ stopPropagation() {} });
  const opened = byId('list').children.filter((n) => n.className === 'pr').find((n) => n.dataset.open === 'true');
  const hasDetails = Boolean(opened?.children.some((c) => c.className === 'pr-details'));
  console.log(`${hasDetails ? '  ok  ' : '  NG  '} 行クリックで詳細が描画された`);
  if (!hasDetails) failures.push('詳細の描画');
  if (args.includes('--print') && opened) console.log(`\n--- 1件目 ---\n${text(opened)}`);
} else {
  failures.push('PR行が1件も無いため詳細を検証できなかった');
}

if (args.includes('--print')) {
  console.log('\n--- 一覧（先頭5件） ---');
  for (const row of rows.slice(0, 5)) console.log(text(row));
}

console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length})`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('PASSED');
process.exit(0);
