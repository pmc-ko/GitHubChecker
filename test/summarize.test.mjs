// 判定ロジック（src/summarize.mjs）のテスト。GitHub は叩かないので CI で回せる。
//   node --test test/
// 判定を変えたらここを直す（= 仕様が1か所に書いてある状態を保つ）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, classify, rollUpChecks, LINK_STATE } from '../src/summarize.mjs';
import { repoResult, CONFIG } from './fixture.mjs';

const build = (overrides = {}) => buildDashboard([repoResult()], { ...CONFIG, ...overrides });

test('バケット分けが期待どおり', () => {
  const { pullRequests } = build();
  const bucketOf = (number) => pullRequests.find((pr) => pr.number === number).bucket;
  assert.equal(bucketOf(1), 'action', 'CI 失敗は対応が必要');
  assert.equal(bucketOf(2), 'mergeable', '承認済み + CI 成功はマージ可');
  assert.equal(bucketOf(3), 'waiting', 'CI 実行中は待ち');
  assert.equal(bucketOf(4), 'other', 'Draft はその他');
});

test('Issue との紐づきが3パターンに分かれる', () => {
  const { pullRequests, issues, stats } = build();
  assert.equal(pullRequests.find((pr) => pr.number === 2).link, LINK_STATE.BOTH);
  assert.equal(pullRequests.find((pr) => pr.number === 1).link, LINK_STATE.PR_ONLY);

  // PR が紐づいた Issue #101 は一覧に出さない（PR 側に出るので重複させない）
  assert.deepEqual(
    issues.map((issue) => issue.number).sort(),
    [102, 103]
  );
  assert.ok(issues.every((issue) => issue.link === LINK_STATE.ISSUE_ONLY && issue.bucket === 'issue'));

  assert.equal(stats.both, 1);
  assert.equal(stats.prOnly, 3);
  assert.equal(stats.issueOnly, 2);
  assert.equal(stats.prOnly + stats.both, pullRequests.length, 'PRのみ + 両方 = PR 総数');
});

test('マイルストン進捗は Issue だけで計算し、GitHub の値は別に持つ', () => {
  const { milestones } = build();
  assert.equal(milestones.length, 1);
  const [milestone] = milestones;
  assert.equal(milestone.totalIssues, 4);
  assert.equal(milestone.closedIssues, 1);
  assert.equal(milestone.progressPercentage, 25, 'クローズ済み 1 / 全体 4');
  assert.equal(milestone.githubProgressPercentage, 62, 'GitHub の値（PR を含む母数）はそのまま保持');
});

test('PR のマイルストンが無ければ紐づく Issue のものを使える形になっている', () => {
  const { pullRequests } = build();
  const linked = pullRequests.find((pr) => pr.number === 2);
  assert.equal(linked.issues[0].milestone.title, 'v1.0');
});

test('excludeAuthors / excludeDrafts が効く', () => {
  const excluded = build({ excludeAuthors: ['dependabot[bot]'] });
  assert.ok(!excluded.pullRequests.some((pr) => pr.number === 4));

  const noDrafts = build({ excludeDrafts: true });
  assert.ok(!noDrafts.pullRequests.some((pr) => pr.isDraft));
});

test('自分の PR が数えられている', () => {
  const { stats } = build();
  assert.equal(stats.mine, 1);
});

test('rollUpChecks は skip を分母から外す', () => {
  const rolled = rollUpChecks([
    { state: 'success' },
    { state: 'success' },
    { state: 'skipped' },
  ]);
  assert.equal(rolled.state, 'success');
  assert.equal(rolled.total, 3);
  assert.equal(rolled.relevant, 2);
  assert.equal(rolled.passed, 2);
});

test('classify: コンフリクトは Draft でも対応が必要', () => {
  const result = classify({
    pr: { isDraft: true },
    ci: { state: 'success' },
    review: { state: 'none' },
    hasConflict: true,
  });
  assert.equal(result.bucket, 'action');
  assert.ok(result.labels.includes('コンフリクト'));
});

test('リポジトリの取得エラーは一覧を壊さない', () => {
  const dashboard = buildDashboard(
    [{ repo: { nameWithOwner: 'acme/broken' }, error: '見つかりません', pullRequests: [] }, repoResult()],
    CONFIG
  );
  assert.equal(dashboard.repos.find((repo) => repo.nameWithOwner === 'acme/broken').error, '見つかりません');
  assert.equal(dashboard.pullRequests.length, 4);
});
