// デスクトップアプリの中でローカルサーバ（src/server.mjs）の面倒を見る。
//   - 既に起動している（pr-monitor.cmd で立てた等）ならそれを使い、終了時に止めない
//   - 自分で起動したものだけ、終了時に停止まで見る
// Electron に同梱の Node で動かすので、この PC に Node が無くても動く。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { baseUrl, isOurServer, requestShutdown, waitUntilStopped } from '../src/probe.mjs';

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

/**
 * サーバが応答する状態にして、その URL を返す。
 * configPath を渡すと、サーバ側もその設定ファイルを読み書きする（exe 版はアプリの外を指す）。
 * @returns {Promise<{url: string, port: number, owned: boolean, child: import('node:child_process').ChildProcess|null}>}
 */
export async function ensureServer({ onLog = () => {}, configPath = null } = {}) {
  if (configPath) process.env.PR_MONITOR_CONFIG = configPath; // 自分の loadConfig にも効かせる
  const config = await loadConfig();
  const port = Number(process.env.PORT ?? config.port);
  const url = baseUrl(port);

  if (await isOurServer(url)) {
    onLog(`既に起動しているサーバを使います: ${url}`);
    return { url, port, owned: false, child: null };
  }

  onLog(`サーバを起動します: ${url}`);
  const child = spawn(process.execPath, [SERVER_PATH, '--no-open'], {
    // ELECTRON_RUN_AS_NODE=1 で electron.exe を素の Node として使う
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(configPath ? { PR_MONITOR_CONFIG: configPath } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => onLog(String(chunk).trimEnd()));
  child.stderr.on('data', (chunk) => onLog(String(chunk).trimEnd()));

  // 待ち受け開始まで少し掛かる。ポートが別アプリに埋まっていた場合はここで諦める
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error(`サーバが起動できませんでした（終了コード ${child.exitCode}）`);
    if (await isOurServer(url)) return { url, port, owned: true, child };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`サーバが応答しません: ${url}`);
}

/** 自分で起動したサーバだけ止める。他から起動されたものは触らない */
export async function stopServer(handle, { onLog = () => {} } = {}) {
  if (!handle?.owned) return;
  try {
    await requestShutdown(handle.url);
    if (await waitUntilStopped(handle.url, { timeoutMs: 4000 })) {
      onLog('サーバを停止しました');
      return;
    }
  } catch (err) {
    onLog(`停止要求が通りませんでした: ${err.message}`);
  }
  handle.child?.kill(); // 応答しないときの保険
}
