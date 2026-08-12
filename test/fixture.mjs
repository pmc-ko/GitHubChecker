// テスト用の固定データ（GitHub GraphQL の応答と同じ形）。
// GitHub を叩かずに判定と描画を確かめるために使う。CI はこれだけで回る。
// 実データの形を変えたら（src/github.mjs のクエリを触ったら）ここも合わせる。

const VIEWER = 'me';
const REPO = { owner: 'acme', name: 'app', nameWithOwner: 'acme/app' };

const check = (name, status, conclusion) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://example.test/${name}`,
  startedAt: '2026-08-12T00:00:00Z',
  completedAt: '2026-08-12T00:01:00Z',
  checkSuite: { workflowRun: { event: 'pull_request', url: 'https://example.test/run', workflow: { name: 'CI' } } },
});

const author = (login) => ({ login, avatarUrl: `https://example.test/${login}.png` });
const labels = (...names) => ({ nodes: names.map((name) => ({ name, color: 'ededed' })) });

function pr({
  number,
  title,
  isDraft = false,
  mergeable = 'MERGEABLE',
  reviewDecision = null,
  login = 'someone',
  checks = [],
  reviews = [],
  requested = [],
  labelNames = [],
  milestone = null,
  closes = [],
}) {
  return {
    number,
    title,
    url: `https://example.test/pr/${number}`,
    isDraft,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: `2026-08-1${number % 10}T00:00:00Z`,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    mergeable,
    baseRefName: 'main',
    headRefName: `topic/${number}`,
    author: author(login),
    labels: labels(...labelNames),
    milestone,
    closingIssuesReferences: {
      totalCount: closes.length,
      nodes: closes.map((n) => ({
        number: n,
        title: `Issue ${n}`,
        url: `https://example.test/issue/${n}`,
        state: 'OPEN',
        repository: { nameWithOwner: REPO.nameWithOwner },
        milestone: { title: 'v1.0', url: 'https://example.test/milestone/1' },
      })),
    },
    comments: { totalCount: 1 },
    reviewDecision,
    reviewRequests: { nodes: requested.map((login) => ({ requestedReviewer: { __typename: 'User', ...author(login) } })) },
    latestReviews: {
      nodes: reviews.map(([login, state]) => ({
        state,
        submittedAt: '2026-08-11T00:00:00Z',
        url: 'https://example.test/review',
        author: author(login),
      })),
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: `${number}`.padStart(40, '0'),
            committedDate: '2026-08-11T12:00:00Z',
            messageHeadline: `commit for #${number}`,
            statusCheckRollup: checks.length ? { state: 'PENDING', contexts: { totalCount: checks.length, nodes: checks } } : null,
          },
        },
      ],
    },
  };
}

function issue({ number, title, labelNames = [], milestone = null, login = 'someone', assignees = [] }) {
  return {
    number,
    title,
    url: `https://example.test/issue/${number}`,
    state: 'OPEN',
    createdAt: '2026-08-02T00:00:00Z',
    updatedAt: `2026-08-0${number % 10}T00:00:00Z`,
    author: author(login),
    assignees: { nodes: assignees.map(author) },
    labels: labels(...labelNames),
    milestone,
    comments: { totalCount: 0 },
  };
}

const MILESTONE = { title: 'v1.0', url: 'https://example.test/milestone/1', dueOn: '2026-09-30T00:00:00Z', progressPercentage: 62 };

/** 1リポジトリぶんの取得結果。PR 4件（CI失敗/承認済み/Draft/Issue紐づき）+ Issue 3件 */
export function repoResult() {
  return {
    repo: REPO,
    repository: { nameWithOwner: REPO.nameWithOwner, url: 'https://example.test/repo' },
    viewer: VIEWER,
    totalCount: 4,
    rateLimit: { cost: 12, remaining: 4900, limit: 5000, resetAt: '2026-08-12T23:00:00Z' },
    pullRequests: [
      // CI 失敗 → 対応が必要 / Issue に紐づいていない（PRのみ）
      pr({ number: 1, title: 'CI が落ちている PR', checks: [check('build', 'COMPLETED', 'FAILURE')], labelNames: ['bug'] }),
      // 承認済み + CI 成功 → マージ可 / Issue #101 に紐づく（両方）
      pr({
        number: 2,
        title: '承認済みでマージできる PR',
        reviewDecision: 'APPROVED',
        checks: [check('build', 'COMPLETED', 'SUCCESS')],
        reviews: [['reviewer', 'APPROVED']],
        closes: [101],
        milestone: MILESTONE,
        labelNames: ['feature'],
      }),
      // CI 実行中 → 待ち（自分の PR）
      pr({ number: 3, title: '実行中の PR', login: VIEWER, checks: [check('build', 'IN_PROGRESS', null)] }),
      // Draft → その他 / bot 作者（除外テスト用）
      pr({ number: 4, title: 'Draft の PR', isDraft: true, login: 'dependabot[bot]' }),
    ],
    issueTotalCount: 3,
    issues: [
      issue({ number: 101, title: 'PR が紐づいている Issue', milestone: MILESTONE }), // PR #2 が閉じるので一覧に出ない
      issue({ number: 102, title: 'まだ着手されていない Issue', labelNames: ['bug'], milestone: MILESTONE, assignees: ['someone'] }),
      issue({ number: 103, title: 'ラベルなしの Issue' }),
    ],
    milestones: [
      {
        title: 'v1.0',
        url: 'https://example.test/milestone/1',
        dueOn: '2026-09-30T00:00:00Z',
        progressPercentage: 62,
        openIssues: { totalCount: 3 },
        closedIssues: { totalCount: 1 },
        openPullRequests: { totalCount: 2 },
      },
    ],
  };
}

export const CONFIG = {
  repos: [REPO],
  maxPrsPerRepo: 100,
  maxIssuesPerRepo: 100,
  includeIssues: true,
  cacheSeconds: 120,
  refreshSeconds: 300,
  excludeAuthors: [],
  excludeDrafts: false,
};

export const FIXTURE_VIEWER = VIEWER;
