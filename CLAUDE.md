# CLAUDE.md

PR 監視ダッシュボード。**使いながら口頭で改修指示が飛んでくる前提**の構成なので、
「どこを触れば何が変わるか」を1対1に保つことを最優先の制約とする。

## 大原則

- **依存パッケージを増やさない**。Node 20+ の標準機能だけで書く（`npm install` 不要を維持）。
- **ビルド工程を作らない**。`public/` は素の HTML/CSS/ESM。保存 → リロードで反映されること。
- **責務を混ぜない**。通信 / 判定 / 描画をファイル境界で分ける（下表）。
- **判定ロジックは `src/summarize.mjs` に集約**。GraphQL の形やDOM操作に判定を漏らさない。
- **表示ラベル・アイコン・色の意味づけは `public/app.js` 冒頭の定義テーブルに集約**。
- DOM は `textContent` 経由で組む。PR タイトル等を `innerHTML` に流さない。
- 色は `public/style.css` の `:root` トークンのみ。状態色（good/warning/serious/critical）は
  **必ずアイコン+文字と併用**し、色だけで意味を伝えない。
- ダーク値は `@media (prefers-color-scheme: dark)` と `:root[data-theme='dark']` の**両方**に書く。

## 変更したいときに触る場所

| 言われそうなこと | 触るファイル | 触る場所 |
| --- | --- | --- |
| 監視リポジトリを増減 | `config.json` | `repos`（再起動不要） |
| 設定項目を増やす | `src/config.mjs` | `DEFAULTS` → README の表も更新 |
| GitHub から取る項目を増やす | `src/github.mjs` | `PR_QUERY` の GraphQL |
| 「対応が必要」の条件を変える | `src/summarize.mjs` | `classify()` |
| CI 全体状態の決め方を変える | `src/summarize.mjs` | `rollUpChecks()` |
| チェック結論の扱いを変える | `src/summarize.mjs` | `CHECK_CONCLUSION` / `STATUS_CONTEXT_STATE` |
| レビュー状態の判定を変える | `src/summarize.mjs` | `summarizeReviews()` |
| KPI タイルの内容を変える | `public/app.js` | `renderKpis()` の `tiles` |
| バッジの文言・記号・色 | `public/app.js` | `CI_STATE` / `REVIEW_STATE` / `CHECK_ICON` / `REVIEW_ITEM` |
| グループ分けと並び順 | `public/app.js` の `BUCKETS` + `src/summarize.mjs` の `classify()` | 両方の `key` を一致させる |
| 一覧に列・情報を足す | `public/app.js` | `renderPr()` |
| 詳細の中身を足す | `public/app.js` | `renderDetails()` |
| 絞り込み条件を足す | `public/app.js` | `state.filters` → `applyFilters()` → `index.html` にUI |
| レイアウト・色 | `public/style.css` | 上部の `:root` トークン優先 |
| API 経路・キャッシュ | `src/server.mjs` | `getDashboard()` |

## 確認手順（変更したら必ず）

```sh
node src/server.mjs --no-open &     # 起動（既に起動中ならスキップ）
npm run smoke                       # 描画が通るか。UI を触ったら必須
npm run dump -- --repo <名前> --pr <番号>   # 判定を変えたら実データで内訳を確認
```

`npm run smoke` は最小 DOM スタブ上で `public/app.js` を実行する。
**新しい DOM API を使ったらスタブ側（`test/smoke.mjs`）にも足す**こと。
見た目の確認はできないので、レイアウト変更は人間の目でも見てもらう。

## 事実として押さえておくこと

- 認証は `gh auth token` → 環境変数 `GITHUB_TOKEN`/`GH_TOKEN` の順で解決（`src/token.mjs`）。
- `reviewDecision` はブランチ保護が未設定だと `null`。実績から導くフォールバックが入っている。
- `mergeable` は GitHub 側が非同期計算するので初回 `UNKNOWN` がありうる。
  `src/server.mjs` の `mergeableMemo` が同一 HEAD の確定値を覚えて埋め戻す。ここを消すと
  コンフリクト件数が取得ごとにブレる。
- チェックは**最新コミットに紐づくものだけ**を見る。Draft で workflow が動かない設定なら「CIなし」。
