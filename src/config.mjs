// 設定ファイルの読み込み。
// リクエストごとに読み直すので、config.json を編集したらサーバ再起動なしで反映される。
// 設定項目を増やしたいときは DEFAULTS にキーを足して README の表も更新する。
//
// 置き場所は既定でリポジトリ直下の config.json。
// **環境変数 PR_MONITOR_CONFIG があればそちらを使う**（exe 化したデスクトップアプリは
// アプリの中に書き込めない/見つけられないので、ユーザーのデータフォルダを指す）。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.PR_MONITOR_CONFIG || join(ROOT, 'config.json');

const DEFAULTS = {
  /** ダッシュボードを配信するポート */
  port: 8787,
  /** 監視対象リポジトリ。"owner/name" の配列 */
  repos: [],
  /**
   * 監視を止めているリポジトリ。画面のチェックを外したものがここに来る。
   * 候補として残るだけで GitHub には問い合わせない（repos に入っていれば有効が勝つ）。
   */
  disabledRepos: [],
  /** 1リポジトリあたり取得する最大オープンPR数（更新日時の新しい順） */
  maxPrsPerRepo: 100,
  /** Issue とマイルストンも取る（PR との紐づき・進捗グラフに使う）。false で問い合わせ自体をしない */
  includeIssues: true,
  /** 1リポジトリあたり取得する最大オープン Issue 数（更新日時の新しい順） */
  maxIssuesPerRepo: 100,
  /**
   * GitHub API の結果をこの秒数キャッシュする（連打してもAPIを叩かない）。
   * GraphQL は 5000点/時。1回の取得コストは画面のフッタに出るので、
   * 「コスト × 3600/refreshSeconds」が 5000 を超えないように決める。
   */
  cacheSeconds: 120,
  /** 画面の自動リロード間隔（秒）。0 で自動リロード無効 */
  refreshSeconds: 300,
  /** 一覧から常に除外する作成者（例: "dependabot[bot]"） */
  excludeAuthors: [],
  /** true にすると Draft PR を一覧から除外する */
  excludeDrafts: false,
};

export async function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`config.json の読み込みに失敗しました: ${err.message}`);
    }
  }

  const config = { ...DEFAULTS, ...raw };
  config.repos = parseRepos(config.repos);
  // 両方に居たら有効（repos）を勝たせる。二重に数えないため無効側から落とす
  config.disabledRepos = parseRepos(config.disabledRepos).filter(
    (repo) => !config.repos.some((enabled) => enabled.nameWithOwner === repo.nameWithOwner)
  );
  return config;
}

/**
 * 設定の一部だけを書き換えて config.json に保存する（他のキーは温存）。
 * 画面からリポジトリを編集したときに使う。
 */
export async function saveConfigPatch(patch) {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config.json の読み込みに失敗しました: ${err.message}`);
  }
  const next = { ...raw, ...patch };
  await mkdir(dirname(CONFIG_PATH), { recursive: true }); // 初回（データフォルダ側）でも書けるように
  await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return loadConfig();
}

/** "owner/name" の配列を検証して正規化する。不正な指定があれば例外を投げる */
export function parseRepos(repos) {
  if (!Array.isArray(repos)) return [];
  return repos
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => {
      // "https://github.com/owner/name" のような貼り付けも受け付ける
      const cleaned = entry
        .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
        .replace(/\.git$/i, '')
        .replace(/\/(pulls?|issues|tree|blob).*$/i, '')
        .replace(/\/+$/, '');
      const [owner, name, extra] = cleaned.split('/');
      const valid = (part) => typeof part === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part);
      if (!valid(owner) || !valid(name) || extra) {
        throw new Error(`リポジトリの指定が不正です: "${entry}"（"owner/name" 形式で書いてください）`);
      }
      return { owner, name, nameWithOwner: `${owner}/${name}` };
    })
    .filter((repo, index, all) => all.findIndex((other) => other.nameWithOwner === repo.nameWithOwner) === index);
}
