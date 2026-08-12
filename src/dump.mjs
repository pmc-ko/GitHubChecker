// デバッグ用: サーバを立てずに整形後の JSON を標準出力に出す。
//   npm run dump                      → 全体を出力
//   npm run dump -- --repo Dealer     → リポジトリ名の部分一致で絞る
//   npm run dump -- --pr 449          → PR番号で絞って生の内訳まで見る
//   npm run dump -- --issue 488       → Issue番号で絞る（PRが無い Issue のみ一覧に出る）
//   npm run dump -- --stats           → 集計だけ（Issue連携の3パターンとマイルストンも出る）

import { loadConfig } from './config.mjs';
import { resolveToken } from './token.mjs';
import { fetchRepoPullRequests, fetchRepoIssues } from './github.mjs';
import { buildDashboard } from './summarize.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : null;
};

const config = await loadConfig();
const { token, source } = resolveToken();
console.error(`token source: ${source}`);

const repoFilter = flag('repo');
const repos = repoFilter
  ? config.repos.filter((repo) => repo.nameWithOwner.toLowerCase().includes(String(repoFilter).toLowerCase()))
  : config.repos;

if (!repos.length) {
  console.error('対象リポジトリがありません。config.json の repos か --repo の指定を確認してください。');
  process.exit(1);
}

const results = [];
for (const repo of repos) {
  console.error(`fetching ${repo.nameWithOwner} ...`);
  try {
    const prs = await fetchRepoPullRequests(token, repo, { maxPrs: config.maxPrsPerRepo });
    let issues = { issues: [], issueTotalCount: 0, milestones: [] };
    if (config.includeIssues) {
      try {
        issues = await fetchRepoIssues(token, repo, { maxIssues: config.maxIssuesPerRepo });
      } catch (err) {
        console.error(`  Issue 取得に失敗: ${err.message}`);
        issues = { issues: [], issueTotalCount: 0, milestones: [], issueError: err.message };
      }
    }
    results.push({ repo, ...prs, ...issues });
  } catch (err) {
    console.error(`  失敗: ${err.message}`);
    results.push({ repo, error: err.message, pullRequests: [], issues: [], milestones: [] });
  }
}

const dashboard = buildDashboard(results, config);
const prNumber = flag('pr');
const issueNumber = flag('issue');

if (flag('stats')) {
  console.log(
    JSON.stringify(
      { viewer: dashboard.viewer, repos: dashboard.repos, stats: dashboard.stats, milestones: dashboard.milestones },
      null,
      2
    )
  );
} else if (prNumber) {
  const found = dashboard.pullRequests.filter((pr) => String(pr.number) === String(prNumber));
  console.log(JSON.stringify(found, null, 2));
} else if (issueNumber) {
  const found = dashboard.issues.filter((issue) => String(issue.number) === String(issueNumber));
  console.log(JSON.stringify(found, null, 2));
} else {
  console.log(JSON.stringify(dashboard, null, 2));
}
