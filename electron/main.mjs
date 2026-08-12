// デスクトップアプリの殻。ここは「窓・トレイ・通知・終了」だけを持つ。
//
// 起動と終了はアプリの実行/ウィンドウを閉じる操作に連動する。
//   実行         → サーバを起動（既に動いていればそれを使う）してウィンドウを出す
//   ウィンドウを閉じる → アプリ終了。自分で起動したサーバも止める（トレイに残らない）
// 設定ファイルは exe 化するとアプリの中に隠れてしまうので、
// **パッケージ版はユーザーのデータフォルダ**（%APPDATA%\<アプリ名>\config.json）を使う。
// ダッシュボードの中身（通信/判定/描画）は src/ と public/ のまま、素の Node と
// 素の ESM で動く。この殻を消してもブラウザ版（pr-monitor.cmd）は動く、という関係を保つ。
//
//   npm run app            起動
//   npm run app:package    配布用フォルダを作る（@electron/packager を都度取得）

import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureServer, stopServer } from './server-process.mjs';
import { startWatching } from './watch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_PATH = join(HERE, 'icon.png');
/** ウィンドウの位置・大きさの保存先（設定ではないので config.json には入れない） */
const BOUNDS_PATH = join(app.getPath('userData'), 'window.json');

/**
 * 設定ファイルの場所。触りやすさ優先で次の順に決める。
 *   1. 開発中（npm run app）      … リポジトリ直下（ブラウザ版と同じものを見る）
 *   2. exe 版で exe の隣が書ける   … PRMonitor.exe と同じフォルダ（zip を展開しただけの持ち運び用途）
 *   3. 書けない場所に置かれた場合  … %APPDATA%\github-pr-checker\（Program Files 等に入れたとき）
 * アプリの中（resources\app）には置かない。見つけられないし、差し替えで消えるため。
 */
function resolveConfigPath() {
  if (!app.isPackaged) return join(HERE, '..', 'config.json');

  const besideExe = join(dirname(process.execPath), 'config.json');
  try {
    // 実際に書けるか試す（Windows の ACL は access チェックだと当てにならない）
    const probe = join(dirname(process.execPath), '.write-probe');
    writeFileSync(probe, '');
    unlinkSync(probe);
    return besideExe;
  } catch {
    return join(app.getPath('userData'), 'config.json');
  }
}

const CONFIG_PATH = resolveConfigPath();

/** 通知を Windows で正しく出すための ID。変えると通知履歴が別物になる */
app.setAppUserModelId('io.github.pmc-ko.pr-monitor');

let win = null;
let tray = null;
let server = null;
let watcher = null;

const log = (message) => console.log(`[app] ${message}`);

/* ---------------- ウィンドウ ---------------- */

async function loadBounds() {
  try {
    const saved = JSON.parse(await readFile(BOUNDS_PATH, 'utf8'));
    if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) return saved;
  } catch {
    /* 初回や壊れていたときは既定値 */
  }
  return { width: 1440, height: 920 };
}

async function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const { x, y, width, height } = win.getNormalBounds();
  try {
    await writeFile(BOUNDS_PATH, `${JSON.stringify({ x, y, width, height }, null, 2)}\n`, 'utf8');
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

async function createWindow(url) {
  const bounds = await loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'PR Monitor',
    icon: ICON_PATH,
    backgroundColor: '#101418',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });

  // ダッシュボードのリンク（PR やチェック）は既定のブラウザで開く。
  // アプリのウィンドウを github.com に持っていかない。
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  // メニューバーは出さないので、リロードと開発者ツールだけキーで残す
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      win.webContents.reload();
      event.preventDefault();
    }
    if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 閉じたら終了（トレイに残さない）。サーバの停止は will-quit でやる
  win.on('close', () => saveBounds());
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.once('ready-to-show', () => win.show());

  await win.loadURL(url);
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------------- トレイ ---------------- */

function createTray(url) {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }));
  tray.setToolTip('PR Monitor');
  tray.on('click', showWindow);
  updateTrayMenu(url);
}

function updateTrayMenu(url) {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'ダッシュボードを表示', click: showWindow },
      { label: '今すぐ更新', click: () => refreshNow() },
      { type: 'separator' },
      { label: 'ブラウザで開く', click: () => shell.openExternal(url) },
      // exe 版は設定ファイルがアプリの外にあるので、ここから開けるようにしておく
      { label: '設定ファイルを開く', click: () => shell.openPath(CONFIG_PATH) },
      { label: '設定フォルダを開く', click: () => shell.showItemInFolder(CONFIG_PATH) },
      { type: 'separator' },
      { label: '終了', click: () => app.quit() },
    ])
  );
}

/** トレイの吹き出しに件数を出す。数字の意味は KPI と同じ */
function updateTrayTooltip(payload) {
  const stats = payload?.stats;
  if (!tray || !stats) return;
  tray.setToolTip(
    `PR Monitor — 対応が必要 ${stats.action} / 待ち ${stats.waiting} / マージ可 ${stats.mergeable}（全 ${stats.total}）`
  );
}

function refreshNow() {
  watcher?.pollNow();
  if (win && !win.isDestroyed()) win.webContents.reload();
}

/* ---------------- 通知 ---------------- */

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, icon: ICON_PATH, silent: false });
  notification.on('click', showWindow);
  notification.show();
}

/** 新しく「対応が必要」になった PR を知らせる。多いときはまとめる */
function notifyNewAction(prs) {
  const line = (pr) => `${pr.repo.split('/')[1] ?? pr.repo} #${pr.number} ${pr.title}`;
  if (prs.length === 1) {
    notify('対応が必要な PR', line(prs[0]));
    return;
  }
  notify(`対応が必要な PR が ${prs.length} 件増えました`, prs.slice(0, 4).map(line).join('\n'));
}

/**
 * パッケージ版の初回起動で、データフォルダに config.json が無ければ雛形を置く。
 * （中身が無いと「どこを直せばいいか」が分からないため。監視リポジトリは画面から追加もできる）
 */
async function seedConfigIfMissing() {
  if (existsSync(CONFIG_PATH)) return;
  try {
    const example = JSON.parse(await readFile(join(HERE, '..', 'config.example.json'), 'utf8'));
    // 監視対象は空にする（例のままだと存在しないリポジトリでエラー表示になる）。
    // 画面の「監視リポジトリ」パネルから追加してもらう
    const seed = { ...example, repos: [], disabledRepos: [] };
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
    log(`設定ファイルを作成しました: ${CONFIG_PATH}`);
  } catch (err) {
    log(`設定ファイルの雛形を置けませんでした（既定値で動きます）: ${err.message}`);
  }
}

/* ---------------- 起動 ---------------- */

// 二重起動したら、既にいる方のウィンドウを出して終わる
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await seedConfigIfMissing();
    try {
      server = await ensureServer({ onLog: log, configPath: CONFIG_PATH });
    } catch (err) {
      dialog.showErrorBox('PR Monitor を起動できません', `${err.message}\n\n設定ファイル: ${CONFIG_PATH}\nport を確認してください。`);
      app.quit();
      return;
    }

    await createWindow(server.url);
    createTray(server.url);
    watcher = startWatching(server.url, {
      onNewAction: notifyNewAction,
      onData: updateTrayTooltip,
      onError: (message) => log(`取得に失敗: ${message}`),
    });
  });

  // ウィンドウを閉じたら終了する（開始/終了をアプリの実行と閉じる操作に連動させる）
  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', async (event) => {
    if (!server?.owned) return;
    event.preventDefault();
    watcher?.stop();
    watcher = null;
    const handle = server;
    server = null; // 二重に止めない
    await stopServer(handle, { onLog: log });
    app.quit();
  });
}
