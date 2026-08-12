// 描画（public/app.js）のテスト。固定データ + DOM スタブなので、サーバもトークンも要らない。
//   node --test test/
// 実データで確かめたいときは `npm run smoke`（起動中のサーバに繋ぐ）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../src/summarize.mjs';
import { repoResult, CONFIG } from './fixture.mjs';
import { installDom, fire, findAll, text, settle } from './dom-stub.mjs';

const dashboard = buildDashboard([repoResult()], CONFIG);
const payload = {
  fetchedAt: '2026-08-12T12:00:00Z',
  cached: false,
  ageSeconds: 0,
  settings: {
    refreshSeconds: 0, // 自動更新のタイマーを動かさない（テストが終わらなくなるので）
    cacheSeconds: CONFIG.cacheSeconds,
    repos: CONFIG.repos.map((repo) => repo.nameWithOwner),
    disabledRepos: [],
    excludeAuthors: [],
    excludeDrafts: false,
    includeIssues: true,
  },
  rateLimit: { cost: 12, fetchCost: 24, remaining: 4900, limit: 5000, resetAt: '2026-08-12T23:00:00Z' },
  ...dashboard,
};

const { byId } = installDom(async (input) => {
  const url = String(input);
  if (url.includes('/api/dashboard')) return new Response(JSON.stringify(payload), { status: 200 });
  throw new Error(`テストが想定していないリクエスト: ${url}`);
});

await import('../public/app.js');
const list = byId('list');
assert.ok(await settle(list, { tries: 50, intervalMs: 20 }), '描画が終わらなかった');

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
const itemCount = payload.pullRequests.length + payload.issues.length;

test('KPI と状態フィルタが定義どおり並ぶ', () => {
  assert.equal(byId('kpis').children.length, 5);
  assert.equal(byId('bucketFilter').children.length, 5);
  assert.match(text(byId('kpis')), /Issue（PRなし）/);
});

test('カンバンに PR と Issue が全部出る', () => {
  const board = list.children[0];
  assert.equal(board.className, 'pivot');
  assert.equal(findAll(board, 'pivot-colhead').length, 5, '0件の列も出る');
  assert.equal(findAll(board, 'card').length, itemCount);
});

test('進捗グラフ3枚が描かれる', () => {
  assert.equal(findAll(byId('chartLink'), 'legend-key').length, 3);
  assert.equal(findAll(byId('chartMilestone'), 'bar-row').length, payload.milestones.length);
  assert.ok(findAll(byId('chartLabel'), 'bar-row').length > 0);
  // 進捗率は件数と一致していること（バーと数字が食い違わない）
  assert.match(text(byId('chartMilestone')), /25%/);
});

test('Issue連携の軸で3列に分かれる', async () => {
  byId('colDim').value = 'link';
  fire(byId('colDim'), 'change');
  await wait();
  const board = list.children[0];
  assert.equal(findAll(board, 'pivot-colhead').length, 3);
  assert.equal(findAll(board, 'card').length, itemCount);

  byId('colDim').value = 'bucket';
  fire(byId('colDim'), 'change');
  await wait();
});

test('ラベル軸は多値（合計が件数を超える）', async () => {
  byId('colDim').value = 'label';
  fire(byId('colDim'), 'change');
  await wait();
  assert.ok(findAll(list.children[0], 'card').length >= itemCount);

  byId('colDim').value = 'bucket';
  fire(byId('colDim'), 'change');
  await wait();
});

test('リスト表示に切り替えても件数が変わらない', async () => {
  fire(byId('viewToggle').children[1], 'click');
  await wait();
  assert.equal(list.className, 'list');
  assert.equal(findAll(list, 'pr').length, itemCount);
  assert.ok(findAll(list, 'group-heading').length > 0);
});

test('Issue除外で PR だけになる', async () => {
  byId('hideIssues').checked = true;
  fire(byId('hideIssues'), 'change');
  await wait();
  assert.equal(findAll(list, 'pr').length, payload.pullRequests.length);

  byId('hideIssues').checked = false;
  fire(byId('hideIssues'), 'change');
  await wait();
  assert.equal(findAll(list, 'pr').length, itemCount);
});

test('リポジトリの絞り込みチェックが出る', () => {
  assert.equal(byId('repoFilter').children.length, payload.repos.length + 1);
});

test('行を開くと詳細が出る（PR / Issue の両方）', async () => {
  const rows = findAll(list, 'pr');
  const prRow = rows.find((row) => findAll(row, 'pr-number').some((n) => !text(n).startsWith('Issue')));
  const issueRow = rows.find((row) => findAll(row, 'pr-number').some((n) => text(n).startsWith('Issue')));
  assert.ok(prRow && issueRow, 'PR と Issue の行が両方ある');

  fire(findAll(prRow, 'pr-row')[0], 'click');
  await wait();
  assert.ok(findAll(list, 'pr-details').length > 0);
  assert.match(text(findAll(list, 'pr-details')[0]), /Actions/);

  fire(findAll(issueRow, 'pr-row')[0], 'click');
  await wait();
  const details = findAll(list, 'pr-details').map(text).join('\n');
  assert.match(details, /Issue連携/);
});

test('エラーバナーが出ていない', () => {
  assert.equal(byId('banner').hidden, true, text(byId('banner')));
});
