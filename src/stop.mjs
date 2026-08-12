// 起動中のダッシュボードを止める。pr-monitor-stop.cmd と `npm run stop` から使う。
// ポートは起動側と同じ経路（環境変数 PORT → config.json）で解決するので設定がずれない。

import { loadConfig } from './config.mjs';
import { baseUrl, isOurServer, requestShutdown, waitUntilStopped } from './probe.mjs';

const config = await loadConfig();
const port = Number(process.env.PORT ?? config.port);
const url = baseUrl(port);

if (!(await isOurServer(url))) {
  // 誰も居ないのか、別アプリが居るのかは区別できない。どちらにせよ止める相手ではない。
  console.log(`起動していません（${url} に PR Monitor は居ません）。`);
  process.exit(0);
}

await requestShutdown(url);

if (await waitUntilStopped(url)) {
  console.log(`停止しました: ${url}`);
  process.exit(0);
}

console.error(`停止要求は送りましたが、まだ応答しています: ${url}`);
console.error('起動したウィンドウを閉じるか、タスクマネージャーで node を終了してください。');
process.exit(1);
