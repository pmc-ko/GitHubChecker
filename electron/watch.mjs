// 画面を見ていなくても気づけるように、裏で /api/dashboard を見張って通知を出す。
// 判定は足さない（`src/summarize.mjs` が付けた bucket をそのまま使う）。ここは
// 「前回と比べて増えたか」だけを見る。通知の対象や間隔を変えたいときもここだけ触る。

/** 通知対象のバケット。新しくここに入った PR を知らせる */
const WATCHED_BUCKET = 'action';

/** 取得間隔（秒）。画面の refreshSeconds に合わせるが、これより短くはしない */
const MIN_INTERVAL_SECONDS = 30;

/**
 * @param {string} url サーバの baseUrl
 * @param {object} handlers
 * @param {(prs: object[]) => void} handlers.onNewAction 新しく「対応が必要」になった PR
 * @param {(payload: object) => void} handlers.onData 取得できた内容（トレイの表示更新用）
 * @param {(message: string) => void} [handlers.onError]
 * @returns {{ stop: () => void, pollNow: () => void }}
 */
export function startWatching(url, { onNewAction, onData, onError = () => {} }) {
  /** 直近に「対応が必要」だった PR の id。初回は通知せず基準にするだけ */
  let known = null;
  let intervalSeconds = 60;
  let timer = null;
  let stopped = false;

  async function poll() {
    try {
      // キャッシュは無視しない（?refresh=1 を付けると画面側の取得と二重に GitHub を叩き、
      // GraphQL のレート制限をすぐ使い切る）。cacheSeconds を過ぎていればサーバが取り直す。
      const response = await fetch(new URL('/api/dashboard', url), { cache: 'no-store' });
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error);

      const action = (payload.pullRequests ?? []).filter((pr) => pr.bucket === WATCHED_BUCKET);
      if (known !== null) {
        const fresh = action.filter((pr) => !known.has(pr.id));
        if (fresh.length) onNewAction(fresh);
      }
      known = new Set(action.map((pr) => pr.id));
      intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, Number(payload.settings?.refreshSeconds) || 60);
      onData(payload);
    } catch (err) {
      onError(err.message);
    } finally {
      if (!stopped) timer = setTimeout(poll, intervalSeconds * 1000);
    }
  }

  poll();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    /** トレイの「今すぐ更新」用。次の定期取得は取り直しから数え直す */
    pollNow() {
      clearTimeout(timer);
      poll();
    },
  };
}
