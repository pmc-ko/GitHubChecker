// GraphQL の生データ → 画面が表示したい形への整形。
//
// 「この判定をこう変えたい」という要望はほぼこのファイルだけで済むように、
// 判定ロジックを小さな関数に分けてある。
//   - normalizeChecks() / rollUpChecks() : Actions（チェック）の状態
//   - summarizeReviews()                 : レビュー結果のサマリ
//   - classify()                         : 行の優先度（対応が必要 / マージ可 / 待ち / その他）

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

/** PR 1件を画面用オブジェクトに変換する */
export function summarizePullRequest(pr, repository, viewer) {
  const commit = pr.commits?.nodes?.[0]?.commit ?? null;
  const checks = normalizeChecks(commit);
  const ci = rollUpChecks(checks);
  const review = summarizeReviews(pr);
  const hasConflict = pr.mergeable === 'CONFLICTING';
  const classification = classify({ pr, ci, review, hasConflict });

  return {
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
    labels: (pr.labels?.nodes ?? []).map((label) => ({ name: label.name, color: label.color })),
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

/** 取得結果（複数リポジトリ）をまとめて一覧＋集計にする */
export function buildDashboard(repoResults, config) {
  const excludeAuthors = new Set((config.excludeAuthors ?? []).map((a) => a.toLowerCase()));
  const pullRequests = [];
  const repos = [];
  let viewer = null;

  for (const result of repoResults) {
    if (result.error) {
      repos.push({ nameWithOwner: result.repo.nameWithOwner, error: result.error, count: 0 });
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
    repos.push({
      nameWithOwner: result.repository.nameWithOwner,
      url: result.repository.url,
      error: null,
      count: kept,
      totalOpen: result.totalCount,
    });
  }

  pullRequests.sort(
    (a, b) => a.bucketOrder - b.bucketOrder || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)
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
  };

  return { viewer, repos, pullRequests, stats };
}

function durationSeconds(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const seconds = (new Date(completedAt) - new Date(startedAt)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
}
