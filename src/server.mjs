// ローカル HTTP サーバ。
//   GET /               → public/index.html（ダッシュボード本体）
//   GET /api/dashboard  → PR一覧と集計の JSON（画面はこれをポーリングするだけ）
//   GET /api/dashboard?refresh=1 → キャッシュを無視して取り直す
//
// 依存パッケージなし。`npm run dev` なら --watch でソース変更時に自動再起動する。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT } from './config.mjs';
import { resolveToken } from './token.mjs';
import { fetchRepoPullRequests } from './github.mjs';
import { buildDashboard } from './summarize.mjs';

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
        const result = await fetchRepoPullRequests(token, repo, { maxPrs: config.maxPrsPerRepo });
        results.push({ repo, ...result });
      } catch (err) {
        results.push({ repo, error: err.message, pullRequests: [] });
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
  const cacheKey = JSON.stringify([config.repos.map((r) => r.nameWithOwner), config.maxPrsPerRepo, config.excludeAuthors, config.excludeDrafts]);
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
      stats: emptyStats(),
      warning: 'config.json の repos が空です。監視したいリポジトリを "owner/name" 形式で追加してください。',
    };
  }

  const { token } = resolveToken();
  const repoResults = await fetchAll(config, token);
  applyMergeableMemo(repoResults);
  const dashboard = buildDashboard(repoResults, config);
  const rateLimit = repoResults.find((r) => r.rateLimit)?.rateLimit ?? null;

  const payload = {
    fetchedAt: new Date(now).toISOString(),
    settings: publicSettings(config),
    rateLimit,
    ...dashboard,
  };

  cache = { key: cacheKey, at: now, payload };
  return { ...payload, cached: false, ageSeconds: 0 };
}

function publicSettings(config) {
  return {
    refreshSeconds: config.refreshSeconds,
    cacheSeconds: config.cacheSeconds,
    repos: config.repos.map((repo) => repo.nameWithOwner),
    excludeAuthors: config.excludeAuthors,
    excludeDrafts: config.excludeDrafts,
  };
}

function emptyStats() {
  return {
    total: 0, action: 0, mergeable: 0, waiting: 0, other: 0,
    ciFailure: 0, ciPending: 0, changesRequested: 0, reviewRequired: 0, approved: 0, conflict: 0, mine: 0,
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

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
  const url = `http://127.0.0.1:${port}/`;
  console.log(`GitHub PR Checker: ${url}`);
  console.log(`監視対象: ${config.repos.map((r) => r.nameWithOwner).join(', ') || '(config.json の repos が空)'}`);
  if (!process.argv.includes('--no-open')) openBrowser(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ポート ${port} は使用中です。config.json の port を変えるか、既に起動しているサーバを終了してください。`);
    process.exit(1);
  }
  throw err;
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
