// ダッシュボードの描画。
// ラベル・アイコン・色の対応は先頭の定義テーブルに集約してあるので、
// 「この表示をこう変えたい」は基本そこを直すだけで済む。
// DOM は textContent 経由で組み立てる（PRタイトル等をそのままHTMLにしない）。

/* ---------------- 表示定義（ここを触れば見た目の意味づけが変わる） ---------------- */

/** バケット = 一覧のグルーピングと並び順。src/summarize.mjs の classify() と対応 */
const BUCKETS = [
  { key: 'action', label: '対応が必要', tone: 'critical' },
  { key: 'mergeable', label: 'マージ可', tone: 'good' },
  { key: 'waiting', label: '待ち', tone: 'warning' },
  { key: 'other', label: 'その他', tone: 'idle' },
];

/** Actions（チェック）の全体状態 */
const CI_STATE = {
  success: { label: 'CI成功', icon: '✔', tone: 'good' },
  failure: { label: 'CI失敗', icon: '✕', tone: 'critical' },
  pending: { label: 'CI実行中', icon: '◐', tone: 'warning' },
  cancelled: { label: 'CI中断', icon: '⊘', tone: 'idle' },
  neutral: { label: 'CI対象外', icon: '–', tone: 'idle' },
  none: { label: 'CIなし', icon: '–', tone: 'idle' },
};

/** レビュー結果のサマリ状態 */
const REVIEW_STATE = {
  approved: { label: '承認済み', icon: '✔', tone: 'good' },
  changes_requested: { label: '変更要求', icon: '✕', tone: 'serious' },
  review_required: { label: 'レビュー待ち', icon: '◔', tone: 'warning' },
  commented: { label: 'コメントのみ', icon: '≡', tone: 'idle' },
  none: { label: '未レビュー', icon: '–', tone: 'idle' },
};

/** 個別チェックのアイコン */
const CHECK_ICON = {
  success: '✔',
  failure: '✕',
  pending: '◐',
  cancelled: '⊘',
  skipped: '·',
  neutral: '–',
};

const REVIEW_ITEM = {
  APPROVED: { label: '承認', icon: '✔', tone: 'good' },
  CHANGES_REQUESTED: { label: '変更要求', icon: '✕', tone: 'serious' },
  COMMENTED: { label: 'コメント', icon: '≡', tone: 'idle' },
  DISMISSED: { label: '棄却', icon: '⊘', tone: 'idle' },
  PENDING: { label: '下書き', icon: '·', tone: 'idle' },
};

/* ---------------- 状態 ---------------- */

const FILTER_KEY = 'pr-monitor-filters';
const THEME_KEY = 'pr-monitor-theme';

const state = {
  data: null,
  error: null,
  loading: false,
  open: new Set(), // 展開中のPRのid
  filters: {
    buckets: BUCKETS.map((b) => b.key), // 既定は全部表示
    repo: '',
    search: '',
    mineOnly: false,
    hideBots: false,
    hideDrafts: false,
  },
};

const dom = {
  viewer: document.getElementById('viewer'),
  fetched: document.getElementById('fetched'),
  refresh: document.getElementById('refresh'),
  autoRefresh: document.getElementById('autoRefresh'),
  autoRefreshLabel: document.getElementById('autoRefreshLabel'),
  theme: document.getElementById('theme'),
  banner: document.getElementById('banner'),
  kpis: document.getElementById('kpis'),
  bucketFilter: document.getElementById('bucketFilter'),
  repoFilter: document.getElementById('repoFilter'),
  search: document.getElementById('search'),
  mineOnly: document.getElementById('mineOnly'),
  hideBots: document.getElementById('hideBots'),
  hideDrafts: document.getElementById('hideDrafts'),
  expandAll: document.getElementById('expandAll'),
  list: document.getElementById('list'),
  footerInfo: document.getElementById('footerInfo'),
};

/* ---------------- 小さなヘルパ ---------------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const relativeFormatter = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' });

function relativeTime(iso) {
  if (!iso) return '';
  const diffSeconds = (new Date(iso) - Date.now()) / 1000;
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds) return relativeFormatter.format(Math.round(diffSeconds / seconds), unit);
  }
  return relativeFormatter.format(Math.round(diffSeconds), 'second');
}

function absoluteTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ja-JP', { hour12: false });
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${String(seconds % 60).padStart(2, '0')}秒`;
  return `${Math.floor(minutes / 60)}時間${String(minutes % 60).padStart(2, '0')}分`;
}

function shortRepo(nameWithOwner) {
  return nameWithOwner.split('/')[1] ?? nameWithOwner;
}

function isBot(login) {
  return /\[bot\]$/.test(login) || /(^|-)bot$/i.test(login) || login === 'Codex' || login === 'dependabot';
}

function badge(spec, extraText) {
  return el('span', { class: 'badge', dataset: { tone: spec.tone }, title: extraText ?? spec.label }, [
    el('span', { class: 'icon', 'aria-hidden': 'true', text: spec.icon }),
    el('span', { text: spec.label }),
  ]);
}

/* ---------------- データ取得 ---------------- */

async function load({ refresh = false } = {}) {
  state.loading = true;
  dom.refresh.classList.add('is-loading');
  if (!state.data) renderSkeleton();

  try {
    const response = await fetch(`/api/dashboard${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    state.data = payload;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    dom.refresh.classList.remove('is-loading');
    render();
    resetAutoRefresh();
  }
}

/* ---------------- 描画 ---------------- */

function renderSkeleton() {
  dom.list.replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'skeleton' })));
}

function render() {
  renderBanner();
  renderMeta();
  renderRepoOptions();
  const visible = applyFilters(state.data?.pullRequests ?? []);
  renderKpis();
  renderBucketFilter();
  renderList(visible);
  renderFooter(visible);
}

function renderBanner() {
  const messages = [];
  let tone = 'warning';
  if (state.error) {
    messages.push(`取得に失敗しました: ${state.error}`);
    tone = 'critical';
  }
  if (state.data?.warning) messages.push(state.data.warning);
  for (const repo of state.data?.repos ?? []) {
    if (repo.error) messages.push(`${repo.nameWithOwner}: ${repo.error}`);
  }
  dom.banner.textContent = messages.join('\n');
  dom.banner.dataset.tone = tone;
  dom.banner.hidden = messages.length === 0;
}

function renderMeta() {
  const data = state.data;
  dom.viewer.textContent = data?.viewer ? `@${data.viewer}` : '';
  if (data?.fetchedAt) {
    const age = data.cached ? `（キャッシュ ${data.ageSeconds}秒前）` : '';
    dom.fetched.textContent = `取得: ${absoluteTime(data.fetchedAt)}${age}`;
  } else {
    dom.fetched.textContent = '';
  }
}

function renderRepoOptions() {
  const repos = state.data?.repos ?? [];
  const current = state.filters.repo;
  const options = [el('option', { value: '', text: `全リポジトリ (${repos.length})` })];
  for (const repo of repos) {
    options.push(
      el('option', {
        value: repo.nameWithOwner,
        text: `${shortRepo(repo.nameWithOwner)} (${repo.count})`,
        selected: repo.nameWithOwner === current,
      })
    );
  }
  dom.repoFilter.replaceChildren(...options);
  dom.repoFilter.value = repos.some((r) => r.nameWithOwner === current) ? current : '';
}

function applyFilters(pullRequests) {
  const { buckets, repo, search, mineOnly, hideBots, hideDrafts } = state.filters;
  const needle = search.trim().toLowerCase();
  return pullRequests.filter((pr) => {
    if (!buckets.includes(pr.bucket)) return false;
    if (repo && pr.repo !== repo) return false;
    if (mineOnly && !pr.isMine) return false;
    if (hideBots && isBot(pr.author)) return false;
    if (hideDrafts && pr.isDraft) return false;
    if (needle) {
      const haystack = [pr.title, pr.author, pr.headRefName, pr.baseRefName, String(pr.number), pr.repo]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function renderKpis() {
  const stats = state.data?.stats;
  if (!stats) {
    dom.kpis.replaceChildren();
    return;
  }
  const repoCount = (state.data.repos ?? []).filter((r) => !r.error).length;
  const tiles = [
    {
      tone: 'critical',
      label: '対応が必要',
      value: stats.action,
      sub: `CI失敗 ${stats.ciFailure} / 変更要求 ${stats.changesRequested} / コンフリクト ${stats.conflict}`,
    },
    { tone: 'warning', label: '待ち', value: stats.waiting, sub: `CI実行中 ${stats.ciPending} / レビュー待ち ${stats.reviewRequired}` },
    { tone: 'good', label: 'マージ可', value: stats.mergeable, sub: `承認済み ${stats.approved}` },
    { tone: 'idle', label: '監視中のPR', value: stats.total, sub: `自分 ${stats.mine} / ${repoCount} リポジトリ` },
  ];

  dom.kpis.replaceChildren(
    ...tiles.map((tile) =>
      el('div', { class: 'kpi' }, [
        el('div', { class: 'kpi-label' }, [
          el('span', { class: 'dot', dataset: { tone: tile.tone }, 'aria-hidden': 'true' }),
          el('span', { text: tile.label }),
        ]),
        el('div', { class: 'kpi-value', text: String(tile.value) }),
        el('div', { class: 'kpi-sub', text: tile.sub }),
      ])
    )
  );
}

function renderBucketFilter() {
  const pullRequests = state.data?.pullRequests ?? [];
  dom.bucketFilter.replaceChildren(
    ...BUCKETS.map((bucket) => {
      const count = pullRequests.filter((pr) => pr.bucket === bucket.key).length;
      const active = state.filters.buckets.includes(bucket.key);
      return el(
        'button',
        {
          type: 'button',
          class: 'bucket-chip',
          'aria-pressed': String(active),
          onclick: () => toggleBucket(bucket.key),
        },
        [
          el('span', { class: 'dot', dataset: { tone: bucket.tone }, 'aria-hidden': 'true' }),
          el('span', { text: bucket.label }),
          el('span', { class: 'count', text: String(count) }),
        ]
      );
    })
  );
}

function renderList(pullRequests) {
  if (!state.data) return;
  if (!pullRequests.length) {
    dom.list.replaceChildren(
      el('p', { class: 'empty', text: state.data.pullRequests.length ? '絞り込み条件に合うPRがありません。' : '表示できるPRがありません。' })
    );
    return;
  }

  const children = [];
  let currentBucket = null;
  for (const pr of pullRequests) {
    if (pr.bucket !== currentBucket) {
      currentBucket = pr.bucket;
      const bucket = BUCKETS.find((b) => b.key === currentBucket);
      const count = pullRequests.filter((p) => p.bucket === currentBucket).length;
      children.push(el('h2', { class: 'group-heading', text: `${bucket?.label ?? currentBucket} · ${count}` }));
    }
    children.push(renderPr(pr));
  }
  dom.list.replaceChildren(...children);
}

function renderPr(pr) {
  const ci = CI_STATE[pr.ci.state] ?? CI_STATE.none;
  const review = REVIEW_STATE[pr.review.state] ?? REVIEW_STATE.none;
  const bucket = BUCKETS.find((b) => b.key === pr.bucket);
  const isOpen = state.open.has(pr.id);

  const head = el('div', { class: 'pr-head-cell' }, [
    el('div', { class: 'pr-head' }, [
      el('span', { class: 'pr-repo', text: shortRepo(pr.repo) }),
      el('a', {
        class: 'pr-number',
        href: pr.url,
        target: '_blank',
        rel: 'noreferrer',
        text: `#${pr.number}`,
        onclick: (event) => event.stopPropagation(),
      }),
      el('a', {
        class: 'pr-title',
        href: pr.url,
        target: '_blank',
        rel: 'noreferrer',
        text: pr.title,
        onclick: (event) => event.stopPropagation(),
      }),
      ...pr.labels.slice(0, 3).map((label) =>
        el('span', {
          class: 'label-chip',
          text: label.name,
          style: `background:#${label.color}22;border:1px solid #${label.color}66;color:var(--text-secondary)`,
        })
      ),
    ]),
    el('div', { class: 'pr-meta' }, [
      pr.authorAvatarUrl ? el('img', { class: 'avatar', src: pr.authorAvatarUrl, alt: '', loading: 'lazy' }) : null,
      el('span', { text: pr.author }),
      pr.isMine ? el('span', { class: 'mine', text: '自分' }) : null,
      pr.isDraft ? el('span', { text: 'Draft' }) : null,
      el('span', { text: `${pr.headRefName} → ${pr.baseRefName}` }),
      el('span', { class: 'diff-add', text: `+${pr.additions} −${pr.deletions} / ${pr.changedFiles}ファイル` }),
      pr.commentCount ? el('span', { text: `コメント ${pr.commentCount}` }) : null,
      el('span', { title: absoluteTime(pr.updatedAt), text: `更新 ${relativeTime(pr.updatedAt)}` }),
      pr.hasConflict ? el('span', { text: '⚠ コンフリクト' }) : null,
      pr.mergeable === 'UNKNOWN' ? el('span', { text: 'マージ可否 判定中' }) : null,
    ]),
  ]);

  const ratio = pr.ci.relevant > 0 ? Math.round((pr.ci.passed / pr.ci.relevant) * 100) : 0;
  const ciCell = el('div', { class: 'cell cell-ci' }, [
    badge(ci, `${ci.label} (${pr.ci.state})`),
    el('div', { class: 'cell-sub' }, [
      pr.ci.total
        ? el('div', { class: 'meter', dataset: { tone: ci.tone }, role: 'presentation' }, [
            el('span', { style: `width:${ratio}%` }),
          ])
        : null,
      el('span', { text: pr.ci.total ? `${pr.ci.passed}/${pr.ci.relevant}` : 'チェックなし' }),
      pr.ci.failing.length ? el('span', { text: `失敗 ${pr.ci.failing.length}` }) : null,
      pr.ci.running.length ? el('span', { text: `実行中 ${pr.ci.running.length}` }) : null,
    ]),
  ]);

  const reviewCell = el('div', { class: 'cell cell-review' }, [
    badge(review, pr.review.decision ? `reviewDecision: ${pr.review.decision}` : 'ブランチ保護のレビュー必須設定なし'),
    el('div', { class: 'cell-sub' }, [
      el('span', {
        text: [
          pr.review.counts.approved ? `承認 ${pr.review.counts.approved}` : null,
          pr.review.counts.changesRequested ? `変更要求 ${pr.review.counts.changesRequested}` : null,
          pr.review.counts.commented ? `コメント ${pr.review.counts.commented}` : null,
          pr.review.counts.requested ? `依頼中 ${pr.review.counts.requested}` : null,
        ]
          .filter(Boolean)
          .join(' / ') || 'レビューなし',
      }),
      el(
        'span',
        { class: 'avatars' },
        [...pr.review.reviewers, ...pr.review.requested].slice(0, 5).map((person) =>
          person.avatarUrl
            ? el('img', { src: person.avatarUrl, alt: person.login, title: person.login, loading: 'lazy' })
            : el('span', { class: 'team', text: person.login })
        )
      ),
    ]),
  ]);

  const row = el(
    'div',
    { class: 'pr-row', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) },
    [head, ciCell, reviewCell, el('span', { class: 'chevron', 'aria-hidden': 'true', text: '▶' })]
  );

  const article = el('article', {
    class: 'pr',
    dataset: { tone: bucket?.tone ?? 'idle', open: String(isOpen) },
  }, [row, isOpen ? renderDetails(pr) : null]);

  const toggle = () => {
    if (state.open.has(pr.id)) state.open.delete(pr.id);
    else state.open.add(pr.id);
    render();
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });

  return article;
}

function renderDetails(pr) {
  const order = { failure: 0, pending: 1, cancelled: 2, neutral: 3, success: 4, skipped: 5 };
  const checks = [...pr.checks].sort(
    (a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || (a.workflow ?? '').localeCompare(b.workflow ?? '') || a.name.localeCompare(b.name)
  );
  const shown = checks.slice(0, 40);

  const checkColumn = el('div', {}, [
    el('h3', { class: 'detail-title', text: `Actions（${pr.headCommit?.shortOid ?? '-'} の結果）` }),
    shown.length
      ? el(
          'ul',
          { class: 'check-list' },
          shown.map((check) =>
            el('li', { class: 'check-item', dataset: { state: check.state } }, [
              el('span', { class: 'icon', 'aria-hidden': 'true', text: CHECK_ICON[check.state] ?? '–' }),
              el('span', {}, [
                check.workflow ? el('span', { class: 'workflow', text: `${check.workflow} / ` }) : null,
                check.url
                  ? el('a', { href: check.url, target: '_blank', rel: 'noreferrer', text: check.name })
                  : el('span', { text: check.name }),
                check.description ? el('span', { class: 'workflow', text: ` — ${check.description}` }) : null,
              ]),
              el('span', { class: 'duration', text: formatDuration(check.durationSeconds) }),
            ])
          )
        )
      : el('p', { class: 'detail-note', text: 'このコミットに対するチェックはありません。' }),
    checks.length > shown.length
      ? el('p', { class: 'detail-note', text: `他 ${checks.length - shown.length} 件は省略（GitHubで確認してください）` })
      : null,
    pr.headCommit
      ? el('p', { class: 'detail-note', text: `最新コミット: ${pr.headCommit.messageHeadline}（${relativeTime(pr.headCommit.committedDate)}）` })
      : null,
  ]);

  const reviewColumn = el('div', {}, [
    el('h3', { class: 'detail-title', text: 'レビュー' }),
    pr.review.reviewers.length || pr.review.requested.length
      ? el('ul', { class: 'reviewer-list' }, [
          ...pr.review.reviewers.map((reviewer) => {
            const spec = REVIEW_ITEM[reviewer.state] ?? REVIEW_ITEM.COMMENTED;
            return el('li', { class: 'reviewer-item' }, [
              reviewer.avatarUrl ? el('img', { src: reviewer.avatarUrl, alt: '', loading: 'lazy' }) : null,
              reviewer.url
                ? el('a', { href: reviewer.url, target: '_blank', rel: 'noreferrer', text: reviewer.login })
                : el('span', { text: reviewer.login }),
              badge(spec),
              el('time', { datetime: reviewer.submittedAt ?? '', title: absoluteTime(reviewer.submittedAt), text: relativeTime(reviewer.submittedAt) }),
            ]);
          }),
          ...pr.review.requested.map((person) =>
            el('li', { class: 'reviewer-item' }, [
              person.avatarUrl ? el('img', { src: person.avatarUrl, alt: '', loading: 'lazy' }) : null,
              el('span', { text: person.login }),
              badge({ label: '依頼中（未レビュー）', icon: '◔', tone: 'warning' }),
            ])
          ),
        ])
      : el('p', { class: 'detail-note', text: 'レビュアーの割り当てもレビューもありません。' }),
    el('p', { class: 'detail-note', text: `判定: ${pr.statusLabels.join(' / ')}` }),
    pr.review.lastReviewedAt
      ? el('p', {
          class: 'detail-note',
          text: pr.pushedAfterReview
            ? `最後のレビュー(${relativeTime(pr.review.lastReviewedAt)})より後にpushあり → 対応済みの可能性`
            : `最後のレビュー(${relativeTime(pr.review.lastReviewedAt)})より後のpushなし`,
        })
      : null,
  ]);

  return el('div', { class: 'pr-details' }, [checkColumn, reviewColumn]);
}

function renderFooter(visible) {
  const data = state.data;
  if (!data) {
    dom.footerInfo.textContent = '';
    return;
  }
  const parts = [`表示 ${visible.length} / ${data.pullRequests.length} 件`];
  if (data.rateLimit) {
    parts.push(`API残 ${data.rateLimit.remaining}/${data.rateLimit.limit}（リセット ${relativeTime(data.rateLimit.resetAt)}）`);
  }
  if (data.settings?.excludeAuthors?.length) parts.push(`除外作成者: ${data.settings.excludeAuthors.join(', ')}`);
  dom.footerInfo.textContent = parts.join(' · ');
}

/* ---------------- 操作 ---------------- */

function toggleBucket(key) {
  const buckets = new Set(state.filters.buckets);
  if (buckets.has(key)) buckets.delete(key);
  else buckets.add(key);
  // 全部外すと何も出なくなるので、その場合は全選択に戻す
  state.filters.buckets = buckets.size ? BUCKETS.filter((b) => buckets.has(b.key)).map((b) => b.key) : BUCKETS.map((b) => b.key);
  saveFilters();
  render();
}

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters));
  } catch {
    /* プライベートモード等では保存できないが動作には影響しない */
  }
}

function restoreFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    Object.assign(state.filters, saved);
    if (!Array.isArray(state.filters.buckets) || !state.filters.buckets.length) {
      state.filters.buckets = BUCKETS.map((b) => b.key);
    }
  } catch {
    /* 壊れていたら初期値のまま */
  }
  dom.search.value = state.filters.search;
  dom.mineOnly.checked = state.filters.mineOnly;
  dom.hideBots.checked = state.filters.hideBots;
  dom.hideDrafts.checked = state.filters.hideDrafts;
}

/* ---------------- 自動更新 ---------------- */

let refreshTimer = null;
let countdownTimer = null;

function resetAutoRefresh() {
  clearInterval(refreshTimer);
  clearInterval(countdownTimer);
  const seconds = state.data?.settings?.refreshSeconds ?? 0;
  if (!dom.autoRefresh.checked || seconds <= 0) {
    dom.autoRefreshLabel.textContent = '自動';
    return;
  }
  let remaining = seconds;
  dom.autoRefreshLabel.textContent = `自動 ${remaining}s`;
  countdownTimer = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    dom.autoRefreshLabel.textContent = `自動 ${remaining}s`;
  }, 1000);
  refreshTimer = setTimeout(() => {
    if (document.visibilityState === 'visible') load({ refresh: true });
    else resetAutoRefresh(); // 非表示タブでは叩かず待ち直す
  }, seconds * 1000);
}

/* ---------------- テーマ ---------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* noop */
  }
}

/* ---------------- 起動 ---------------- */

restoreFilters();
applyTheme(localStorage.getItem(THEME_KEY) ?? 'auto');

dom.refresh.addEventListener('click', () => load({ refresh: true }));
dom.autoRefresh.addEventListener('change', resetAutoRefresh);
dom.theme.addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(document.documentElement.dataset.theme) + 1) % order.length];
  applyTheme(next);
  dom.theme.title = `テーマ: ${next}`;
});
dom.repoFilter.addEventListener('change', () => {
  state.filters.repo = dom.repoFilter.value;
  saveFilters();
  render();
});
dom.search.addEventListener('input', () => {
  state.filters.search = dom.search.value;
  saveFilters();
  render();
});
for (const key of ['mineOnly', 'hideBots', 'hideDrafts']) {
  dom[key].addEventListener('change', () => {
    state.filters[key] = dom[key].checked;
    saveFilters();
    render();
  });
}
dom.expandAll.addEventListener('click', () => {
  const visible = applyFilters(state.data?.pullRequests ?? []);
  if (visible.every((pr) => state.open.has(pr.id))) state.open.clear();
  else for (const pr of visible) state.open.add(pr.id);
  render();
});
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select, textarea')) return;
  if (event.key === 'r') load({ refresh: true });
});

load();
