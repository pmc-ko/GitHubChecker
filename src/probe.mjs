// 起動中のダッシュボードに「生きてるか」「止まってくれ」を聞く口。
// server.mjs（二重起動の判定）と stop.mjs（停止）が共有する。
// ここを変えると「起動中かどうかの判定」と「止め方」が同時に変わる。

/** /api/ping が返す識別子。別アプリがポートを使っているのと区別するために見る */
export const APP_ID = 'pr-monitor';

export function baseUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

/** そのポートで動いているのが自分（PR Monitor）かどうかを確かめる */
export async function isOurServer(url) {
  try {
    const response = await fetch(new URL('/api/ping', url), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.app === APP_ID;
  } catch {
    return false;
  }
}

/**
 * 停止を頼む。
 * サーバはレスポンスを返した直後に接続を切るため、通信エラーは「届いた可能性が高い」
 * とみなして無視し、実際に止まったかは waitUntilStopped() で確かめる。
 * 明示的に拒否された（HTTP エラー応答）ときだけ例外を投げる。
 */
export async function requestShutdown(url) {
  let response;
  try {
    response = await fetch(new URL('/api/shutdown', url), { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch {
    return;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `停止要求が拒否されました (HTTP ${response.status})`);
  }
}

/** ポートが空くまで待つ。止まったら true、時間切れなら false */
export async function waitUntilStopped(url, { timeoutMs = 5000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isOurServer(url))) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
