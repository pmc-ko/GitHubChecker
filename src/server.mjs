// ローカル HTTP サーバ。
//   GET  /                       → public/index.html（ダッシュボード本体）
//   GET  /api/dashboard          → PR一覧と集計の JSON（画面はこれをポーリングするだけ）
//   GET  /api/dashboard?refresh=1 → キャッシュを無視して取り直す
//   POST /api/config/repos       → 監視リポジトリを config.json に保存（画面から編集用）
//   POST /api/shutdown           → サーバを終了（pr-monitor-stop.cmd から叩く）
//
// 127.0.0.1 のみで待ち受ける。依存パッケージなし。
// `npm run dev` なら --watch でソース変更時に自動再起動する。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfigPatch, parseRepos, ROOT, CONFIG_PATH } from './config.mjs';
import { resolveToken } from './token.mjs';
import { fetchRepoPullRequests, fetchRepoIssues } from './github.mjs';
import { buildDashboard } from './summarize.mjs';
import { APP_ID, baseUrl, isOurServer } from './probe.mjs';

const PUBLIC_DIR = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 取得結果のキャッシュ。cacheSeconds 以内の再取得はAPIを叩かない */
let cache = null;

/**
 * mergeable（コンフリクト判定）は GitHub 側が非同期に計算するため、
 * 問い合わせのタイミングによって UNKNOWN が返ってくる。
 * 同じ HEAD コミットに対する直近の確定値を覚えておき、UNKNOWN のときは埋め戻す。
 * key: "owner/repo#123@<oid>" → "MERGEABLE" | "CONFLICTING"
 */
const mergeableMemo = new Map();

function applyMergeableMemo(repoResults) {
  for (const result of repoResults) {
    if (result.error || !result.repository) continue;
    for (const pr of result.pullRequests) {
      const oid = pr.commits?.nodes?.[0]?.commit?.oid ?? '';
      const key = `${result.repository.nameWithOwner}#${pr.number}@${oid}`;
      if (pr.mergeable === 'UNKNOWN') {
        const remembered = mergeableMemo.get(key);
        if (remembered) pr.mergeable = remembered;
      } else if (pr.mergeable) {
        mergeableMemo.set(key, pr.mergeable);
      }
    }
  }
  // 際限なく増えないように古いものから捨てる（Map は挿入順）
  while (mergeableMemo.size > 2000) mergeableMemo.delete(mergeableMemo.keys().next().value);
}

/** 複数リポジトリを並列（ただし控えめな同時数）で取得する */
async function fetchAll(config, token) {
  const CONCURRENCY = 4;
  const queue = [...config.repos];
  const results = [];

  async function worker() {
    while (queue.length) {
      const repo = queue.shift();
      try {
        const prs = await fetchRepoPullRequests(token, repo, { maxPrs: config.maxPrsPerRepo });
        // Issue 側は別クエリ。落ちても PR の一覧は出せるように分けて受ける
        let issues = { issues: [], issueTotalCount: 0, milestones: [], rateLimit: null, issueError: null };
        if (config.includeIssues) {
          try {
            issues = await fetchRepoIssues(token, repo, { maxIssues: config.maxIssuesPerRepo });
          } catch (err) {
            issues = { issues: [], issueTotalCount: 0, milestones: [], rateLimit: null, issueError: err.message };
          }
        }
        results.push({
          repo,
          ...prs,
          issues: issues.issues,
          issueTotalCount: issues.issueTotalCount,
          milestones: issues.milestones,
          issueError: issues.issueError ?? null,
          // 残量は新しい方（後に叩いた方）を採り、コストは両方の合計を持つ
          rateLimit: issues.rateLimit ?? prs.rateLimit,
          cost: (prs.rateLimit?.cost ?? 0) + (issues.rateLimit?.cost ?? 0),
        });
      } catch (err) {
        results.push({ repo, error: err.message, pullRequests: [], issues: [], milestones: [], cost: 0 });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  // config.repos の順序を保つ
  const order = new Map(config.repos.map((repo, index) => [repo.nameWithOwner, index]));
  results.sort((a, b) => order.get(a.repo.nameWithOwner) - order.get(b.repo.nameWithOwner));
  return results;
}

async function getDashboard({ refresh = false } = {}) {
  const config = await loadConfig();
  const cacheKey = JSON.stringify([
    config.repos.map((r) => r.nameWithOwner),
    config.maxPrsPerRepo,
    config.excludeAuthors,
    config.excludeDrafts,
    config.includeIssues,
    config.maxIssuesPerRepo,
  ]);
  const now = Date.now();

  if (!refresh && cache && cache.key === cacheKey && now - cache.at < config.cacheSeconds * 1000) {
    return { ...cache.payload, cached: true, ageSeconds: Math.round((now - cache.at) / 1000) };
  }

  if (!config.repos.length) {
    return {
      cached: false,
      ageSeconds: 0,
      fetchedAt: new Date(now).toISOString(),
      settings: publicSettings(config),
      viewer: null,
      repos: [],
      pullRequests: [],
      issues: [],
      milestones: [],
      stats: emptyStats(),
      warning: 'config.json の repos が空です。監視したいリポジトリを "owner/name" 形式で追加してください。',
    };
  }

  const { token } = resolveToken();
  const repoResults = await fetchAll(config, token);
  applyMergeableMemo(repoResults);
  const dashboard = buildDashboard(repoResults, config);
  // 残量は最後に分かった値、fetchCost は今回の取得で使った合計点（設定を詰めるときの目安）
  const latest = [...repoResults].reverse().find((r) => r.rateLimit)?.rateLimit ?? null;
  const rateLimit = latest
    ? { ...latest, fetchCost: repoResults.reduce((sum, r) => sum + (r.cost ?? 0), 0) }
    : null;

  const payload = {
    fetchedAt: new Date(now).toISOString(),
    settings: publicSettings(config),
    rateLimit,
    ...dashboard,
  };

  cache = { key: cacheKey, at: now, payload };
  return { ...payload, cached: false, ageSeconds: 0 };
}

/** 画面から来た数値の検証。黙って丸めず、範囲外はエラーにする */
function intInRange(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} は ${min}〜${max} の整数で送ってください`);
  }
  return number;
}

function publicSettings(config) {
  return {
    refreshSeconds: config.refreshSeconds,
    cacheSeconds: config.cacheSeconds,
    repos: config.repos.map((repo) => repo.nameWithOwner),
    disabledRepos: config.disabledRepos.map((repo) => repo.nameWithOwner),
    excludeAuthors: config.excludeAuthors,
    excludeDrafts: config.excludeDrafts,
    includeIssues: config.includeIssues,
    // 画面に出す（exe 版はアプリの外に置くので、場所が分からないと手で直せない）
    configPath: CONFIG_PATH,
  };
}

function emptyStats() {
  return {
    total: 0, action: 0, mergeable: 0, waiting: 0, other: 0,
    ciFailure: 0, ciPending: 0, changesRequested: 0, reviewRequired: 0, approved: 0, conflict: 0, mine: 0,
    prOnly: 0, both: 0, issueOnly: 0, linkedIssues: 0, milestoneCount: 0,
  };
}

async function serveStatic(url, res) {
  const relative = url === '/' ? 'index.html' : decodeURIComponent(url.replace(/^\//, ''));
  const target = normalize(join(PUBLIC_DIR, relative));
  if (!target.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, { limitBytes = 64 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('リクエストが大きすぎます');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/**
 * ローカル以外からの書き込みを弾く。
 * サーバは 127.0.0.1 のみで待ち受けているが、他サイトのページから
 * localhost に POST される（DNS リバインディング等）のを避けるため Origin も見る。
 */
function isLocalRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 同一オリジンの fetch では付かない場合がある
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 二重起動の判定用（GitHub API は叩かない）
  if (url.pathname === '/api/ping') return sendJson(res, 200, { app: APP_ID, pid: process.pid });

  // 停止用。書き込み API と同じくローカルからのみ受け付ける
  if (url.pathname === '/api/shutdown') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST を使ってください' });
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'ローカルからのみ停止できます' });
    sendJson(res, 200, { stopping: true });
    console.log('停止要求を受け取りました。終了します。');
    // 返し切ってから閉じる。keep-alive の接続が残ると close() が返らないので明示的に切る
    res.on('finish', () => {
      setTimeout(() => {
        server.closeAllConnections();
        server.close(() => process.exit(0));
      }, 100);
    });
    return;
  }

  if (url.pathname === '/api/config/repos') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST を使ってください' });
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'ローカルからのみ変更できます' });
    try {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.repos)) throw new Error('repos は配列で送ってください');
      if (body.repos.length > 100) throw new Error('リポジトリは 100 個までにしてください');

      // repos = 候補すべて、disabledRepos = そのうちチェックを外したもの。
      // 正規化してから引き算するので、画面側は URL 貼り付けのままでも送れる。
      const candidates = parseRepos(body.repos);
      const patch = {};
      if (body.disabledRepos === undefined) {
        patch.repos = candidates.map((repo) => repo.nameWithOwner);
      } else {
        if (!Array.isArray(body.disabledRepos)) throw new Error('disabledRepos は配列で送ってください');
        const off = new Set(parseRepos(body.disabledRepos).map((repo) => repo.nameWithOwner));
        patch.repos = candidates.filter((repo) => !off.has(repo.nameWithOwner)).map((repo) => repo.nameWithOwner);
        patch.disabledRepos = candidates.filter((repo) => off.has(repo.nameWithOwner)).map((repo) => repo.nameWithOwner);
      }

      await saveConfigPatch(patch);
      cache = null; // 次の取得で必ず取り直す
      console.log(`監視対象を更新: ${patch.repos.join(', ') || '(なし)'}`);
      if (patch.disabledRepos?.length) console.log(`監視を止めた: ${patch.disabledRepos.join(', ')}`);
      return sendJson(res, 200, { repos: patch.repos, disabledRepos: patch.disabledRepos ?? [] });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 取得の頻度・範囲を画面から変える口（API 消費を絞るため）。書き込み条件は repos と同じ3点
  if (url.pathname === '/api/config/settings') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST を使ってください' });
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'ローカルからのみ変更できます' });
    try {
      const body = await readJsonBody(req);
      const patch = {};
      if (body.refreshSeconds !== undefined) patch.refreshSeconds = intInRange(body.refreshSeconds, 0, 3600, 'refreshSeconds');
      if (body.cacheSeconds !== undefined) patch.cacheSeconds = intInRange(body.cacheSeconds, 10, 3600, 'cacheSeconds');
      if (body.includeIssues !== undefined) {
        if (typeof body.includeIssues !== 'boolean') throw new Error('includeIssues は true / false で送ってください');
        patch.includeIssues = body.includeIssues;
      }
      if (!Object.keys(patch).length) throw new Error('変更する項目がありません');

      const config = await saveConfigPatch(patch);
      cache = null; // 取得範囲が変わるので次回は取り直す
      console.log(`設定を更新: ${JSON.stringify(patch)}`);
      return sendJson(res, 200, { settings: publicSettings(config) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/dashboard') {
    try {
      const payload = await getDashboard({ refresh: url.searchParams.has('refresh') });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      console.error('[api/dashboard]', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  await serveStatic(url.pathname, res);
});

const config = await loadConfig();
const port = Number(process.env.PORT ?? config.port);

server.listen(port, '127.0.0.1', () => {
  const url = baseUrl(port);
  console.log(`GitHub PR Checker: ${url}`);
  console.log(`設定ファイル: ${CONFIG_PATH}`);
  console.log(`監視対象: ${config.repos.map((r) => r.nameWithOwner).join(', ') || '(config.json の repos が空)'}`);
  if (!process.argv.includes('--no-open')) openBrowser(url);
});

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;

  // 既に起動している場合は二重起動せず、そのダッシュボードをブラウザで開くだけにする
  const url = baseUrl(port);
  if (await isOurServer(url)) {
    console.log(`既に起動しています。ブラウザで開きます: ${url}`);
    if (!process.argv.includes('--no-open')) openBrowser(url);
    process.exit(0);
  }

  console.error(`ポート ${port} は別のアプリが使用中です。config.json の port を変えてください。`);
  process.exit(1);
});

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // 開けなくても URL は表示済みなので致命的ではない
  }
}
