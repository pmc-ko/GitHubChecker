// アクセストークンの解決。
// 優先順: 環境変数 GITHUB_TOKEN / GH_TOKEN → gh CLI (`gh auth token`)。
// gh でログイン済みならトークンを自分で管理しなくてよい、というのがこのアプリの前提。

import { spawnSync } from 'node:child_process';

let cached = null;

export function resolveToken({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) {
    cached = { token: fromEnv.trim(), source: 'env' };
    return cached;
  }

  const token = readGhToken();
  if (token) {
    cached = { token, source: 'gh' };
    return cached;
  }

  throw new Error(
    'GitHub のトークンが見つかりません。`gh auth login` でログインするか、環境変数 GITHUB_TOKEN を設定してください。'
  );
}

function readGhToken() {
  // Windows では gh.exe に解決される。念のため shell 経由も試す。
  for (const options of [{ shell: false }, { shell: true }]) {
    try {
      const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', ...options });
      const token = result.status === 0 ? result.stdout.trim() : '';
      if (token) return token;
    } catch {
      // 次の方法を試す
    }
  }
  return null;
}
