// public/app.js の描画パスを Node 上で実行するスモークテスト。
// ブラウザを開かずに「実データで描画が例外なく通るか」「何件どう表示されるか」を確認できる。
// 最小限の DOM スタブなので見た目は検証できない（クラッシュと件数・テキストの検証用）。
// app.js で新しい DOM API を使ったら、このスタブにも足すこと。
//
//   node test/smoke.mjs               → 起動中のサーバ (config.json の port) に繋いで確認
//   node test/smoke.mjs --base http://127.0.0.1:9999
//   node test/smoke.mjs --print       → 組み立てられた内容をテキストで出力
//   node test/smoke.mjs --save-repos  → リポジトリ保存 API も叩く（同じ内容を書き戻す）

import { loadConfig } from '../src/config.mjs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};

const config = await loadConfig();
const base = argValue('base') ?? `http://127.0.0.1:${config.port}`;

/* ---------------- 最小 DOM スタブ ---------------- */

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
  };
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

/** 溜めたリスナーを発火させる（クリックや変更の再現） */
function fire(node, type, event = {}) {
  for (const handler of node?.listeners?.[type] ?? []) handler({ preventDefault() {}, stopPropagation() {}, ...event });
}

/** 子孫からクラス名で集める */
function findAll(node, className, found = []) {
  for (const child of node?.children ?? []) {
    if (child.className === className) found.push(child);
    findAll(child, className, found);
  }
  return found;
}

function text(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.textContent;
  return (node.textContent ?? '') + (node.children ?? []).map(text).join('');
}

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
const results = [];
const expect = (label, ok, detail = '') => {
  results.push([label, Boolean(ok), detail]);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`);
};

process.on('unhandledRejection', (err) => failures.push(`unhandledRejection: ${err?.stack ?? err}`));
process.on('uncaughtException', (err) => failures.push(`uncaughtException: ${err?.stack ?? err}`));

console.log(`smoke: ${base} に接続します`);
await import('../public/app.js');

const list = byId('list');
const settled = () =>
  findAll(list, 'card').length > 0 || findAll(list, 'pr').length > 0 || list.children.some((n) => n.className === 'empty');
for (let i = 0; i < 300 && !settled(); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

/* --- 共通部分 --- */

expect('API を呼び出した', apiCalls > 0);
expect('KPI タイルが4枚ある', byId('kpis').children.length === 4, `${byId('kpis').children.length}枚`);
expect('取得時刻が入っている', byId('fetched').textContent.length > 0);
expect('ログインユーザが入っている', byId('viewer').textContent.startsWith('@'), byId('viewer').textContent);
expect('状態フィルタのチップが4つある', byId('bucketFilter').children.length === 4);
expect('表示切り替えが2つある', byId('viewToggle').children.length === 2);
expect('リポジトリ選択肢が2つ以上ある', byId('repoFilter').children.length >= 2);
expect('フッタに情報が入っている', byId('footerInfo').textContent.includes('表示'));
expect('エラーバナーが出ていない', byId('banner').hidden === true, byId('banner').textContent);

/* --- カンバン（既定: 列=状態 / 行=なし） --- */

expect('カンバンで描画されている', list.className === 'board-wrap', list.className);
const board = list.children[0];
expect('ピボットのグリッドがある', board?.className === 'pivot');
expect('行見出しなしになっている', board?.dataset.rowhead === 'false');
const colHeads = findAll(board, 'pivot-colhead');
expect('状態の列が4つある', colHeads.length === 4, colHeads.map((h) => text(h)).join(' | '));
const cards = findAll(board, 'card');
expect('カードが描画された', cards.length > 0, `${cards.length}枚`);
console.log(`\n[カンバン 列=状態/行=なし] 列: ${colHeads.map((h) => text(h)).join(' | ')}`);
console.log(`カード ${cards.length} 枚 / セル ${findAll(board, 'pivot-cell').length}`);

/* --- 軸の差し替え: 行=リポジトリ --- */

byId('rowDim').value = 'repo';
fire(byId('rowDim'), 'change');
await wait();
const board2 = byId('list').children[0];
const rowHeads = findAll(board2, 'pivot-rowhead');
expect('行=リポジトリで行見出しが出る', rowHeads.length > 0, `${rowHeads.length}行`);
expect('行見出しあり扱いになっている', board2?.dataset.rowhead === 'true');
expect('セル数が 列×行 になっている', findAll(board2, 'pivot-cell').length === rowHeads.length * findAll(board2, 'pivot-colhead').length);
expect('カード総数が変わっていない', findAll(board2, 'card').length === cards.length, `${findAll(board2, 'card').length}枚`);
console.log(`\n[カンバン 列=状態/行=リポジトリ] 行: ${rowHeads.map((h) => text(h)).join(' | ')}`);

/* --- 軸の入れ替え --- */

fire(byId('swapDims'), 'click');
await wait();
const board3 = byId('list').children[0];
expect('入れ替えで列がリポジトリになった', findAll(board3, 'pivot-colhead').length === rowHeads.length, `${findAll(board3, 'pivot-colhead').length}列`);
expect('入れ替えで行が状態になった', findAll(board3, 'pivot-rowhead').length === 4, `${findAll(board3, 'pivot-rowhead').length}行`);
expect('入れ替え後もカード総数は同じ', findAll(board3, 'card').length === cards.length);

/* --- 別の軸: 列=Actions / 行=なし --- */

byId('colDim').value = 'ci';
fire(byId('colDim'), 'change');
byId('rowDim').value = 'none';
fire(byId('rowDim'), 'change');
await wait();
const board4 = byId('list').children[0];
const ciCols = findAll(board4, 'pivot-colhead');
expect('列=Actions で列ができる', ciCols.length > 0, ciCols.map((h) => text(h)).join(' | '));
expect('列=Actions でもカード総数は同じ', findAll(board4, 'card').length === cards.length);
console.log(`\n[カンバン 列=Actions] ${ciCols.map((h) => text(h)).join(' | ')}`);

/* --- カードを開く --- */

const firstCard = findAll(byId('list'), 'card')[0];
fire(firstCard.children[0], 'click');
await wait();
const openedCard = findAll(byId('list'), 'card').find((card) => card.dataset.open === 'true');
expect('カードをクリックで詳細が開く', Boolean(openedCard && findAll(openedCard, 'pr-details').length));
if (args.includes('--print') && openedCard) console.log(`\n--- 開いたカード ---\n${text(openedCard)}`);

/* --- リストビュー --- */

fire(byId('viewToggle').children[1], 'click');
await wait();
expect('リストビューに切り替わる', byId('list').className === 'list', byId('list').className);
const rows = findAll(byId('list'), 'pr');
expect('リストの行が描画された', rows.length === cards.length, `${rows.length}行`);
expect('グループ見出しがある', findAll(byId('list'), 'group-heading').length > 0);
expect('カンバンの軸コントロールが隠れる', byId('pivotControls').hidden === true);
if (args.includes('--print')) {
  console.log('\n--- リスト先頭3行 ---');
  for (const row of rows.slice(0, 3)) console.log(text(row));
}

/* --- リポジトリ編集欄 --- */

const repoLines = byId('repoText').value.split('\n').filter(Boolean);
expect('リポジトリ編集欄が設定で埋まっている', repoLines.length === config.repos.length, `${repoLines.length}行`);
expect('リポジトリ数の見出しが出ている', byId('repoSummary').textContent.includes(String(config.repos.length)));

if (args.includes('--save-repos')) {
  fire(byId('repoSave'), 'click');
  // 保存 → 再取得（GitHub を叩き直すので数秒かかる）
  for (let i = 0; i < 600 && !byId('repoStatus').textContent.startsWith('保存しました'); i += 1) await wait();
  expect('リポジトリ保存 API が成功する', byId('repoStatus').textContent.startsWith('保存しました'), byId('repoStatus').textContent);
}

/* ---------------- 結果 ---------------- */

// app.js が仕掛けた自動更新タイマーを止める（活きたハンドルを残して exit すると Windows で落ちる）
byId('autoRefresh').checked = false;
fire(byId('autoRefresh'), 'change');

console.log('');
for (const [label, ok, detail] of results) {
  console.log(`${ok ? '  ok  ' : '  NG  '} ${label}${detail && !ok ? ` … ${detail}` : ''}`);
}

console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length})`);
  for (const failure of failures) console.error(` - ${failure}`);
} else {
  console.log('PASSED');
}

// process.exit() で強制終了すると、HTTP のキープアライブ接続が残っている場合に
// Windows の libuv が assertion で落ちる。終了コードだけ立てて自然終了させる。
process.exitCode = failures.length ? 1 : 0;
