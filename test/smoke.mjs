// public/app.js の描画パスを Node 上で実行するスモークテスト（**実データ版**）。
// 起動中のサーバに繋いで「実際の PR/Issue で描画が通るか」「何件どう表示されるか」を見る。
// DOM スタブは test/dom-stub.mjs（CI 用の test/ui.test.mjs と共有）。
// GitHub のトークンが要るので CI では回せない。CI 用は `npm test`。
//
//   node test/smoke.mjs               → 起動中のサーバ (config.json の port) に繋いで確認
//   node test/smoke.mjs --base http://127.0.0.1:9999
//   node test/smoke.mjs --print       → 組み立てられた内容をテキストで出力
//   node test/smoke.mjs --save-repos  → リポジトリ保存 API も叩く（同じ内容を書き戻す）

import { loadConfig } from '../src/config.mjs';
import { installDom, fire, findAll, text, settle } from './dom-stub.mjs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};

const config = await loadConfig();
const base = argValue('base') ?? `http://127.0.0.1:${config.port}`;

/* ---------------- DOM とサーバ接続のスタブ ---------------- */

// fetch は起動中のサーバへ向ける（相対パスのまま app.js が叩けるように）
const nativeFetch = globalThis.fetch;
const dom = installDom((input, init) => {
  const url = typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input;
  return nativeFetch(url, init);
});
const byId = dom.byId;

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
await settle(list);
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

// 画面と同じ payload を直接も取って、描画結果と突き合わせる（キャッシュ済みなので API は叩かれない）
const dashboard = await nativeFetch(`${base}/api/dashboard`).then((response) => response.json());

/* --- 共通部分 --- */

expect('API を呼び出した', dom.calls() > 0);
expect('KPI タイルが5枚ある', byId('kpis').children.length === 5, `${byId('kpis').children.length}枚`);
expect('取得時刻が入っている', byId('fetched').textContent.length > 0);
expect('ログインユーザが入っている', byId('viewer').textContent.startsWith('@'), byId('viewer').textContent);
expect('状態フィルタのチップが5つある', byId('bucketFilter').children.length === 5, `${byId('bucketFilter').children.length}個`);
expect('表示切り替えが2つある', byId('viewToggle').children.length === 2);
expect(
  'リポジトリの絞り込みチェックが「全部」+リポジトリ数ある',
  byId('repoFilter').children.length === config.repos.length + 1,
  `${byId('repoFilter').children.length}個`
);
expect('フッタに情報が入っている', byId('footerInfo').textContent.includes('表示'));
expect('エラーバナーが出ていない', byId('banner').hidden === true, byId('banner').textContent);

/* --- カンバン（既定: 列=状態 / 行=なし） --- */

expect('カンバンで描画されている', list.className === 'board-wrap', list.className);
const board = list.children[0];
expect('ピボットのグリッドがある', board?.className === 'pivot');
expect('行見出しなしになっている', board?.dataset.rowhead === 'false');
const colHeads = findAll(board, 'pivot-colhead');
expect('状態の列が5つある', colHeads.length === 5, colHeads.map((h) => text(h)).join(' | '));
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
expect('入れ替えで行が状態になった', findAll(board3, 'pivot-rowhead').length === 5, `${findAll(board3, 'pivot-rowhead').length}行`);
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

/* --- Issue連携（3パターン）とラベル軸 --- */

byId('colDim').value = 'link';
fire(byId('colDim'), 'change');
await wait();
const linkBoard = byId('list').children[0];
const linkCols = findAll(linkBoard, 'pivot-colhead').map((h) => text(h));
expect('Issue連携の列が3つある（0件でも出る）', linkCols.length === 3, linkCols.join(' | '));
expect('Issue連携でもカード総数は同じ', findAll(linkBoard, 'card').length === cards.length);
console.log(`\n[カンバン 列=Issue連携] ${linkCols.join(' | ')}`);

byId('colDim').value = 'label';
fire(byId('colDim'), 'change');
await wait();
const labelBoard = byId('list').children[0];
const labelCols = findAll(labelBoard, 'pivot-colhead');
expect('ラベル軸で列ができる', labelCols.length > 0, `${labelCols.length}列`);
// ラベルは1件が複数持てるので、カード総数は件数より多くなりうる（多値軸）
expect('ラベル軸のカード総数は件数以上', findAll(labelBoard, 'card').length >= cards.length);
console.log(`[カンバン 列=ラベル] ${labelCols.length}列 / カード ${findAll(labelBoard, 'card').length}枚`);

byId('colDim').value = 'bucket';
fire(byId('colDim'), 'change');
await wait();

/* --- 進捗グラフ --- */

expect('Issue連携グラフに凡例が3つある', findAll(byId('chartLink'), 'legend-key').length === 3, `${findAll(byId('chartLink'), 'legend-key').length}個`);
expect('Issue連携グラフの見出しが出ている', text(byId('chartLink')).includes('Issue連携の内訳'));
expect(
  'マイルストン進捗の行数が payload と一致する',
  findAll(byId('chartMilestone'), 'bar-row').length === dashboard.milestones.length,
  `${findAll(byId('chartMilestone'), 'bar-row').length}行 / payload ${dashboard.milestones.length}`
);
expect('ラベル別グラフに行がある', findAll(byId('chartLabel'), 'bar-row').length > 0);
expect('進捗パネルの見出しにマイルストン数が出る', byId('progressSummary').textContent.includes(String(dashboard.milestones.length)));
console.log(
  `\n[進捗] ${text(byId('chartLink')).replace(/\s+/g, ' ').slice(0, 120)}\n` +
    findAll(byId('chartMilestone'), 'bar-row').slice(0, 4).map((row) => `  ${text(row).replace(/\s+/g, ' ')}`).join('\n')
);

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

/* --- Issue（PRなし）の扱い --- */

// 番号リンクが「Issue #…」になっている行だけを数える（PR 側にも紐づく Issue のチップが出るため）
const issueRows = findAll(byId('list'), 'pr').filter((row) =>
  findAll(row, 'pr-number').some((node) => text(node).startsWith('Issue #'))
);
expect(
  'Issue の行が payload の件数と一致する',
  issueRows.length === dashboard.issues.length,
  `${issueRows.length}行 / payload ${dashboard.issues.length}`
);
byId('hideIssues').checked = true;
fire(byId('hideIssues'), 'change');
await wait();
expect(
  'Issue除外で PR だけになる',
  findAll(byId('list'), 'pr').length === dashboard.pullRequests.length,
  `${findAll(byId('list'), 'pr').length}行 / PR ${dashboard.pullRequests.length}`
);
byId('hideIssues').checked = false;
fire(byId('hideIssues'), 'change');
await wait();
expect('Issue除外を戻すと元の件数になる', findAll(byId('list'), 'pr').length === rows.length);

/* --- リポジトリの絞り込み（チェックボックス） --- */

// 件数が 1 以上のリポジトリを外すと、その分だけ減るはず
const repoChecks = byId('repoFilter').children;
const withPrs = repoChecks.findIndex((label, index) => index > 0 && Number(text(label).match(/\((\d+)\)/)?.[1] ?? 0) > 0);
if (withPrs > 0) {
  const dropped = Number(text(repoChecks[withPrs]).match(/\((\d+)\)/)[1]);
  fire(repoChecks[withPrs].children[0], 'change');
  await wait();
  expect(
    'リポジトリのチェックを外すとその分減る',
    findAll(byId('list'), 'pr').length === rows.length - dropped,
    `${findAll(byId('list'), 'pr').length}行 (期待 ${rows.length - dropped})`
  );
  fire(byId('repoFilter').children[0].children[0], 'change'); // 「全部」で戻す
  await wait();
  expect('全リポジトリに戻せる', findAll(byId('list'), 'pr').length === rows.length, `${findAll(byId('list'), 'pr').length}行`);
} else {
  console.log('(PR のあるリポジトリが無いので絞り込みの検証はスキップ)');
}

/* --- リポジトリ編集欄 --- */

const candidateCount = config.repos.length + config.disabledRepos.length;
const repoLines = byId('repoText').value.split('\n').filter(Boolean);
expect('リポジトリ編集欄が設定で埋まっている', repoLines.length === candidateCount, `${repoLines.length}行`);
expect('リポジトリ数の見出しが出ている', byId('repoSummary').textContent.includes(String(config.repos.length)));
expect(
  '監視 ON/OFF のチェックが候補ぶんある',
  byId('repoToggles').children.length === candidateCount,
  `${byId('repoToggles').children.length}個`
);

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
