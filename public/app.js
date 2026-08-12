// ダッシュボードの描画。
//
// アイコンは Material Symbols（`public/icons.js` = 生成物）。名前で参照する。
// 表示の意味づけ（ラベル・記号・色）と、ピボットの軸は先頭の定義テーブルに集約してある。
// 「この表示をこう変えたい」は基本そこを直すだけで済むようにしてある。
//   BUCKETS / CI_STATE / REVIEW_STATE / CHECK_ICON / REVIEW_ITEM … 見た目の意味づけ
//   DIMENSIONS                                                  … カンバンの行/列に選べる軸
// DOM は textContent 経由で組み立てる（PRタイトル等をそのままHTMLにしない）。

import { ICON_PATHS, ICON_VIEWBOX } from './icons.js';

/* ---------------- 表示定義（ここを触れば見た目の意味づけが変わる） ---------------- */

/**
 * バケット = 「状態」軸の値。src/summarize.mjs の classify() と key を一致させる。
 * issue だけは classify() を通らず summarizeIssue() が付ける（PR が無い Issue）。
 */
const BUCKETS = [
  { key: 'action', label: '対応が必要', tone: 'critical', hint: '誰かが手を動かさないと進まない' },
  { key: 'mergeable', label: 'マージ可', tone: 'good', hint: '承認済み & CI通過 & Draftでない' },
  { key: 'waiting', label: '待ち', tone: 'warning', hint: 'CI実行中 / レビュー待ち' },
  { key: 'other', label: 'その他', tone: 'idle', hint: 'Draft・レビュー依頼前など' },
  { key: 'issue', label: 'Issue（PRなし）', tone: 'idle', hint: 'PR がまだ無い Issue = 未着手' },
];

/** 「状態」軸を並べる順。ここを並べ替えると列（や行）の順が変わる */
const BUCKET_ORDER = ['action', 'waiting', 'mergeable', 'other', 'issue'];

/**
 * PR と Issue の紐づき（3パターン）。key は src/summarize.mjs の LINK_STATE と一致させる。
 * グラフの色（--series-*）もこの順に対応する。色だけで意味を伝えないようアイコン+文字を必ず添える。
 */
const LINK_ITEM = {
  'issue-only': { label: 'Issueのみ', icon: 'radio_button_unchecked', series: 2, hint: 'PR がまだ無い Issue（未着手）' },
  both: { label: 'Issue+PR', icon: 'link', series: 1, hint: 'Issue に PR が紐づいている（進行中）' },
  'pr-only': { label: 'PRのみ', icon: 'call_split', series: 3, hint: 'Issue に紐づいていない PR' },
};

/** 3パターンを並べる順（軸・凡例・グラフで共通） */
const LINK_ORDER = ['issue-only', 'both', 'pr-only'];

/** Actions（チェック）の全体状態。icon は Material Symbols の名前（public/icons.js） */
const CI_STATE = {
  success: { label: 'CI成功', icon: 'check_circle', tone: 'good' },
  failure: { label: 'CI失敗', icon: 'cancel', tone: 'critical' },
  pending: { label: 'CI実行中', icon: 'hourglass_top', tone: 'warning' },
  cancelled: { label: 'CI中断', icon: 'block', tone: 'idle' },
  neutral: { label: 'CI対象外', icon: 'remove', tone: 'idle' },
  none: { label: 'CIなし', icon: 'remove', tone: 'idle' },
};

/** レビュー結果のサマリ状態 */
const REVIEW_STATE = {
  approved: { label: '承認済み', icon: 'check_circle', tone: 'good' },
  changes_requested: { label: '変更要求', icon: 'error', tone: 'serious' },
  review_required: { label: 'レビュー待ち', icon: 'schedule', tone: 'warning' },
  commented: { label: 'コメントのみ', icon: 'chat_bubble', tone: 'idle' },
  none: { label: '未レビュー', icon: 'remove', tone: 'idle' },
};

/** 個別チェックのアイコン */
const CHECK_ICON = {
  success: 'check_circle',
  failure: 'cancel',
  pending: 'hourglass_top',
  cancelled: 'block',
  skipped: 'horizontal_rule',
  neutral: 'remove',
};

/** 個別レビューの表示 */
const REVIEW_ITEM = {
  APPROVED: { label: '承認', icon: 'check_circle', tone: 'good' },
  CHANGES_REQUESTED: { label: '変更要求', icon: 'error', tone: 'serious' },
  COMMENTED: { label: 'コメント', icon: 'chat_bubble', tone: 'idle' },
  DISMISSED: { label: '棄却', icon: 'block', tone: 'idle' },
  PENDING: { label: '下書き', icon: 'edit_note', tone: 'idle' },
};

/**
 * カンバンの行/列に選べる軸。
 *   of(item)    : その PR / Issue が属するグループ → { key, label, tone?, icon? }
 *   many        : 1件が複数グループに入る軸（ラベルなど）。of() が配列を返す
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
  {
    key: 'link',
    label: 'Issue連携',
    order: LINK_ORDER,
    alwaysShow: true,
    of: (item) => {
      const spec = LINK_ITEM[item.link] ?? LINK_ITEM['pr-only'];
      return { key: item.link, label: spec.label, icon: spec.icon, hint: spec.hint };
    },
  },
  {
    key: 'milestone',
    label: 'マイルストン',
    of: (item) => {
      const title = milestoneTitleOf(item);
      return title ? { key: title, label: title } : { key: '_none', label: 'マイルストンなし' };
    },
  },
  {
    key: 'label',
    label: 'ラベル',
    // 1件が複数ラベルを持つので、その全部のグループに出す（合計は件数より多くなる）
    many: true,
    of: (item) =>
      item.labels.length
        ? item.labels.map((label) => ({ key: label.name, label: label.name }))
        : [{ key: '_none', label: 'ラベルなし' }],
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
  /** 監視 OFF にしたリポジトリの未保存状態（null = サーバの値を表示中） */
  repoDisabledDraft: null,
  repoStatus: '',
  filters: {
    buckets: BUCKETS.map((b) => b.key),
    /** 表示するリポジトリ。空配列 = 全部（チェックは全部入った状態で描く） */
    repos: [],
    search: '',
    mineOnly: false,
    hideBots: false,
    hideDrafts: false,
    /** PR が無い Issue を一覧に出さない（Issue連携の3パターンのうち「Issueのみ」を隠す） */
    hideIssues: false,
  },
};

const dom = {};
for (const id of [
  'viewer', 'fetched', 'refresh', 'autoRefresh', 'autoRefreshLabel', 'theme', 'viewToggle',
  'banner', 'kpis', 'bucketFilter', 'repoFilter', 'search', 'mineOnly', 'hideBots', 'hideDrafts', 'hideIssues',
  'progressPanel', 'progressSummary', 'chartLink', 'chartMilestone', 'chartLabel', 'chartApi',
  'expandAll', 'list', 'footerInfo', 'pivotControls', 'colDim', 'rowDim', 'swapDims',
  'repoPanel', 'repoSummary', 'repoToggles', 'repoText', 'repoSave', 'repoReset', 'repoStatus', 'configPath',
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

/**
 * 子要素を差し替える。**null / undefined を必ず落とす**こと。
 * 素の replaceChildren(null) は文字列 "null" を挿入してしまうため、条件付きの子は必ずこれを通す。
 */
function setChildren(node, children) {
  node.replaceChildren(...[].concat(children).filter((child) => child !== null && child !== undefined && child !== false));
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

/** 軸の of() は1件でも配列でも返せる（many 軸）。呼ぶ側は必ずこれを通す */
function groupsOf(dim, item) {
  const result = dim.of(item);
  return Array.isArray(result) ? result : [result];
}

/** その PR / Issue のマイルストン名。PR 自体に無ければ紐づく Issue のものを使う */
function milestoneTitleOf(item) {
  if (item.milestone?.title) return item.milestone.title;
  return item.issues?.find((issue) => issue.milestone?.title)?.milestone?.title ?? null;
}

/** いま一覧に出す対象。PR と（除外していなければ）PR が無い Issue */
function allItems() {
  const data = state.data;
  if (!data) return [];
  const prs = data.pullRequests ?? [];
  if (state.filters.hideIssues) return prs;
  return [...prs, ...(data.issues ?? [])];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Material Symbols のアイコン1つ。塗りは currentColor なので色は CSS 側で決まる */
function icon(name, { size = 16 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mi');
  svg.setAttribute('viewBox', ICON_VIEWBOX);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS.remove);
  svg.append(path);
  return svg;
}

function badge(spec, extraText) {
  return el('span', { class: 'badge', dataset: { tone: spec.tone }, title: extraText ?? spec.label }, [
    icon(spec.icon),
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

/** Issue連携のバッジ。色はグラフと同じ系列色を使い、アイコン+文字も必ず出す */
function linkBadge(item) {
  const spec = LINK_ITEM[item.link] ?? LINK_ITEM['pr-only'];
  return el('span', { class: 'badge badge-series', dataset: { series: String(spec.series) }, title: spec.hint }, [
    icon(spec.icon),
    el('span', { text: spec.label }),
  ]);
}

/**
 * カード1段目の状況アイコン。アイコンの「形」で意味が分かるようにし、
 * 語（CI成功/変更要求…）は tooltip と詳細で出す（色だけに意味を持たせない）。
 */
function statusIcons(item) {
  const icons = [];
  const add = (spec, extra) =>
    icons.push(
      el(
        'span',
        {
          class: 'status-icon',
          dataset: spec.series ? { series: String(spec.series) } : { tone: spec.tone },
          title: `${spec.label}${extra ? ` — ${extra}` : ''}`,
        },
        [icon(spec.icon, { size: 15 })]
      )
    );

  if (item.kind !== 'issue') {
    const ci = CI_STATE[item.ci.state] ?? CI_STATE.none;
    add(ci, item.ci.total ? `${item.ci.passed}/${item.ci.relevant} 通過` : 'チェックなし');
    const review = REVIEW_STATE[item.review.state] ?? REVIEW_STATE.none;
    add(review, reviewSummaryText(item));
  }
  const link = LINK_ITEM[item.link] ?? LINK_ITEM['pr-only'];
  add(link, link.hint);
  if (item.hasConflict) add({ label: 'コンフリクト', icon: 'warning', tone: 'critical' }, 'マージ前に解消が必要');

  return el('span', { class: 'card-icons', role: 'img', 'aria-label': '状況' }, icons);
}

/** 1段目に置く細い CI 進捗バー。チェックが無いときは何も出さない */
function ciMeterInline(pr) {
  if (!pr.ci.total) return null;
  const ratio = pr.ci.relevant > 0 ? Math.round((pr.ci.passed / pr.ci.relevant) * 100) : 0;
  const tone = (CI_STATE[pr.ci.state] ?? CI_STATE.none).tone;
  const failing = pr.ci.failing.length ? ` / 失敗 ${pr.ci.failing.length}` : '';
  const running = pr.ci.running.length ? ` / 実行中 ${pr.ci.running.length}` : '';
  return el('span', { class: 'meter-inline', title: `チェック ${pr.ci.passed}/${pr.ci.relevant} 通過${failing}${running}` }, [
    el('span', { class: 'meter', dataset: { tone }, role: 'presentation' }, [el('span', { style: `width:${ratio}%` })]),
    el('span', { class: 'meter-value', text: `${pr.ci.passed}/${pr.ci.relevant}` }),
  ]);
}

/** マイルストン / 紐づく Issue / ラベルのチップ列。無ければ何も出さない */
function metaChips(item, { maxLabels = 3 } = {}) {
  const children = metaChipList(item, { maxLabels });
  return children.length ? el('div', { class: 'card-chips' }, children) : null;
}

/** チップの配列（タイトルの続きに流し込みたいので、包まずに返す版） */
function metaChipList(item, { maxLabels = 3 } = {}) {
  const children = [];
  const milestone = milestoneTitleOf(item);
  if (milestone) {
    children.push(
      el('span', { class: 'chip chip-milestone', title: `マイルストン: ${milestone}` }, [
        icon('flag', { size: 12 }),
        el('span', { text: milestone }),
      ])
    );
  }
  for (const issue of item.issues ?? []) {
    children.push(
      el('a', {
        class: 'chip chip-issue',
        href: issue.url,
        target: '_blank',
        rel: 'noreferrer',
        title: `${issue.title}（${issue.state === 'CLOSED' ? 'クローズ済み' : 'オープン'}）`,
        text: `Issue #${issue.number}`,
        onclick: stopClick,
      })
    );
  }
  for (const label of item.labels.slice(0, maxLabels)) {
    children.push(
      el('span', {
        class: 'label-chip',
        title: label.name,
        text: label.name,
        style: `background:#${label.color}22;border:1px solid #${label.color}66`,
      })
    );
  }
  if (item.labels.length > maxLabels) {
    children.push(
      el('span', {
        class: 'chip',
        title: item.labels.map((label) => label.name).join(', '),
        text: `+${item.labels.length - maxLabels}`,
      })
    );
  }
  return children;
}

/** Issue の担当者。PR 側の reviewerAvatars と同じ見た目に揃える */
function assigneeAvatars(item, limit = 5) {
  const assignees = item.assignees ?? [];
  if (!assignees.length) return el('span', { class: 'avatars' }, [el('span', { class: 'team', text: '担当なし' })]);
  return el(
    'span',
    { class: 'avatars' },
    assignees.slice(0, limit).map((person) =>
      person.avatarUrl
        ? el('img', { src: person.avatarUrl, alt: person.login, title: person.login, loading: 'lazy' })
        : el('span', { class: 'team', text: person.login })
    )
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

/**
 * 監視リポジトリを保存する（config.json がサーバ側で書き換わる）。
 * lines = 候補すべて（1行1つ）、チェックを外したものは disabledRepos として送る。
 * 有効/無効の引き算はサーバ側でやる（正規化の基準を1か所に保つ）。
 */
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
      body: JSON.stringify({ repos, disabledRepos: [...disabledRepos()] }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
    state.repoDraft = null;
    state.repoDisabledDraft = null;
    state.filters.repos = []; // 消えたリポジトリで絞ったままにならないように解除
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

/** 取得の頻度・範囲を保存する（config.json が書き換わる）。API 消費を絞るための口 */
async function saveSettings(patch) {
  try {
    const response = await fetch('/api/config/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
    // 反映は次の取得から。取得範囲が変わるのですぐ取り直す
    await load({ refresh: patch.includeIssues !== undefined });
  } catch (err) {
    state.error = `設定を保存できませんでした: ${err.message}`;
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
  renderRepoFilter();
  renderRepoEditor();
  const visible = applyFilters(allItems());
  renderKpis();
  renderProgress(visible);
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
  // 残量が少ないうちに言う（0 になると取得自体が失敗する）
  const rate = state.data?.rateLimit;
  if (rate && rate.remaining < Math.max(500, (rate.fetchCost ?? 0) * 5)) {
    messages.push(
      `GitHub API の残量が少なくなっています（残 ${rate.remaining}/${rate.limit}・1回の取得 ${rate.fetchCost ?? '?'}点・` +
        `リセット ${absoluteTime(rate.resetAt)}）。config.json の refreshSeconds を増やすか、監視リポジトリを減らしてください。`
    );
  }
  for (const repo of state.data?.repos ?? []) {
    if (repo.error) messages.push(`${repo.nameWithOwner}: ${repo.error}`);
    if (repo.issueError) messages.push(`${repo.nameWithOwner}: Issue を取得できませんでした（${repo.issueError}）`);
    // 取り切れていないときは黙って切らずに言う（グラフの母数が変わるため）
    if (repo.issueCount < (repo.issueTotalOpen ?? 0)) {
      messages.push(
        `${repo.nameWithOwner}: オープン Issue ${repo.issueTotalOpen} 件のうち ${repo.issueCount} 件だけ取得しています（config.json の maxIssuesPerRepo）`
      );
    }
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

/** 取得できているリポジトリをチェックボックスで出す（表示の絞り込み。取得は止めない） */
function renderRepoFilter() {
  const repos = state.data?.repos ?? [];
  // 監視から外れたリポジトリで絞ったままになると何も出なくなるので落としておく
  if (repos.length && state.filters.repos.length) {
    const alive = state.filters.repos.filter((name) => repos.some((repo) => repo.nameWithOwner === name));
    if (alive.length !== state.filters.repos.length) {
      state.filters.repos = alive.length < repos.length ? alive : [];
      saveFilters();
    }
  }
  const shown = shownRepos();
  const chip = (label, checked, title, onchange) => {
    const box = el('input', { type: 'checkbox', onchange });
    box.checked = checked;
    return el('label', { class: 'toggle', title }, [box, el('span', { text: label })]);
  };

  // 件数は「いま一覧に出しているもの」に揃える（Issue を含めるかで変わる）
  const items = allItems();
  const countOf = (nameWithOwner) => items.filter((item) => item.repo === nameWithOwner).length;

  dom.repoFilter.replaceChildren(
    chip(`全${repos.length}`, state.filters.repos.length === 0, '全リポジトリを表示', () => {
      state.filters.repos = [];
      saveFilters();
      render();
    }),
    ...repos.map((repo) =>
      chip(
        `${shortRepo(repo.nameWithOwner)} (${countOf(repo.nameWithOwner)})`,
        shown.has(repo.nameWithOwner),
        repo.nameWithOwner,
        () => toggleRepoFilter(repo.nameWithOwner)
      )
    )
  );
}

/** 監視候補（有効 + 無効）。入力欄と ON/OFF はこの並びで作る */
function repoCandidates() {
  const settings = state.data?.settings;
  return [...(settings?.repos ?? []), ...(settings?.disabledRepos ?? [])];
}

/** いま OFF にしているリポジトリ（未保存の変更があればそれを優先） */
function disabledRepos() {
  return state.repoDisabledDraft ?? new Set(state.data?.settings?.disabledRepos ?? []);
}

function renderRepoEditor() {
  const candidates = repoCandidates();
  const disabled = disabledRepos();
  const enabled = candidates.filter((name) => !disabled.has(name));
  dom.repoSummary.textContent =
    candidates.length === enabled.length
      ? `監視リポジトリ（${enabled.length}）`
      : `監視リポジトリ（${enabled.length}/${candidates.length}）`;

  dom.repoToggles.replaceChildren(
    ...candidates.map((name) => {
      const box = el('input', { type: 'checkbox', onchange: () => toggleRepoEnabled(name) });
      box.checked = !disabled.has(name);
      return el('label', { class: 'toggle', title: `${name} の監視を切り替える` }, [box, el('span', { text: name })]);
    })
  );

  // 入力中の内容を上書きしない
  if (state.repoDraft === null) dom.repoText.value = candidates.join('\n');
  dom.repoStatus.textContent = state.repoStatus;

  // 設定ファイルの場所を出す（アプリ版はアプリの外にあるので、ここが分からないと手で直せない）
  const path = state.data?.settings?.configPath;
  dom.configPath.textContent = path ? `設定ファイル: ${path}` : '';
}

function applyFilters(pullRequests) {
  const { buckets, repos, search, mineOnly, hideBots, hideDrafts } = state.filters;
  const needle = search.trim().toLowerCase();
  return pullRequests.filter((pr) => {
    if (!buckets.includes(pr.bucket)) return false;
    if (repos.length && !repos.includes(pr.repo)) return false;
    if (mineOnly && !pr.isMine) return false;
    if (hideBots && isBot(pr.author)) return false;
    if (hideDrafts && pr.isDraft) return false;
    if (needle) {
      const haystack = [
        pr.title,
        pr.author,
        pr.headRefName,
        pr.baseRefName,
        String(pr.number),
        pr.repo,
        milestoneTitleOf(pr),
        ...pr.labels.map((label) => label.name),
        ...(pr.issues ?? []).map((issue) => `#${issue.number} ${issue.title}`),
      ]
        .filter(Boolean)
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
    {
      tone: 'idle',
      label: 'Issue（PRなし）',
      value: stats.issueOnly ?? 0,
      sub: `${LINK_ITEM.both.label} ${stats.both ?? 0} / ${LINK_ITEM['pr-only'].label} ${stats.prOnly ?? 0}`,
    },
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

/* ---------------- 進捗グラフ ---------------- */
// 3枚。どれも「色や長さだけ」に意味を持たせず、件数と % を文字でも出す。
//   Issue連携の内訳 : いま表示中のものを3パターンで積み上げ（1本）
//   マイルストン進捗 : クローズ済み/全体（GitHub の progressPercentage。表示中の絞り込みとは無関係）
//   ラベル別        : 件数の多い順に上位、内訳は同じ3パターンの色

/** ラベル別グラフに出す行数。これを超えた分は件数を添えて「省略」と出す */
const LABEL_ROWS = 8;

const percent = (value, total) => (total ? Math.round((value / total) * 100) : 0);

function renderProgress(visible) {
  const milestones = state.data?.milestones ?? [];
  dom.progressSummary.textContent = `進捗（マイルストン ${milestones.length}）`;
  renderLinkChart(visible);
  renderMilestoneChart();
  renderLabelChart(visible);
  renderApiChart();
}

/** 更新間隔の選択肢（秒）。API 消費は「1回のコスト × 3600/間隔」で決まる */
const REFRESH_CHOICES = [
  { value: 60, label: '1分' },
  { value: 180, label: '3分' },
  { value: 300, label: '5分' },
  { value: 600, label: '10分' },
  { value: 1800, label: '30分' },
  { value: 0, label: '自動更新しない' },
];

/**
 * GitHub API の残量（ドーナツ）と、1時間あたりの消費見積もり、その調整口。
 * 数値は必ず文字でも出す。色だけで「危ない」を伝えないよう、少ないときはアイコン+文字も添える。
 */
function renderApiChart() {
  const rate = state.data?.rateLimit;
  const settings = state.data?.settings ?? {};
  const refresh = Number(settings.refreshSeconds ?? 0);
  const cost = rate?.fetchCost ?? null;
  const perHour = cost !== null && refresh > 0 ? cost * Math.floor(3600 / refresh) : null;

  const ratio = rate ? Math.max(0, Math.min(1, rate.remaining / rate.limit)) : 0;
  const tone = ratio <= 0.1 ? 'critical' : ratio <= 0.25 ? 'warning' : 'bar';

  setChildren(dom.chartApi, [
    el('h2', { class: 'chart-title', text: 'GitHub API の残量（GraphQL）' }),
    el('p', { class: 'chart-note', text: '1時間あたり 5000点。点数は「要求したノード数」で決まる' }),
    rate
      ? el('div', { class: 'api-row' }, [
          el('div', { class: 'donut-wrap', title: `残 ${rate.remaining} / ${rate.limit}` }, [
            donut(ratio, tone),
            el('span', { class: 'donut-center', text: `${Math.round(ratio * 100)}%` }),
          ]),
          el('div', { class: 'api-facts' }, [
            el('p', {}, [
              tone === 'bar'
                ? null
                : el('span', { class: 'status-icon', dataset: { tone: tone === 'critical' ? 'critical' : 'warning' } }, [
                    icon('warning', { size: 14 }),
                  ]),
              el('span', { class: 'api-value', text: `残 ${rate.remaining.toLocaleString('ja-JP')} / ${rate.limit.toLocaleString('ja-JP')}` }),
            ]),
            el('p', { class: 'chart-note', text: `リセット ${absoluteTime(rate.resetAt)}（${relativeTime(rate.resetAt)}）` }),
            el('p', {
              class: 'chart-note',
              text:
                cost === null
                  ? '取得コストは次の取得で分かる'
                  : perHour === null
                    ? `1回の取得 ${cost}点（自動更新オフなので手動ぶんだけ）`
                    : `1回の取得 ${cost}点 × 最大 ${Math.floor(3600 / refresh)}回/時 = 最大 ${perHour.toLocaleString('ja-JP')}点/時`,
            }),
          ]),
        ])
      : el('p', { class: 'chart-note', text: '残量はまだ分かりません（次の取得で出ます）。' }),
    // ここが「調整する方法」。config.json を直接書き換えるのと同じ効果
    el('div', { class: 'api-controls' }, [
      el('label', { class: 'toggle' }, [
        el('span', { text: '更新間隔' }),
        (() => {
          const select = el('select', {
            class: 'control',
            'aria-label': '自動更新の間隔',
            onchange: (event) => saveSettings({ refreshSeconds: Number(event.target.value) }),
          });
          select.replaceChildren(
            ...REFRESH_CHOICES.map((choice) =>
              el('option', { value: String(choice.value), text: choice.label, selected: choice.value === refresh })
            )
          );
          select.value = String(refresh);
          return select;
        })(),
      ]),
      (() => {
        const box = el('input', {
          type: 'checkbox',
          onchange: (event) => saveSettings({ includeIssues: Boolean(event.target.checked) }),
        });
        box.checked = settings.includeIssues !== false;
        return el('label', { class: 'toggle', title: 'Issue とマイルストンを取らなければ消費が減る' }, [
          box,
          el('span', { text: 'Issue も取得' }),
        ]);
      })(),
      el('span', { class: 'chart-note', text: '監視リポジトリを減らすのも効く（上のチェックは表示だけで消費は減らない）' }),
    ]),
  ]);
}

/** 円グラフ（ドーナツ）1つ。0〜1 の比率を描く */
function donut(ratio, tone) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'donut');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', '64');
  svg.setAttribute('height', '64');
  svg.setAttribute('aria-hidden', 'true');

  const circle = (className, dash) => {
    const node = document.createElementNS(SVG_NS, 'circle');
    node.setAttribute('class', className);
    node.setAttribute('cx', '32');
    node.setAttribute('cy', '32');
    node.setAttribute('r', String(radius));
    if (dash) node.setAttribute('stroke-dasharray', dash);
    return node;
  };

  const value = circle('donut-value', `${(circumference * ratio).toFixed(1)} ${circumference.toFixed(1)}`);
  value.setAttribute('data-tone', tone);
  svg.append(circle('donut-track'), value);
  return svg;
}

/** 3パターンの内訳を数える。順番は LINK_ORDER 固定（色と対応させるため） */
function linkCounts(items) {
  return LINK_ORDER.map((key) => ({
    key,
    spec: LINK_ITEM[key],
    count: items.filter((item) => item.link === key).length,
  }));
}

/** 積み上げバー1本。件数 0 のパターンは棒を出さない（凡例には残す） */
function stackBar(parts, total) {
  return el(
    'div',
    { class: 'stack' },
    parts
      .filter((part) => part.count > 0)
      .map((part) =>
        el('div', {
          class: 'stack-part',
          dataset: { series: String(part.spec.series) },
          style: `flex:${part.count}`,
          title: `${part.spec.label} ${part.count}件（${percent(part.count, total)}%）`,
        })
      )
  );
}

function renderLinkChart(items) {
  const parts = linkCounts(items);
  const total = parts.reduce((sum, part) => sum + part.count, 0);

  setChildren(dom.chartLink, [
    el('h2', { class: 'chart-title', text: 'Issue連携の内訳' }),
    el('p', { class: 'chart-note', text: `表示中の ${total} 件。Issueのみ＝未着手、Issue+PR＝進行中。` }),
    total
      ? stackBar(parts, total)
      : el('p', { class: 'chart-note', text: '表示中のものがありません。' }),
    el(
      'div',
      { class: 'legend' },
      parts.map((part) =>
        el('span', { class: 'legend-key', title: part.spec.hint }, [
          el('span', { class: 'legend-swatch', dataset: { series: String(part.spec.series) }, 'aria-hidden': 'true' }),
          el('span', { class: 'status-icon', dataset: { series: String(part.spec.series) } }, [
            icon(part.spec.icon, { size: 13 }),
          ]),
          el('span', { text: part.spec.label }),
          el('span', { class: 'legend-value', text: `${part.count}（${percent(part.count, total)}%）` }),
        ])
      )
    ),
  ]);
}

function renderMilestoneChart() {
  const shown = shownRepos();
  const milestones = (state.data?.milestones ?? []).filter((milestone) => shown.has(milestone.repo));

  setChildren(dom.chartMilestone, [
    el('h2', { class: 'chart-title', text: 'マイルストン進捗' }),
    el('p', {
      class: 'chart-note',
      text: 'クローズ済み Issue ÷ Issue 全体（オープンなマイルストンのみ。リポジトリの絞り込みだけ反映）',
    }),
    milestones.length
      ? el('div', { class: 'bar-rows' }, milestones.map(milestoneRow))
      : el('p', { class: 'chart-note', text: 'オープンなマイルストンはありません。' }),
  ]);
}

function milestoneRow(milestone) {
  const dueDate = milestone.dueOn ? new Date(milestone.dueOn) : null;
  const overdue = Boolean(dueDate && dueDate < new Date() && milestone.progressPercentage < 100);
  const due = dueDate ? `期限 ${dueDate.toLocaleDateString('ja-JP')}` : '期限なし';
  const title =
    `${milestone.repo} / ${milestone.title} — Issue ${milestone.closedIssues}件完了 / 全${milestone.totalIssues}件` +
    ` · オープンPR ${milestone.openPullRequests}` +
    (milestone.githubProgressPercentage !== null && milestone.githubProgressPercentage !== milestone.progressPercentage
      ? ` · GitHub 表示の進捗 ${milestone.githubProgressPercentage}%（PRを含む母数）`
      : '');

  return el('div', { class: 'bar-row', title }, [
    el('span', { class: 'bar-label' }, [
      milestone.url
        ? el('a', { href: milestone.url, target: '_blank', rel: 'noreferrer', text: milestone.title })
        : el('span', { text: milestone.title }),
      el('span', { class: 'bar-sub', dataset: overdue ? { tone: 'critical' } : {}, text: `${shortRepo(milestone.repo)} · ${overdue ? `⚠ 期限超過 ${due}` : due}` }),
    ]),
    el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', style: `width:${milestone.progressPercentage}%` })]),
    el('span', { class: 'bar-value' }, [
      el('span', { text: `${milestone.progressPercentage}%` }),
      el('span', { class: 'bar-sub', text: `${milestone.closedIssues}/${milestone.totalIssues}` }),
    ]),
  ]);
}

function renderLabelChart(items) {
  const byLabel = new Map();
  for (const item of items) {
    const names = item.labels.length ? item.labels.map((label) => label.name) : ['(ラベルなし)'];
    for (const name of names) {
      const entry = byLabel.get(name) ?? { name, total: 0, links: new Map() };
      entry.total += 1;
      entry.links.set(item.link, (entry.links.get(item.link) ?? 0) + 1);
      byLabel.set(name, entry);
    }
  }

  const rows = [...byLabel.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ja'));
  const top = rows.slice(0, LABEL_ROWS);
  const rest = rows.slice(LABEL_ROWS);
  const max = top[0]?.total ?? 1;

  setChildren(dom.chartLabel, [
    el('h2', { class: 'chart-title', text: 'ラベル別（表示中）' }),
    el('p', { class: 'chart-note', text: '色は Issue連携の内訳と同じ。1件が複数ラベルを持つ場合は各ラベルで数える。' }),
    top.length
      ? el(
          'div',
          { class: 'bar-rows' },
          top.map((entry) => {
            const parts = LINK_ORDER.map((key) => ({
              key,
              spec: LINK_ITEM[key],
              count: entry.links.get(key) ?? 0,
            }));
            return el('div', { class: 'bar-row', title: `${entry.name}: ${parts.map((p) => `${p.spec.label} ${p.count}`).join(' / ')}` }, [
              el('span', { class: 'bar-label' }, [el('span', { text: entry.name })]),
              el('div', { class: 'bar-scale' }, [
                el('div', { class: 'bar-scale-inner', style: `width:${percent(entry.total, max)}%` }, [
                  stackBar(parts, entry.total),
                ]),
              ]),
              el('span', { class: 'bar-value', text: String(entry.total) }),
            ]);
          })
        )
      : el('p', { class: 'chart-note', text: '表示中のものがありません。' }),
    rest.length
      ? el('p', {
          class: 'chart-note',
          text: `他 ${rest.length} ラベル（${rest.reduce((sum, entry) => sum + entry.total, 0)} 件ぶん）は省略`,
        })
      : null,
  ]);
}

function renderBucketFilter() {
  const pullRequests = allItems();
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
    for (const group of groupsOf(dim, pr)) {
      if (!map.has(group.key)) map.set(group.key, { ...group, items: [] });
      map.get(group.key).items.push(pr);
    }
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
        text: allItems().length ? '絞り込み条件に合うものがありません。' : '表示できる PR / Issue がありません。',
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
      const items = row.items.filter((pr) => groupsOf(colDim, pr).some((group) => group.key === col.key));
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

/**
 * カードは2段。
 *   1段目: 状況アイコン（CI / レビュー / Issue連携）+ CI 進捗バー + 番号・時刻・担当
 *   2段目: タイトル（全文）＋ マイルストン/Issue/ラベルのチップ（タイトルの続きに流す）
 * 高さを節約しつつ、状態はアイコン（形）+ 数字 + tooltip で分かるようにしてある。
 * 詳しい内訳（チェック一覧・レビュアー・差分）は開いたときの詳細に出す。
 */
function renderCard(pr, { showRepo = true } = {}) {
  const isIssue = pr.kind === 'issue';
  const tone = cardTone(pr);
  const isOpen = state.open.has(pr.id);

  const body = el('div', { class: 'card-body', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) }, [
    el('div', { class: 'card-head' }, [
      statusIcons(pr),
      isIssue ? null : ciMeterInline(pr),
      pr.isDraft ? el('span', { class: 'card-flag', text: 'Draft' }) : null,
      pr.isMine ? el('span', { class: 'card-flag', text: '自分' }) : null,
      el('span', { class: 'card-spacer' }),
      showRepo ? el('span', { class: 'pr-repo', text: shortRepo(pr.repo) }) : null,
      el('a', {
        class: 'pr-number',
        href: pr.url,
        target: '_blank',
        rel: 'noreferrer',
        text: `${isIssue ? 'Issue ' : ''}#${pr.number}`,
        onclick: stopClick,
      }),
      isIssue ? assigneeAvatars(pr, 2) : reviewerAvatars(pr, 3),
      el('span', { class: 'card-time', title: absoluteTime(pr.updatedAt), text: relativeTime(pr.updatedAt) }),
    ]),
    el('div', { class: 'card-line' }, [
      el('a', {
        class: 'card-title',
        href: pr.url,
        target: '_blank',
        rel: 'noreferrer',
        text: pr.title,
        title: pr.title,
        onclick: stopClick,
      }),
      ...metaChipList(pr),
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
  const isIssue = pr.kind === 'issue';
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
        text: `${isIssue ? 'Issue ' : ''}#${pr.number}`,
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
    ]),
    metaChips(pr, { maxLabels: 4 }),
    el('div', { class: 'pr-meta' }, [
      pr.authorAvatarUrl ? el('img', { class: 'avatar', src: pr.authorAvatarUrl, alt: '', loading: 'lazy' }) : null,
      el('span', { text: pr.author }),
      pr.isMine ? el('span', { class: 'mine', text: '自分' }) : null,
      pr.isDraft ? el('span', { text: 'Draft' }) : null,
      isIssue ? null : el('span', { text: `${pr.headRefName} → ${pr.baseRefName}` }),
      isIssue
        ? null
        : el('span', { class: 'diff-add', text: `+${pr.additions} −${pr.deletions} / ${pr.changedFiles}ファイル` }),
      pr.commentCount ? el('span', { text: `コメント ${pr.commentCount}` }) : null,
      el('span', { title: absoluteTime(pr.updatedAt), text: `更新 ${relativeTime(pr.updatedAt)}` }),
      pr.hasConflict ? el('span', { text: '⚠ コンフリクト' }) : null,
      pr.mergeable === 'UNKNOWN' ? el('span', { text: 'マージ可否 判定中' }) : null,
    ]),
  ]);

  const ciCell = isIssue
    ? el('div', { class: 'cell cell-ci' }, [linkBadge(pr)])
    : el('div', { class: 'cell cell-ci' }, [badge(ci, `${ci.label} (${pr.ci.state})`), ciMeter(pr, ci.tone)]);

  const reviewCell = isIssue
    ? el('div', { class: 'cell cell-review' }, [
        el('div', { class: 'cell-sub' }, [el('span', { text: '担当' }), assigneeAvatars(pr, 5)]),
      ])
    : el('div', { class: 'cell cell-review' }, [
        badge(review, pr.review.decision ? `reviewDecision: ${pr.review.decision}` : 'ブランチ保護のレビュー必須設定なし'),
        el('div', { class: 'cell-sub' }, [el('span', { text: reviewSummaryText(pr) }), reviewerAvatars(pr, 5)]),
      ]);

  const row = el(
    'div',
    { class: 'pr-row', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) },
    [head, ciCell, reviewCell, el('span', { class: 'chevron' }, [icon('chevron_right')])]
  );
  bindToggle(row, pr);

  return el('article', { class: 'pr', dataset: { tone: cardTone(pr), open: String(isOpen) } }, [
    row,
    isOpen ? renderDetails(pr) : null,
  ]);
}

/* ---------------- 詳細（カード/行 共通） ---------------- */

function renderDetails(pr) {
  if (pr.kind === 'issue') return renderIssueDetails(pr);

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
              icon(CHECK_ICON[check.state] ?? 'remove', { size: 14 }),
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
    pr.issues.length
      ? el('p', { class: 'detail-note' }, [
          el('span', { text: `紐づく Issue（${pr.issues.length}）: ` }),
          ...pr.issues.flatMap((issue, index) => [
            index ? el('span', { text: ' / ' }) : null,
            el('a', {
              href: issue.url,
              target: '_blank',
              rel: 'noreferrer',
              text: `#${issue.number} ${issue.title}`,
              onclick: stopClick,
            }),
          ]),
        ])
      : el('p', { class: 'detail-note', text: '紐づく Issue: なし（PRのみ）' }),
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

/** Issue（PR が無いもの）の詳細。CI もレビューも無いので、代わりに紐づき状況と属性を出す */
function renderIssueDetails(issue) {
  const milestone = issue.milestone;

  return el('div', { class: 'pr-details' }, [
    el('div', {}, [
      el('h3', { class: 'detail-title', text: 'Issue連携' }),
      el('p', {
        class: 'detail-note',
        text: 'オープンな PR が紐づいていません（未着手）。PR 側で「Fixes #番号」等を書くと、その PR に「Issue+PR」として合流します。',
      }),
      el('p', {
        class: 'detail-note',
        text: `作成 ${relativeTime(issue.createdAt)}（${absoluteTime(issue.createdAt)}） · 更新 ${relativeTime(issue.updatedAt)}`,
      }),
      issue.commentCount ? el('p', { class: 'detail-note', text: `コメント ${issue.commentCount} 件` }) : null,
    ]),
    el('div', {}, [
      el('h3', { class: 'detail-title', text: '担当・マイルストン・ラベル' }),
      el('div', { class: 'cell-sub' }, [el('span', { text: '担当' }), assigneeAvatars(issue, 8)]),
      el('p', { class: 'detail-note' }, [
        el('span', { text: 'マイルストン: ' }),
        milestone
          ? milestone.url
            ? el('a', { href: milestone.url, target: '_blank', rel: 'noreferrer', text: milestone.title, onclick: stopClick })
            : el('span', { text: milestone.title })
          : el('span', { text: 'なし' }),
        milestone?.progressPercentage !== null && milestone?.progressPercentage !== undefined
          ? el('span', { text: `（進捗 ${milestone.progressPercentage}%）` })
          : null,
      ]),
      issue.labels.length
        ? el(
            'div',
            { class: 'card-chips' },
            issue.labels.map((label) =>
              el('span', {
                class: 'label-chip',
                text: label.name,
                style: `background:#${label.color}22;border:1px solid #${label.color}66`,
              })
            )
          )
        : el('p', { class: 'detail-note', text: 'ラベル: なし' }),
    ]),
  ]);
}

function renderFooter(visible) {
  const data = state.data;
  if (!data) {
    dom.footerInfo.textContent = '';
    return;
  }
  const parts = [`表示 ${visible.length} / ${allItems().length} 件（PR ${data.pullRequests.length} / Issue ${(data.issues ?? []).length}）`];
  if (data.rateLimit) {
    const cost = data.rateLimit.fetchCost ? `・今回 ${data.rateLimit.fetchCost}点` : '';
    parts.push(
      `API残 ${data.rateLimit.remaining}/${data.rateLimit.limit}${cost}（リセット ${relativeTime(data.rateLimit.resetAt)}）`
    );
  }
  if (data.settings?.excludeAuthors?.length) parts.push(`除外作成者: ${data.settings.excludeAuthors.join(', ')}`);
  dom.footerInfo.textContent = parts.join(' · ');
}

/* ---------------- 操作 ---------------- */

/** いま表示対象のリポジトリ。filters.repos が空なら全部 */
function shownRepos() {
  const all = (state.data?.repos ?? []).map((repo) => repo.nameWithOwner);
  return new Set(state.filters.repos.length ? state.filters.repos : all);
}

function toggleRepoFilter(nameWithOwner) {
  const all = (state.data?.repos ?? []).map((repo) => repo.nameWithOwner);
  const shown = shownRepos();
  if (shown.has(nameWithOwner)) shown.delete(nameWithOwner);
  else shown.add(nameWithOwner);
  const next = all.filter((name) => shown.has(name));
  // 全部（または全部外し）は「絞り込みなし」に丸める。何も出ない状態を作らない
  state.filters.repos = next.length && next.length < all.length ? next : [];
  saveFilters();
  render();
}

/** 監視の ON/OFF。チェックしたらその場で保存して取り直す */
function toggleRepoEnabled(nameWithOwner) {
  const disabled = new Set(disabledRepos());
  if (disabled.has(nameWithOwner)) disabled.delete(nameWithOwner);
  else disabled.add(nameWithOwner);
  state.repoDisabledDraft = disabled;
  saveRepos(dom.repoText.value);
}

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
    // hideIssues が無い保存値は Issue 対応より前のもの。あとから増えたバケット（issue）を足す
    if (savedFilters.hideIssues === undefined) {
      for (const bucket of BUCKETS) {
        if (!state.filters.buckets.includes(bucket.key)) state.filters.buckets.push(bucket.key);
      }
      state.filters.buckets = BUCKETS.filter((b) => state.filters.buckets.includes(b.key)).map((b) => b.key);
    }
    // 単一選択（filters.repo）で保存された古い値を複数選択に移す
    if (!Array.isArray(state.filters.repos)) state.filters.repos = [];
    if (typeof savedFilters.repo === 'string' && savedFilters.repo) state.filters.repos = [savedFilters.repo];
    delete state.filters.repo;
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
  dom.hideIssues.checked = state.filters.hideIssues;
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
// index.html に文字を置かず、アイコンは全部ここから入れる（記号の出どころを1つにするため）
dom.swapDims.replaceChildren(icon('swap_horiz'));
dom.theme.replaceChildren(icon('contrast'));

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
dom.search.addEventListener('input', () => {
  state.filters.search = dom.search.value;
  saveFilters();
  render();
});
for (const key of ['mineOnly', 'hideBots', 'hideDrafts', 'hideIssues']) {
  dom[key].addEventListener('change', () => {
    state.filters[key] = dom[key].checked;
    saveFilters();
    render();
  });
}
dom.expandAll.addEventListener('click', () => {
  const visible = applyFilters(allItems());
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
  state.repoDisabledDraft = null;
  state.repoStatus = '';
  render();
});
document.addEventListener('keydown', (event) => {
  if (event.target.matches?.('input, select, textarea')) return;
  if (event.key === 'r') load({ refresh: true });
});

load();
