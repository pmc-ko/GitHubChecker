// ダッシュボードの描画。
//
// 表示の意味づけ（ラベル・記号・色）と、ピボットの軸は先頭の定義テーブルに集約してある。
// 「この表示をこう変えたい」は基本そこを直すだけで済むようにしてある。
//   BUCKETS / CI_STATE / REVIEW_STATE / CHECK_ICON / REVIEW_ITEM … 見た目の意味づけ
//   DIMENSIONS                                                  … カンバンの行/列に選べる軸
// DOM は textContent 経由で組み立てる（PRタイトル等をそのままHTMLにしない）。

/* ---------------- 表示定義（ここを触れば見た目の意味づけが変わる） ---------------- */

/** バケット = 「状態」軸の値。src/summarize.mjs の classify() と key を一致させる */
const BUCKETS = [
  { key: 'action', label: '対応が必要', tone: 'critical', hint: '誰かが手を動かさないと進まない' },
  { key: 'mergeable', label: 'マージ可', tone: 'good', hint: '承認済み & CI通過 & Draftでない' },
  { key: 'waiting', label: '待ち', tone: 'warning', hint: 'CI実行中 / レビュー待ち' },
  { key: 'other', label: 'その他', tone: 'idle', hint: 'Draft・レビュー依頼前など' },
];

/** 「状態」軸を並べる順。ここを並べ替えると列（または行）の順が変わる */
const BUCKET_ORDER = ['action', 'waiting', 'mergeable', 'other'];

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
const CHECK_ICON = { success: '✔', failure: '✕', pending: '◐', cancelled: '⊘', skipped: '·', neutral: '–' };

/** 個別レビューの表示 */
const REVIEW_ITEM = {
  APPROVED: { label: '承認', icon: '✔', tone: 'good' },
  CHANGES_REQUESTED: { label: '変更要求', icon: '✕', tone: 'serious' },
  COMMENTED: { label: 'コメント', icon: '≡', tone: 'idle' },
  DISMISSED: { label: '棄却', icon: '⊘', tone: 'idle' },
  PENDING: { label: '下書き', icon: '·', tone: 'idle' },
};

/**
 * カンバンの行/列に選べる軸。
 *   of(pr)      : その PR が属するグループ → { key, label, tone?, icon? }
 *   order       : 固定の並び順（省略時は件数の多い順）
 *   alwaysShow  : 0件のグループも列/行として出す
 * 軸を増やしたいときはここに1エントリ足すだけでよい（UI の選択肢は自動で増える）。
 */
const DIMENSIONS = [
  {
    key: 'bucket',
    label: '状態',
    order: BUCKET_ORDER,
    alwaysShow: true,
    of: (pr) => {
      const bucket = BUCKETS.find((b) => b.key === pr.bucket) ?? BUCKETS[BUCKETS.length - 1];
      return { key: bucket.key, label: bucket.label, tone: bucket.tone, hint: bucket.hint };
    },
  },
  {
    key: 'ci',
    label: 'Actions',
    order: ['failure', 'pending', 'cancelled', 'success', 'neutral', 'none'],
    of: (pr) => {
      const spec = CI_STATE[pr.ci.state] ?? CI_STATE.none;
      return { key: pr.ci.state, label: spec.label, tone: spec.tone, icon: spec.icon };
    },
  },
  {
    key: 'review',
    label: 'レビュー',
    order: ['changes_requested', 'review_required', 'commented', 'approved', 'none'],
    of: (pr) => {
      const spec = REVIEW_STATE[pr.review.state] ?? REVIEW_STATE.none;
      return { key: pr.review.state, label: spec.label, tone: spec.tone, icon: spec.icon };
    },
  },
  { key: 'repo', label: 'リポジトリ', of: (pr) => ({ key: pr.repo, label: shortRepo(pr.repo) }) },
  { key: 'author', label: '作成者', of: (pr) => ({ key: pr.author, label: pr.author }) },
  { key: 'base', label: 'ベースブランチ', of: (pr) => ({ key: pr.baseRefName, label: pr.baseRefName }) },
  {
    key: 'owner',
    label: '自分/他人',
    order: ['mine', 'others'],
    of: (pr) => (pr.isMine ? { key: 'mine', label: '自分のPR' } : { key: 'others', label: '他の人のPR' }),
  },
  {
    key: 'draft',
    label: 'Draft',
    order: ['ready', 'draft'],
    of: (pr) => (pr.isDraft ? { key: 'draft', label: 'Draft' } : { key: 'ready', label: 'Ready' }),
  },
  {
    key: 'reviewer',
    label: 'レビュー依頼先',
    // 依頼先が複数いる場合は先頭の1人で代表させる（1カード=1グループに収めるため）
    of: (pr) => {
      const requested = pr.review.requested[0];
      if (requested) return { key: requested.login, label: requested.login };
      return { key: '_none', label: '依頼なし' };
    },
  },
  /** 行の軸で「なし」を選ぶと単純なカンバン（1段）になる */
  { key: 'none', label: '（なし）', order: ['_all'], of: () => ({ key: '_all', label: 'すべて' }) },
];

const VIEWS = [
  { key: 'board', label: 'カンバン' },
  { key: 'list', label: 'リスト' },
];

/* ---------------- 状態 ---------------- */

const FILTER_KEY = 'pr-monitor-filters';
const PREFS_KEY = 'pr-monitor-prefs';
const THEME_KEY = 'pr-monitor-theme';

const state = {
  data: null,
  error: null,
  loading: false,
  /** 'board' | 'list' */
  view: 'board',
  /** カンバンの軸 */
  pivot: { cols: 'bucket', rows: 'none' },
  /** 展開中のPRのid */
  open: new Set(),
  /** リポジトリ編集欄の未保存内容（null = サーバの値を表示中） */
  repoDraft: null,
  repoStatus: '',
  filters: {
    buckets: BUCKETS.map((b) => b.key),
    repo: '',
    search: '',
    mineOnly: false,
    hideBots: false,
    hideDrafts: false,
  },
};

const dom = {};
for (const id of [
  'viewer', 'fetched', 'refresh', 'autoRefresh', 'autoRefreshLabel', 'theme', 'viewToggle',
  'banner', 'kpis', 'bucketFilter', 'repoFilter', 'search', 'mineOnly', 'hideBots', 'hideDrafts',
  'expandAll', 'list', 'footerInfo', 'pivotControls', 'colDim', 'rowDim', 'swapDims',
  'repoPanel', 'repoSummary', 'repoText', 'repoSave', 'repoReset', 'repoStatus',
]) {
  dom[id] = document.getElementById(id);
}

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
  return iso ? new Date(iso).toLocaleString('ja-JP', { hour12: false }) : '';
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

function dimension(key) {
  return DIMENSIONS.find((d) => d.key === key) ?? DIMENSIONS[0];
}

function badge(spec, extraText) {
  return el('span', { class: 'badge', dataset: { tone: spec.tone }, title: extraText ?? spec.label }, [
    el('span', { class: 'icon', 'aria-hidden': 'true', text: spec.icon }),
    el('span', { text: spec.label }),
  ]);
}

/**
 * カード/行の左端の色。行や列で分かる軸とは別に「深刻さ」を示す。
 * 例: 「対応が必要」列の中でも CI 失敗・コンフリクトは赤、変更要求はオレンジ。
 */
function cardTone(pr) {
  if (pr.ci.state === 'failure' || pr.hasConflict) return 'critical';
  if (pr.review.state === 'changes_requested') return 'serious';
  if (pr.ci.state === 'pending' || pr.review.state === 'review_required') return 'warning';
  if (pr.review.state === 'approved' && (pr.ci.state === 'success' || pr.ci.state === 'none')) return 'good';
  return 'idle';
}

const stopClick = (event) => event.stopPropagation();

/** クリック / Enter / Space で詳細を開閉する */
function bindToggle(node, pr) {
  const toggle = () => {
    if (state.open.has(pr.id)) state.open.delete(pr.id);
    else state.open.add(pr.id);
    render();
  };
  node.addEventListener('click', toggle);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
}

/** CI の細いバーと「n/m」 */
function ciMeter(pr, tone) {
  const ratio = pr.ci.relevant > 0 ? Math.round((pr.ci.passed / pr.ci.relevant) * 100) : 0;
  return el('div', { class: 'cell-sub' }, [
    pr.ci.total
      ? el('div', { class: 'meter', dataset: { tone }, role: 'presentation' }, [el('span', { style: `width:${ratio}%` })])
      : null,
    el('span', { text: pr.ci.total ? `${pr.ci.passed}/${pr.ci.relevant}` : 'チェックなし' }),
    pr.ci.failing.length ? el('span', { text: `失敗 ${pr.ci.failing.length}` }) : null,
    pr.ci.running.length ? el('span', { text: `実行中 ${pr.ci.running.length}` }) : null,
  ]);
}

function reviewSummaryText(pr) {
  return (
    [
      pr.review.counts.approved ? `承認 ${pr.review.counts.approved}` : null,
      pr.review.counts.changesRequested ? `変更要求 ${pr.review.counts.changesRequested}` : null,
      pr.review.counts.commented ? `コメント ${pr.review.counts.commented}` : null,
      pr.review.counts.requested ? `依頼中 ${pr.review.counts.requested}` : null,
    ]
      .filter(Boolean)
      .join(' / ') || 'レビューなし'
  );
}

function reviewerAvatars(pr, limit = 5) {
  return el(
    'span',
    { class: 'avatars' },
    [...pr.review.reviewers, ...pr.review.requested].slice(0, limit).map((person) =>
      person.avatarUrl
        ? el('img', { src: person.avatarUrl, alt: person.login, title: person.login, loading: 'lazy' })
        : el('span', { class: 'team', text: person.login })
    )
  );
}

/* ---------------- データ取得 / 更新 ---------------- */

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

/** 監視リポジトリを保存する（config.json がサーバ側で書き換わる） */
async function saveRepos(lines) {
  const repos = lines
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  state.repoStatus = '保存中…';
  render();
  try {
    const response = await fetch('/api/config/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repos }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
    state.repoDraft = null;
    state.filters.repo = ''; // 消えたリポジトリで絞ったままにならないように解除
    saveFilters();
    // 再取得は数秒かかるので、保存できたことは先に出す
    state.repoStatus = `保存しました（${payload.repos.length} リポジトリ）。再取得中…`;
    render();
    await load({ refresh: true });
    state.repoStatus = `保存しました（${payload.repos.length} リポジトリ）`;
    renderRepoEditor();
  } catch (err) {
    state.repoStatus = `保存できませんでした: ${err.message}`;
    render();
  }
}

/* ---------------- 描画 ---------------- */

function renderSkeleton() {
  dom.list.className = 'list';
  dom.list.replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'skeleton' })));
}

function render() {
  renderBanner();
  renderMeta();
  renderViewToggle();
  renderPivotControls();
  renderRepoOptions();
  renderRepoEditor();
  const visible = applyFilters(state.data?.pullRequests ?? []);
  renderKpis();
  renderBucketFilter();
  renderCollection(visible);
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

function renderViewToggle() {
  dom.viewToggle.replaceChildren(
    ...VIEWS.map((view) =>
      el('button', {
        type: 'button',
        class: 'segment',
        'aria-pressed': String(state.view === view.key),
        text: view.label,
        onclick: () => {
          state.view = view.key;
          savePrefs();
          render();
        },
      })
    )
  );
}

function renderPivotControls() {
  dom.pivotControls.hidden = state.view !== 'board';
  if (state.view !== 'board') return;

  const select = (id, current) => {
    const node = dom[id];
    node.replaceChildren(
      ...DIMENSIONS.map((dim) => el('option', { value: dim.key, text: dim.label, selected: dim.key === current }))
    );
    node.value = current;
  };
  select('colDim', state.pivot.cols);
  select('rowDim', state.pivot.rows);
}

function renderRepoOptions() {
  const repos = state.data?.repos ?? [];
  const current = state.filters.repo;
  dom.repoFilter.replaceChildren(
    el('option', { value: '', text: `全リポジトリ (${repos.length})` }),
    ...repos.map((repo) =>
      el('option', {
        value: repo.nameWithOwner,
        text: `${shortRepo(repo.nameWithOwner)} (${repo.count})`,
        selected: repo.nameWithOwner === current,
      })
    )
  );
  dom.repoFilter.value = repos.some((r) => r.nameWithOwner === current) ? current : '';
}

function renderRepoEditor() {
  const repos = state.data?.settings?.repos ?? [];
  dom.repoSummary.textContent = `監視リポジトリ（${repos.length}）`;
  // 入力中の内容を上書きしない
  if (state.repoDraft === null) dom.repoText.value = repos.join('\n');
  dom.repoStatus.textContent = state.repoStatus;
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
    ...BUCKET_ORDER.map((key) => BUCKETS.find((b) => b.key === key))
      .filter(Boolean)
      .map((bucket) => {
        const count = pullRequests.filter((pr) => pr.bucket === bucket.key).length;
        const active = state.filters.buckets.includes(bucket.key);
        return el(
          'button',
          {
            type: 'button',
            class: 'bucket-chip',
            title: bucket.hint,
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

/** 軸でグループ化する */
function groupBy(pullRequests, dim) {
  const map = new Map();
  for (const pr of pullRequests) {
    const group = dim.of(pr);
    if (!map.has(group.key)) map.set(group.key, { ...group, items: [] });
    map.get(group.key).items.push(pr);
  }

  // order 指定があれば 0件のグループも並べる（alwaysShow のときだけ）
  if (dim.alwaysShow && dim.order) {
    for (const key of dim.order) {
      if (!map.has(key)) {
        const template = key === '_all' ? { key, label: 'すべて' } : labelForKey(dim, key);
        map.set(key, { ...template, items: [] });
      }
    }
  }

  const groups = [...map.values()];
  const rank = (key) => {
    const index = dim.order?.indexOf(key) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  groups.sort(
    (a, b) =>
      rank(a.key) - rank(b.key) ||
      b.items.length - a.items.length ||
      String(a.label).localeCompare(String(b.label), 'ja')
  );
  return groups;
}

/** 0件グループのラベルを引く（BUCKETS/CI_STATE などの定義から） */
function labelForKey(dim, key) {
  if (dim.key === 'bucket') {
    const bucket = BUCKETS.find((b) => b.key === key);
    return bucket ? { key, label: bucket.label, tone: bucket.tone, hint: bucket.hint } : { key, label: key };
  }
  if (dim.key === 'ci') {
    const spec = CI_STATE[key];
    return spec ? { key, label: spec.label, tone: spec.tone, icon: spec.icon } : { key, label: key };
  }
  if (dim.key === 'review') {
    const spec = REVIEW_STATE[key];
    return spec ? { key, label: spec.label, tone: spec.tone, icon: spec.icon } : { key, label: key };
  }
  return { key, label: key };
}

function renderCollection(pullRequests) {
  if (!state.data) return;

  if (!pullRequests.length) {
    dom.list.className = 'list';
    dom.list.replaceChildren(
      el('p', {
        class: 'empty',
        text: state.data.pullRequests.length ? '絞り込み条件に合うPRがありません。' : '表示できるPRがありません。',
      })
    );
    return;
  }

  if (state.view === 'board') renderBoard(pullRequests);
  else renderRows(pullRequests);
}

/* ---------------- カンバン（ピボット） ---------------- */

function renderBoard(pullRequests) {
  const colDim = dimension(state.pivot.cols);
  const rowDim = dimension(state.pivot.rows);
  const hasRowHead = rowDim.key !== 'none';

  const cols = groupBy(pullRequests, colDim);
  const rows = hasRowHead ? groupBy(pullRequests, rowDim) : [{ key: '_all', label: 'すべて', items: pullRequests }];
  // カードにリポジトリ名を出すかどうか（行/列がリポジトリなら重複するので省く）
  const showRepo = colDim.key !== 'repo' && rowDim.key !== 'repo';

  const grid = el('div', {
    class: 'pivot',
    dataset: { rowhead: String(hasRowHead) },
    style: `--cols:${cols.length}`,
  });

  if (hasRowHead) {
    grid.append(el('div', { class: 'pivot-corner', text: `${rowDim.label} × ${colDim.label}` }));
  }
  for (const col of cols) {
    grid.append(
      el('div', { class: 'pivot-colhead', dataset: { tone: col.tone ?? 'idle' }, title: col.hint ?? col.label }, [
        el('span', { class: 'dot', dataset: { tone: col.tone ?? 'idle' }, 'aria-hidden': 'true' }),
        el('span', { class: 'pivot-colhead-label', text: col.label }),
        el('span', { class: 'pivot-count', text: String(col.items.length) }),
      ])
    );
  }

  for (const row of rows) {
    if (hasRowHead) {
      grid.append(
        el('div', { class: 'pivot-rowhead' }, [
          el('span', { class: 'pivot-rowhead-label', text: row.label, title: row.label }),
          el('span', { class: 'pivot-count', text: String(row.items.length) }),
        ])
      );
    }
    for (const col of cols) {
      const items = row.items.filter((pr) => colDim.of(pr).key === col.key);
      grid.append(
        el(
          'div',
          { class: 'pivot-cell' },
          items.length ? items.map((pr) => renderCard(pr, { showRepo })) : [el('p', { class: 'pivot-empty', text: '—' })]
        )
      );
    }
  }

  dom.list.className = 'board-wrap';
  dom.list.replaceChildren(grid);
}

function renderCard(pr, { showRepo = true } = {}) {
  const ci = CI_STATE[pr.ci.state] ?? CI_STATE.none;
  const review = REVIEW_STATE[pr.review.state] ?? REVIEW_STATE.none;
  const tone = cardTone(pr);
  const isOpen = state.open.has(pr.id);

  const body = el('div', { class: 'card-body', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) }, [
    el('div', { class: 'card-top' }, [
      showRepo ? el('span', { class: 'pr-repo', text: shortRepo(pr.repo) }) : null,
      el('a', {
        class: 'pr-number',
        href: pr.url,
        target: '_blank',
        rel: 'noreferrer',
        text: `#${pr.number}`,
        onclick: stopClick,
      }),
      pr.isDraft ? el('span', { class: 'card-flag', text: 'Draft' }) : null,
      pr.isMine ? el('span', { class: 'card-flag', text: '自分' }) : null,
      pr.hasConflict ? el('span', { class: 'card-flag', dataset: { tone: 'critical' }, text: '⚠ コンフリクト' }) : null,
      el('span', { class: 'card-spacer' }),
      el('span', { class: 'card-time', title: absoluteTime(pr.updatedAt), text: relativeTime(pr.updatedAt) }),
    ]),
    el('a', {
      class: 'card-title',
      href: pr.url,
      target: '_blank',
      rel: 'noreferrer',
      text: pr.title,
      title: pr.title,
      onclick: stopClick,
    }),
    el('div', { class: 'card-badges' }, [badge(ci), badge(review)]),
    ciMeter(pr, ci.tone),
    el('div', { class: 'card-foot' }, [
      pr.authorAvatarUrl ? el('img', { class: 'avatar', src: pr.authorAvatarUrl, alt: '', loading: 'lazy' }) : null,
      el('span', { class: 'card-author', text: pr.author }),
      el('span', { class: 'card-diff', text: `+${pr.additions} −${pr.deletions}` }),
      el('span', { class: 'card-spacer' }),
      reviewerAvatars(pr, 4),
    ]),
  ]);

  bindToggle(body, pr);

  return el('article', { class: 'card', dataset: { tone, open: String(isOpen) } }, [
    body,
    isOpen ? renderDetails(pr) : null,
  ]);
}

/* ---------------- リスト ---------------- */

function renderRows(pullRequests) {
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
  dom.list.className = 'list';
  dom.list.replaceChildren(...children);
}

function renderPr(pr) {
  const ci = CI_STATE[pr.ci.state] ?? CI_STATE.none;
  const review = REVIEW_STATE[pr.review.state] ?? REVIEW_STATE.none;
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
        onclick: stopClick,
      }),
      el('a', {
        class: 'pr-title',
        href: pr.url,
        target: '_blank',
        rel: 'noreferrer',
        text: pr.title,
        onclick: stopClick,
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

  const ciCell = el('div', { class: 'cell cell-ci' }, [badge(ci, `${ci.label} (${pr.ci.state})`), ciMeter(pr, ci.tone)]);

  const reviewCell = el('div', { class: 'cell cell-review' }, [
    badge(review, pr.review.decision ? `reviewDecision: ${pr.review.decision}` : 'ブランチ保護のレビュー必須設定なし'),
    el('div', { class: 'cell-sub' }, [el('span', { text: reviewSummaryText(pr) }), reviewerAvatars(pr, 5)]),
  ]);

  const row = el(
    'div',
    { class: 'pr-row', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) },
    [head, ciCell, reviewCell, el('span', { class: 'chevron', 'aria-hidden': 'true', text: '▶' })]
  );
  bindToggle(row, pr);

  return el('article', { class: 'pr', dataset: { tone: cardTone(pr), open: String(isOpen) } }, [
    row,
    isOpen ? renderDetails(pr) : null,
  ]);
}

/* ---------------- 詳細（カード/行 共通） ---------------- */

function renderDetails(pr) {
  const order = { failure: 0, pending: 1, cancelled: 2, neutral: 3, success: 4, skipped: 5 };
  const checks = [...pr.checks].sort(
    (a, b) =>
      (order[a.state] ?? 9) - (order[b.state] ?? 9) ||
      (a.workflow ?? '').localeCompare(b.workflow ?? '') ||
      a.name.localeCompare(b.name)
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
                  ? el('a', { href: check.url, target: '_blank', rel: 'noreferrer', text: check.name, onclick: stopClick })
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
      ? el('p', {
          class: 'detail-note',
          text: `最新コミット: ${pr.headCommit.messageHeadline}（${relativeTime(pr.headCommit.committedDate)}）`,
        })
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
                ? el('a', { href: reviewer.url, target: '_blank', rel: 'noreferrer', text: reviewer.login, onclick: stopClick })
                : el('span', { text: reviewer.login }),
              badge(spec),
              el('time', {
                datetime: reviewer.submittedAt ?? '',
                title: absoluteTime(reviewer.submittedAt),
                text: relativeTime(reviewer.submittedAt),
              }),
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
    el('p', { class: 'detail-note', text: `判定: ${pr.statusLabels.join(' / ')} · ${reviewSummaryText(pr)}` }),
    el('p', { class: 'detail-note', text: `${pr.headRefName} → ${pr.baseRefName} · ${pr.changedFiles}ファイル変更` }),
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
  state.filters.buckets = buckets.size
    ? BUCKETS.filter((b) => buckets.has(b.key)).map((b) => b.key)
    : BUCKETS.map((b) => b.key);
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

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view: state.view, pivot: state.pivot }));
  } catch {
    /* noop */
  }
}

function restorePreferences() {
  try {
    const savedFilters = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    Object.assign(state.filters, savedFilters);
    if (!Array.isArray(state.filters.buckets) || !state.filters.buckets.length) {
      state.filters.buckets = BUCKETS.map((b) => b.key);
    }
  } catch {
    /* 壊れていたら初期値のまま */
  }
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    if (VIEWS.some((v) => v.key === prefs.view)) state.view = prefs.view;
    if (prefs.pivot && DIMENSIONS.some((d) => d.key === prefs.pivot.cols)) state.pivot.cols = prefs.pivot.cols;
    if (prefs.pivot && DIMENSIONS.some((d) => d.key === prefs.pivot.rows)) state.pivot.rows = prefs.pivot.rows;
  } catch {
    /* noop */
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
  clearTimeout(refreshTimer);
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
  dom.theme.title = `テーマ: ${theme}`;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* noop */
  }
}

/* ---------------- 起動 ---------------- */

restorePreferences();
applyTheme(localStorage.getItem(THEME_KEY) ?? 'auto');

dom.refresh.addEventListener('click', () => load({ refresh: true }));
dom.autoRefresh.addEventListener('change', resetAutoRefresh);
dom.theme.addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  applyTheme(order[(order.indexOf(document.documentElement.dataset.theme) + 1) % order.length]);
});
dom.colDim.addEventListener('change', () => {
  state.pivot.cols = dom.colDim.value;
  savePrefs();
  render();
});
dom.rowDim.addEventListener('change', () => {
  state.pivot.rows = dom.rowDim.value;
  savePrefs();
  render();
});
dom.swapDims.addEventListener('click', () => {
  state.pivot = { cols: state.pivot.rows, rows: state.pivot.cols };
  savePrefs();
  render();
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
dom.repoText.addEventListener('input', () => {
  state.repoDraft = dom.repoText.value;
  state.repoStatus = '未保存の変更があります';
  dom.repoStatus.textContent = state.repoStatus;
});
dom.repoSave.addEventListener('click', () => saveRepos(dom.repoText.value));
dom.repoReset.addEventListener('click', () => {
  state.repoDraft = null;
  state.repoStatus = '';
  render();
});
document.addEventListener('keydown', (event) => {
  if (event.target.matches?.('input, select, textarea')) return;
  if (event.key === 'r') load({ refresh: true });
});

load();
