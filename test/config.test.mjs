// 設定ファイルの置き場所と正規化のテスト。
// exe 版はアプリの外（ユーザーのデータフォルダ）を読み書きするので、
// 環境変数で差し替えられること自体をここで担保する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('PR_MONITOR_CONFIG で設定ファイルの場所を差し替えられる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr-monitor-config-'));
  // まだ存在しないパスを指定する（初回起動と同じ状況。フォルダは作られる）
  const path = join(dir, 'nested', 'config.json');
  process.env.PR_MONITOR_CONFIG = path;

  // 差し替えはモジュール読み込み時に決まるので、都度新しく読み込む
  const { CONFIG_PATH, loadConfig, saveConfigPatch } = await import(`../src/config.mjs?case=missing`);
  assert.equal(CONFIG_PATH, path);

  // ファイルが無くても既定値で読める
  const initial = await loadConfig();
  assert.equal(initial.port, 8787);
  assert.deepEqual(initial.repos, []);

  // 保存すると（親フォルダごと）作られる
  await saveConfigPatch({ repos: ['owner/name'], refreshSeconds: 600 });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.repos, ['owner/name']);
  assert.equal(saved.refreshSeconds, 600);

  const reloaded = await loadConfig();
  assert.equal(reloaded.repos[0].nameWithOwner, 'owner/name');
  assert.equal(reloaded.refreshSeconds, 600);

  delete process.env.PR_MONITOR_CONFIG;
});

test('repos と disabledRepos は正規化され、両方にあれば有効が勝つ', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr-monitor-config-'));
  const path = join(dir, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      repos: ['https://github.com/owner/name', 'owner/name', 'owner/other'],
      disabledRepos: ['owner/other', 'owner/name'],
    }),
    'utf8'
  );
  process.env.PR_MONITOR_CONFIG = path;

  const { loadConfig } = await import(`../src/config.mjs?case=disabled`);
  const config = await loadConfig();

  // URL 貼り付けと重複は正規化されてまとまる
  assert.deepEqual(
    config.repos.map((repo) => repo.nameWithOwner),
    ['owner/name', 'owner/other']
  );
  // repos に居るので無効側からは落ちる
  assert.deepEqual(config.disabledRepos, []);

  delete process.env.PR_MONITOR_CONFIG;
});

test('不正なリポジトリ指定は例外になる', async () => {
  const { parseRepos } = await import('../src/config.mjs');
  assert.throws(() => parseRepos(['owner/name/extra']), /不正/);
  assert.throws(() => parseRepos(['なまえ']), /不正/);
  assert.deepEqual(parseRepos(['https://github.com/owner/name/pull/12']).map((r) => r.nameWithOwner), ['owner/name']);
});
