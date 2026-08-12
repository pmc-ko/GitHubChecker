// 設定ファイルの読み込み。
// リクエストごとに読み直すので、config.json を編集したらサーバ再起動なしで反映される。
// 設定項目を増やしたいときは DEFAULTS にキーを足して README の表も更新する。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config.json');

const DEFAULTS = {
  /** ダッシュボードを配信するポート */
  port: 8787,
  /** 監視対象リポジトリ。"owner/name" の配列 */
  repos: [],
  /** 1リポジトリあたり取得する最大オープンPR数（更新日時の新しい順） */
  maxPrsPerRepo: 100,
  /** GitHub API の結果をこの秒数キャッシュする（連打してもAPIを叩かない） */
  cacheSeconds: 45,
  /** 画面の自動リロード間隔（秒）。0 で自動リロード無効 */
  refreshSeconds: 60,
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
  config.repos = normalizeRepos(config.repos);
  return config;
}

function normalizeRepos(repos) {
  if (!Array.isArray(repos)) return [];
  return repos
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => {
      // "https://github.com/owner/name" のような貼り付けも受け付ける
      const cleaned = entry.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      const [owner, name] = cleaned.split('/');
      if (!owner || !name) throw new Error(`repos の指定が不正です: "${entry}" ("owner/name" 形式で書いてください)`);
      return { owner, name, nameWithOwner: `${owner}/${name}` };
    });
}
