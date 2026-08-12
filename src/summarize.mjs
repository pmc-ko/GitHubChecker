// GraphQL の生データ → 画面が表示したい形への整形。
//
// 「この判定をこう変えたい」という要望はほぼこのファイルだけで済むように、
// 判定ロジックを小さな関数に分けてある。
//   - normalizeChecks() / rollUpChecks() : Actions（チェック）の状態
//   - summarizeReviews()                 : レビュー結果のサマリ
//   - classify()                         : 行の優先度（対応が必要 / マージ可 / 待ち / その他）
//   - summarizeIssue()                   : Issue 1件（PR が無い Issue だけ一覧に出す）
//   - LINK_STATE                         : PR と Issue の紐づき（PRのみ / 両方 / Issueのみ）

/**
 * PR と Issue の紐づき。この3パターンが一覧の軸（Issue連携）とグラフの内訳になる。
 *   pr-only    : PR だけ（Issue に紐づいていない）
 *   both       : PR と Issue の両方がある（PR 側に Issue をぶら下げて1件で出す）
 *   issue-only : Issue だけ（オープンな PR がまだ無い＝未着手）
 */
export const LINK_STATE = { PR_ONLY: 'pr-only', BOTH: 'both', ISSUE_ONLY: 'issue-only' };

/** チェックの状態 → 表示上の1語 */
const CHECK_CONCLUSION = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  TIMED_OUT: 'failure',
  STARTUP_FAILURE: 'failure',
  ACTION_REQUIRED: 'failure',
  CANCELLED: 'cancelled',
  STALE: 'cancelled',
  SKIPPED: 'skipped',
  NEUTRAL: 'neutral',
};

const STATUS_CONTEXT_STATE = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

/** 最新コミットのチェック一覧を {name, workflow, state, url, ...} の配列に正規化する */
export function normalizeChecks(commit) {
  const rollup = commit?.statusCheckRollup;
  const nodes = rollup?.contexts?.nodes ?? [];

  return nodes.map((node) => {
    if (node.__typename === 'CheckRun') {
      const running = node.status !== 'COMPLETED';
      return {
        kind: 'check',
        name: node.name,
        workflow: node.checkSuite?.workflowRun?.workflow?.name ?? null,
        event: node.checkSuite?.workflowRun?.event ?? null,
        state: running ? 'pending' : (CHECK_CONCLUSION[node.conclusion] ?? 'neutral'),
        rawStatus: node.status,
        rawConclusion: node.conclusion,
        url: node.detailsUrl ?? node.checkSuite?.workflowRun?.url ?? null,
        startedAt: node.startedAt,
        completedAt: node.completedAt,
        durationSeconds: durationSeconds(node.startedAt, node.completedAt),
        description: null,
      };
    }
    // Commit Status（外部CIなど）
    return {
      kind: 'status',
      name: node.context,
      workflow: null,
      event: null,
      state: STATUS_CONTEXT_STATE[node.state] ?? 'neutral',
      rawStatus: node.state,
      rawConclusion: node.state,
      url: node.targetUrl ?? null,
      startedAt: node.createdAt,
      completedAt: null,
      durationSeconds: null,
      description: node.description ?? null,
    };
  });
}

/** チェック一覧 → 全体状態と内訳 */
export function rollUpChecks(checks) {
  const counts = { success: 0, failure: 0, pending: 0, cancelled: 0, skipped: 0, neutral: 0 };
  for (const check of checks) counts[check.state] = (counts[check.state] ?? 0) + 1;

  // 「成功/対象」の分母は skipped を除いた実行対象数
  const total = checks.length;
  const relevant = total - counts.skipped;

  let state = 'none';
  if (total === 0) state = 'none';
  else if (counts.failure > 0) state = 'failure';
  else if (counts.pending > 0) state = 'pending';
  else if (counts.cancelled > 0) state = 'cancelled';
  else if (counts.success > 0) state = 'success';
  else state = 'neutral';

  return {
    state,
    counts,
    total,
    relevant,
    passed: counts.success,
    failing: checks.filter((c) => c.state === 'failure').map(pickCheckBrief),
    running: checks.filter((c) => c.state === 'pending').map(pickCheckBrief),
  };
}

function pickCheckBrief(check) {
  return { name: check.name, workflow: check.workflow, url: check.url };
}

/**
 * レビュー結果のサマリ。
 * latestReviews = レビュアーごとの最新レビュー1件。reviewRequests = まだ出していない依頼。
 */
export function summarizeReviews(pr) {
  const reviewers = (pr.latestReviews?.nodes ?? [])
    .filter((review) => review.author)
    .map((review) => ({
      login: review.author.login,
      avatarUrl: review.author.avatarUrl,
      state: review.state, // APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING
      submittedAt: review.submittedAt,
      url: review.url,
    }));

  const reviewed = new Set(reviewers.map((r) => r.login));
  const requested = (pr.reviewRequests?.nodes ?? [])
    .map((node) => {
      const reviewer = node.requestedReviewer;
      if (!reviewer) return null;
      if (reviewer.__typename === 'Team') {
        return { login: `@${reviewer.name}`, avatarUrl: null, isTeam: true };
      }
      return { login: reviewer.login, avatarUrl: reviewer.avatarUrl, isTeam: false };
    })
    .filter(Boolean)
    .filter((reviewer) => !reviewed.has(reviewer.login));

  const by = (state) => reviewers.filter((r) => r.state === state);
  const approved = by('APPROVED');
  const changesRequested = by('CHANGES_REQUESTED');
  const commented = by('COMMENTED');
  const dismissed = by('DISMISSED');

  // reviewDecision はブランチ保護の設定次第で null になるので、null のときは実績から導く
  let state;
  switch (pr.reviewDecision) {
    case 'CHANGES_REQUESTED':
      state = 'changes_requested';
      break;
    case 'APPROVED':
      state = 'approved';
      break;
    case 'REVIEW_REQUIRED':
      state = 'review_required';
      break;
    default:
      if (changesRequested.length) state = 'changes_requested';
      else if (approved.length) state = 'approved';
      else if (commented.length) state = 'commented';
      else if (requested.length) state = 'review_required';
      else state = 'none';
  }

  return {
    state,
    decision: pr.reviewDecision ?? null,
    reviewers,
    requested,
    counts: {
      approved: approved.length,
      changesRequested: changesRequested.length,
      commented: commented.length,
      dismissed: dismissed.length,
      requested: requested.length,
    },
    /** 最後にレビューが入った時刻（対応の起点） */
    lastReviewedAt: reviewers.reduce(
      (latest, r) => (r.submittedAt && (!latest || r.submittedAt > latest) ? r.submittedAt : latest),
      null
    ),
  };
}

/**
 * 行の分類。バケット順に並べるので、ここを変えると一覧の並び順と KPI が変わる。
 *   action  : 自分/誰かが動かないと進まない（CI失敗・変更要求・コンフリクト）
 *   mergeable: CI通過 & 承認済み & Draftでない → マージできる
 *   waiting : CI実行中 or レビュー待ち
 *   other   : それ以外（Draft、レビュー依頼もされていない等）
 */
export function classify({ pr, ci, review, hasConflict }) {
  const reasons = [];

  if (ci.state === 'failure') reasons.push({ bucket: 'action', label: 'CI失敗' });
  if (review.state === 'changes_requested') reasons.push({ bucket: 'action', label: '変更要求' });
  if (hasConflict) reasons.push({ bucket: 'action', label: 'コンフリクト' });

  if (!reasons.length) {
    if (ci.state === 'pending') reasons.push({ bucket: 'waiting', label: 'CI実行中' });
    if (review.state === 'review_required') reasons.push({ bucket: 'waiting', label: 'レビュー待ち' });
  }

  if (!reasons.length) {
    const ciOk = ci.state === 'success' || ci.state === 'none';
    if (review.state === 'approved' && ciOk && !pr.isDraft) {
      reasons.push({ bucket: 'mergeable', label: 'マージ可' });
    }
  }

  if (pr.isDraft && !reasons.some((r) => r.bucket === 'action')) {
    reasons.push({ bucket: 'other', label: 'Draft' });
  }
  if (!reasons.length) reasons.push({ bucket: 'other', label: '進行中' });

  const order = { action: 0, mergeable: 1, waiting: 2, other: 3 };
  const bucket = reasons.reduce((best, r) => (order[r.bucket] < order[best] ? r.bucket : best), 'other');

  return { bucket, order: order[bucket], labels: reasons.map((r) => r.label) };
}

/** ラベル配列の整形（PR / Issue で共通） */
function pickLabels(node) {
  return (node?.labels?.nodes ?? []).map((label) => ({ name: label.name, color: label.color }));
}

/** マイルストンの整形。進捗率は GitHub が計算した値をそのまま使う */
function pickMilestone(node) {
  const milestone = node?.milestone;
  if (!milestone) return null;
  return {
    title: milestone.title,
    url: milestone.url ?? null,
    dueOn: milestone.dueOn ?? null,
    progressPercentage:
      typeof milestone.progressPercentage === 'number' ? Math.round(milestone.progressPercentage) : null,
  };
}

/** PR 1件を画面用オブジェクトに変換する */
export function summarizePullRequest(pr, repository, viewer) {
  const commit = pr.commits?.nodes?.[0]?.commit ?? null;
  const checks = normalizeChecks(commit);
  const ci = rollUpChecks(checks);
  const review = summarizeReviews(pr);
  const hasConflict = pr.mergeable === 'CONFLICTING';
  const classification = classify({ pr, ci, review, hasConflict });

  // 「Fixes #123」等で紐づいた Issue。ここが空なら PRのみ、あれば両方
  const issues = (pr.closingIssuesReferences?.nodes ?? []).map((issue) => {
    const repo = issue.repository?.nameWithOwner ?? repository.nameWithOwner;
    return {
      key: issueKey(repo, issue.number),
      repo,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      labels: pickLabels(issue),
      milestone: pickMilestone(issue),
    };
  });

  return {
    kind: 'pr',
    link: issues.length ? LINK_STATE.BOTH : LINK_STATE.PR_ONLY,
    issues,
    milestone: pickMilestone(pr),
    id: `${repository.nameWithOwner}#${pr.number}`,
    repo: repository.nameWithOwner,
    repoUrl: repository.url,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    author: pr.author?.login ?? 'ghost',
    authorAvatarUrl: pr.author?.avatarUrl ?? null,
    isMine: Boolean(viewer && pr.author?.login === viewer),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commentCount: pr.comments?.totalCount ?? 0,
    labels: pickLabels(pr),
    mergeable: pr.mergeable,
    hasConflict,
    headCommit: commit
      ? {
          oid: commit.oid,
          shortOid: commit.oid.slice(0, 7),
          committedDate: commit.committedDate,
          messageHeadline: commit.messageHeadline,
        }
      : null,
    /** レビュー指摘より後に push があるか（対応済みらしさの目安） */
    pushedAfterReview: Boolean(
      review.lastReviewedAt && commit?.committedDate && commit.committedDate > review.lastReviewedAt
    ),
    ci,
    checks,
    review,
    bucket: classification.bucket,
    bucketOrder: classification.order,
    statusLabels: classification.labels,
  };
}

export function issueKey(repo, number) {
  return `${repo}#${number}`;
}

/**
 * Issue 1件を画面用オブジェクトに変換する。
 * PR と同じ一覧に並べるので、PR にしか無いもの（CI・レビュー）は「無し」で埋めて形を揃える。
 * バケットは 'issue' 固定（`public/app.js` の BUCKETS にも同じキーがある）。
 */
export function summarizeIssue(issue, repository, viewer) {
  return {
    kind: 'issue',
    link: LINK_STATE.ISSUE_ONLY,
    issues: [],
    milestone: pickMilestone(issue),
    id: `${repository.nameWithOwner}!${issue.number}`,
    repo: repository.nameWithOwner,
    repoUrl: repository.url,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    isDraft: false,
    author: issue.author?.login ?? 'ghost',
    authorAvatarUrl: issue.author?.avatarUrl ?? null,
    isMine: Boolean(viewer && issue.author?.login === viewer),
    assignees: (issue.assignees?.nodes ?? []).map((user) => ({ login: user.login, avatarUrl: user.avatarUrl })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    baseRefName: null,
    headRefName: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    commentCount: issue.comments?.totalCount ?? 0,
    labels: pickLabels(issue),
    mergeable: null,
    hasConflict: false,
    headCommit: null,
    pushedAfterReview: false,
    ci: { state: 'none', counts: {}, total: 0, relevant: 0, passed: 0, failing: [], running: [] },
    checks: [],
    review: {
      state: 'none',
      decision: null,
      reviewers: [],
      requested: [],
      counts: { approved: 0, changesRequested: 0, commented: 0, dismissed: 0, requested: 0 },
      lastReviewedAt: null,
    },
    bucket: 'issue',
    bucketOrder: 4,
    statusLabels: ['PRなし'],
  };
}

/** 取得結果（複数リポジトリ）をまとめて一覧＋集計にする */
export function buildDashboard(repoResults, config) {
  const excludeAuthors = new Set((config.excludeAuthors ?? []).map((a) => a.toLowerCase()));
  const pullRequests = [];
  const rawIssues = [];
  const milestones = [];
  const repos = [];
  let viewer = null;

  for (const result of repoResults) {
    if (result.error) {
      repos.push({ nameWithOwner: result.repo.nameWithOwner, error: result.error, count: 0, issueCount: 0 });
      continue;
    }
    viewer = result.viewer ?? viewer;
    let kept = 0;
    for (const pr of result.pullRequests) {
      const summary = summarizePullRequest(pr, result.repository, result.viewer);
      if (excludeAuthors.has(summary.author.toLowerCase())) continue;
      if (config.excludeDrafts && summary.isDraft) continue;
      pullRequests.push(summary);
      kept += 1;
    }

    // Issue は PR との紐づきを見てから絞るので、いったん全部持っておく
    for (const issue of result.issues ?? []) {
      const summary = summarizeIssue(issue, result.repository, result.viewer);
      if (excludeAuthors.has(summary.author.toLowerCase())) continue;
      rawIssues.push(summary);
    }

    for (const milestone of result.milestones ?? []) {
      const closed = milestone.closedIssues?.totalCount ?? 0;
      const open = milestone.openIssues?.totalCount ?? 0;
      milestones.push({
        repo: result.repository.nameWithOwner,
        title: milestone.title,
        url: milestone.url ?? null,
        dueOn: milestone.dueOn ?? null,
        openIssues: open,
        closedIssues: closed,
        totalIssues: open + closed,
        openPullRequests: milestone.openPullRequests?.totalCount ?? 0,
        /**
         * 進捗率は「クローズ済み Issue ÷ Issue 全体」で出す。
         * GitHub の画面に出る progressPercentage は PR も母数に入るため一致しない。
         * 表示している件数と割合を必ず一致させたいので、こちらを主にして GitHub 値は別に持つ。
         */
        progressPercentage: open + closed > 0 ? Math.round((closed / (open + closed)) * 100) : 0,
        githubProgressPercentage:
          typeof milestone.progressPercentage === 'number' ? Math.round(milestone.progressPercentage) : null,
      });
    }

    repos.push({
      nameWithOwner: result.repository.nameWithOwner,
      url: result.repository.url,
      error: null,
      count: kept,
      totalOpen: result.totalCount,
      issueCount: (result.issues ?? []).length,
      issueTotalOpen: result.issueTotalCount ?? 0,
      issueError: result.issueError ?? null,
    });
  }

  // PR が紐づいている Issue は PR 側に出るので、一覧に出す Issue から除く（重複させない）
  const linked = new Set(pullRequests.flatMap((pr) => pr.issues.map((issue) => issue.key)));
  const issues = rawIssues.filter((issue) => !linked.has(issueKey(issue.repo, issue.number)));

  const byUpdated = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  pullRequests.sort((a, b) => a.bucketOrder - b.bucketOrder || byUpdated(a, b));
  issues.sort(byUpdated);
  milestones.sort(
    (a, b) =>
      (a.dueOn ? 0 : 1) - (b.dueOn ? 0 : 1) ||
      String(a.dueOn).localeCompare(String(b.dueOn)) ||
      a.repo.localeCompare(b.repo) ||
      a.title.localeCompare(b.title)
  );

  const stats = {
    total: pullRequests.length,
    action: pullRequests.filter((pr) => pr.bucket === 'action').length,
    mergeable: pullRequests.filter((pr) => pr.bucket === 'mergeable').length,
    waiting: pullRequests.filter((pr) => pr.bucket === 'waiting').length,
    other: pullRequests.filter((pr) => pr.bucket === 'other').length,
    ciFailure: pullRequests.filter((pr) => pr.ci.state === 'failure').length,
    ciPending: pullRequests.filter((pr) => pr.ci.state === 'pending').length,
    changesRequested: pullRequests.filter((pr) => pr.review.state === 'changes_requested').length,
    reviewRequired: pullRequests.filter((pr) => pr.review.state === 'review_required').length,
    approved: pullRequests.filter((pr) => pr.review.state === 'approved').length,
    conflict: pullRequests.filter((pr) => pr.hasConflict).length,
    mine: pullRequests.filter((pr) => pr.isMine).length,
    // Issue との紐づき（3パターン）。prOnly + both = PR 総数
    prOnly: pullRequests.filter((pr) => pr.link === LINK_STATE.PR_ONLY).length,
    both: pullRequests.filter((pr) => pr.link === LINK_STATE.BOTH).length,
    issueOnly: issues.length,
    linkedIssues: linked.size,
    milestoneCount: milestones.length,
  };

  return { viewer, repos, pullRequests, issues, milestones, stats };
}

function durationSeconds(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const seconds = (new Date(completedAt) - new Date(startedAt)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
}
