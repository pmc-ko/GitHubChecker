# CLAUDE.md

PR 監視ダッシュボード。**使いながら口頭で改修指示が飛んでくる前提**の構成なので、
「どこを触れば何が変わるか」を1対1に保つことを最優先の制約とする。

## 大原則

- **ダッシュボード本体（`src/` と `public/`）に依存パッケージを持ち込まない**。Node 20+ の標準機能だけ。
  デスクトップアプリ用に `electron` を devDependency として入れているが、**依存は `electron/` の殻に閉じる**
  （`npm install` していなくても `pr-monitor.cmd` のブラウザ版が動く状態を保つ）。
- **ビルド工程を作らない**。`public/` は素の HTML/CSS/ESM。保存 → リロードで反映されること。
- **生成物は手で編集しない**。`public/icons.js`（Material Symbols のパス）は `npm run icons`、
  `electron/icon.png`/`.ico` は `npm run app:icon` で作り直す。
- **責務を混ぜない**。通信 / 判定 / 描画をファイル境界で分ける（下表）。
- **判定ロジックは `src/summarize.mjs` に集約**。GraphQL の形やDOM操作に判定を漏らさない。
- **表示ラベル・アイコン・色の意味づけは `public/app.js` 冒頭の定義テーブルに集約**。
  アイコンは **Material Symbols を名前で参照**（`icon('check_circle')`）。絵文字や記号文字を直接書かない。
- DOM は `textContent` 経由で組む。PR タイトル等を `innerHTML` に流さない。
- 色は `public/style.css` の `:root` トークンのみ。状態色（good/warning/serious/critical）は
  **必ずアイコン+文字と併用**し、色だけで意味を伝えない。
- ダーク値は `@media (prefers-color-scheme: dark)` と `:root[data-theme='dark']` の**両方**に書く。

## 変更したいときに触る場所

| 言われそうなこと | 触るファイル | 触る場所 |
| --- | --- | --- |
| 監視リポジトリを増減 | 画面の「監視リポジトリ」パネル or `config.json` | `repos`（再起動不要） |
| リポジトリの監視を一時停止（取得しない） | 画面のチェックを外す or `config.json` | `disabledRepos`（`src/config.mjs` で `repos` から引く） |
| リポジトリごとの表示/非表示（取得は続ける） | `public/app.js` | `renderRepoFilter()` / `toggleRepoFilter()` / `state.filters.repos` |
| 設定項目を増やす | `src/config.mjs` | `DEFAULTS` → README の表も更新 |
| カンバンの行/列に選べる軸を増やす | `public/app.js` | `DIMENSIONS` に1エントリ（UIの選択肢は自動で増える） |
| 軸の並び順・0件グループの扱い | `public/app.js` | 各 DIMENSION の `order` / `alwaysShow`、`groupBy()` |
| カードの見た目・情報量 | `public/app.js` | `renderCard()`（2段構成: `statusIcons()` + `ciMeterInline()` / タイトル + `metaChipList()`） |
| アイコンを増やす・変える | `tools/make-icons.mjs` の `ICONS` → `npm run icons` | 使う側は定義テーブルで名前を書くだけ |
| 進捗グラフ（4枚）の内容 | `public/app.js` | `renderLinkChart()` / `renderMilestoneChart()` / `renderLabelChart()` / `renderApiChart()` |
| API 残量の見せ方・調整の選択肢 | `public/app.js` | `renderApiChart()` と `REFRESH_CHOICES`（保存は `saveSettings()`） |
| 画面から変えられる設定を増やす | `src/server.mjs` の `POST /api/config/settings` | `intInRange()` で検証してから `saveConfigPatch()` |
| グラフの系列色 | `public/style.css` | `--series-1..3`（状態色とは別枠。変えたら CVD 判定をやり直す） |
| Issue / マイルストンの取得項目 | `src/github.mjs` | `ISSUE_QUERY`（PR 側の紐づきは `closingIssuesReferences`） |
| Issue と PR の紐づけ方 | `src/summarize.mjs` | `buildDashboard()` の `linked`（紐づいた Issue は一覧に出さない） |
| Issue 1件の見え方 | `src/summarize.mjs` の `summarizeIssue()` + `public/app.js` の `renderIssueDetails()` | バケットは `issue` 固定 |
| デスクトップアプリの窓・トレイ・終了 | `electron/main.mjs` | 閉じたら終了（`window-all-closed` → `app.quit()` → `will-quit` でサーバ停止） |
| 設定ファイルの置き場所 | `src/config.mjs` の `CONFIG_PATH` | 既定はリポジトリ直下。`PR_MONITOR_CONFIG` で差し替え（exe 版は `electron/main.mjs` が userData を渡す） |
| 通知を出す条件・文面 | `electron/watch.mjs` | `WATCHED_BUCKET` と `notifyNewAction()`（`main.mjs`） |
| アプリからのサーバ起動・停止 | `electron/server-process.mjs` | `ensureServer()` / `stopServer()` |
| カード左端の色（深刻さ） | `public/app.js` | `cardTone()` |
| ピボットのレイアウト | `public/style.css` | `.pivot` / `.pivot-cell` / `.pivot-colhead` |
| 画面から設定を書き換えたい | `src/server.mjs` + `src/config.mjs` | `POST /api/config/repos` と `saveConfigPatch()` |
| GitHub から取る項目を増やす | `src/github.mjs` | `PR_QUERY` の GraphQL |
| 「対応が必要」の条件を変える | `src/summarize.mjs` | `classify()` |
| CI 全体状態の決め方を変える | `src/summarize.mjs` | `rollUpChecks()` |
| チェック結論の扱いを変える | `src/summarize.mjs` | `CHECK_CONCLUSION` / `STATUS_CONTEXT_STATE` |
| レビュー状態の判定を変える | `src/summarize.mjs` | `summarizeReviews()` |
| KPI タイルの内容を変える | `public/app.js` | `renderKpis()` の `tiles` |
| バッジの文言・記号・色 | `public/app.js` | `CI_STATE` / `REVIEW_STATE` / `CHECK_ICON` / `REVIEW_ITEM` |
| バケット（状態）の定義と並び順 | `public/app.js` の `BUCKETS`/`BUCKET_ORDER` + `src/summarize.mjs` の `classify()` | 両方の `key` を一致させる |
| リストの行に情報を足す | `public/app.js` | `renderPr()` |
| 詳細の中身を足す | `public/app.js` | `renderDetails()` |
| 絞り込み条件を足す | `public/app.js` | `state.filters` → `applyFilters()` → `index.html` にUI |
| レイアウト・色 | `public/style.css` | 上部の `:root` トークン優先 |
| API 経路・キャッシュ | `src/server.mjs` | `getDashboard()` |
| テストの前提データ | `test/fixture.mjs` | GraphQL と同じ形。クエリを変えたらここも合わせる |
| DOM スタブ（新しい DOM API を使ったとき） | `test/dom-stub.mjs` | `npm test` と `npm run smoke` が共有 |
| CI / リリースの手順 | `.github/workflows/ci.yml` / `release.yml` | CI は **`npm install` をしない**（依存混入の検知を兼ねる） |
| 起動/停止の判定・止め方 | `src/probe.mjs`（判定と依頼）+ `src/stop.mjs`（CLI） | `POST /api/shutdown` は `src/server.mjs` |

## 確認手順（変更したら必ず）

```sh
npm test                            # まずこれ（固定データ。GitHub もトークンも要らない）
node src/server.mjs --no-open &     # 起動（既に起動中ならスキップ）
npm run smoke                       # 実データで描画が通るか。UI を触ったら必須
npm run dump -- --repo <名前> --pr <番号>   # 判定を変えたら実データで内訳を確認
npm run app                         # 見た目を変えたら実アプリでも見る（F5 でリロード）
```

`npm run smoke` は最小 DOM スタブ上で `public/app.js` を実行する。
**新しい DOM API を使ったらスタブ側（`test/smoke.mjs`）にも足す**こと
（アイコンの SVG のために `createElementNS` を足してある）。
見た目の確認はできないので、レイアウト変更は人間の目でも見てもらう。

## 事実として押さえておくこと

- ライセンスは **AGPL-3.0-only**。ファイルを増やすときも同じ扱い。取り込むコードのライセンスに注意
  （アイコンは Material Symbols = Apache-2.0、`public/icons.js` の冒頭に出典を書いてある）。
- **GraphQL のレート制限は「要求ノード数」で決まる**（5000点/時）。`first:` を増やすと掛け算で効く。
  1回のコストはフッタの「今回 n点」と「進捗」パネルの円グラフに出る（`rateLimit.fetchCost`）。
  実測: 6リポジトリ / PR 28 / Issue 88 で 24点。`refreshSeconds` との掛け算で見積もること。
  クエリを増やすときは**その場で1回のコストを測る**（`?refresh=1` を叩いて fetchCost を見る）。

- 認証は `gh auth token` → 環境変数 `GITHUB_TOKEN`/`GH_TOKEN` の順で解決（`src/token.mjs`）。
- `reviewDecision` はブランチ保護が未設定だと `null`。実績から導くフォールバックが入っている。
- `mergeable` は GitHub 側が非同期計算するので初回 `UNKNOWN` がありうる。
  `src/server.mjs` の `mergeableMemo` が同一 HEAD の確定値を覚えて埋め戻す。ここを消すと
  コンフリクト件数が取得ごとにブレる。
- チェックは**最新コミットに紐づくものだけ**を見る。Draft で workflow が動かない設定なら「CIなし」。
- 表示（カンバン/リスト・軸）は `localStorage` の `pr-monitor-prefs`、絞り込みは `pr-monitor-filters`、
  テーマは `pr-monitor-theme` に保存している。壊れた値は無視して初期値に戻す作りにしてある。
- `pr-monitor.cmd` は二重起動しない。ポートが埋まっていたら `/api/ping` で自分か判定し、
  自分ならブラウザを開いて exit 0（`.cmd` が pause しない）、別アプリなら exit 1。
- 停止は `pr-monitor-stop.cmd`（= `npm run stop`）。`/api/ping` で自分だと確認してから
  `POST /api/shutdown` を送り、ポートが空くまで確認する。居なければ何もせず exit 0。
  `.cmd` の末尾は `timeout` の失敗を拾わないよう `exit /b 0` で閉じている（消すと
  スクリプトから呼んだときだけ exit 1 になる）。
- リポジトリの書き込み API は 127.0.0.1 待ち受け + Origin チェック + `parseRepos()` の
  文字種検証で守っている。設定を書き換える口を増やすときは同じ3点を踏襲する。
- リポジトリの「絞り込み」と「監視の ON/OFF」は**別物**。前者は `state.filters.repos`
  （localStorage、取得は止めない）、後者は `config.json` の `disabledRepos`（GitHub に問い合わせない）。
  `POST /api/config/repos` は `{repos: 候補すべて, disabledRepos: 止めるもの}` を受けて
  サーバ側で引き算する（正規化の基準を1か所にするため。画面から名前を突き合わせない）。
- `repos` と `disabledRepos` の両方に居たら**有効が勝つ**（`loadConfig()` で無効側から落とす）。
- Issue は **PR に紐づいていないものだけ**一覧に出す（紐づいたものは PR 側のチップとして出る）。
  だから `pullRequests` と `issues` を足しても重複しない。3パターンの内訳は `stats.prOnly/both/issueOnly`。
- **マイルストンの進捗率は「クローズ済み Issue ÷ Issue 全体」で自前計算**している。GitHub の
  `progressPercentage` は PR も母数に入るため一致しない（そちらは `githubProgressPercentage` に保持し tooltip に出す）。
- ラベル軸は**多値**（1件が複数の列に出る）。カード総数が件数を超えるのは仕様。`groupsOf()` を通すこと。
- `.pivot-cell > * { flex: 0 0 auto }` を消すと、件数の多い列でカードが flex-shrink で潰れる（Issue 列で顕在化）。
- Electron 版は **同梱 Node（`ELECTRON_RUN_AS_NODE`）で `src/server.mjs` を起動**する。既に動いている
  サーバがあればそれを使い、終了時にも止めない（`owned` フラグ）。
- **exe 化すると `resources\app` の中は「見えない・書けない」前提**で考える。設定は
  `app.getPath('userData')`（`%APPDATA%\github-pr-checker\config.json`）に置き、`PR_MONITOR_CONFIG`
  でサーバ側に渡している。初回起動時は `config.example.json` から `repos: []` の雛形を作る
  （例のままだと存在しないリポジトリでエラー表示になる）。パスは画面とトレイから辿れるようにしてある。
- **ウィンドウを閉じたら終了**（トレイに残らない）。自分で起動したサーバもそこで止まる。
  常駐させたいと言われたら `window-all-closed` と `close` の扱いを戻す。
- 通知は `electron/watch.mjs` が `/api/dashboard?refresh=1` を定期的に叩いて「対応が必要」の増加を見ている。
  画面を隠していても更新が続くのはこれのおかげ（ブラウザ側の自動更新は非表示タブでは止まる）。
