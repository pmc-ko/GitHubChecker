// public/icons.js（Material Symbols のパスデータ）を生成する一度きりのスクリプト。
//   npm run icons        ← ネットに出るのはこの時だけ。生成物はコミットする
//
// アイコンを増やしたいときは ICONS に Material Symbols の名前を足して再実行する。
// パスデータは手書きしない（google/material-design-icons の値をそのまま埋め込む）。
// 出典: https://github.com/google/material-design-icons （Apache License 2.0）

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 使っているアイコン。用途は public/app.js の定義テーブル側にコメントがある */
const ICONS = [
  'check_circle', // CI成功 / 承認
  'cancel', // CI失敗
  'hourglass_top', // CI実行中
  'block', // CI中断 / 棄却
  'remove', // 対象外・なし
  'horizontal_rule', // スキップ
  'error', // 変更要求
  'schedule', // レビュー待ち / 依頼中
  'chat_bubble', // コメントのみ
  'edit_note', // レビュー下書き
  'radio_button_unchecked', // Issueのみ
  'link', // Issue+PR
  'call_split', // PRのみ
  'warning', // コンフリクト
  'flag', // マイルストン
  'label', // ラベル
  'chevron_right', // 行/カードの開閉
  'swap_horiz', // 軸の入れ替え
  'contrast', // テーマ切り替え
];

const BASE = 'https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons.js');

async function fetchPath(name) {
  const url = `${BASE}/${name}/materialsymbolsoutlined/${name}_24px.svg`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const svg = await response.text();
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);
  if (!paths.length || !viewBox) throw new Error(`${name}: パスを取り出せませんでした`);
  return { viewBox, d: paths.join(' ') };
}

const entries = [];
let viewBox = null;
for (const name of ICONS) {
  const icon = await fetchPath(name);
  if (viewBox && icon.viewBox !== viewBox) throw new Error(`${name}: viewBox が他と違います (${icon.viewBox})`);
  viewBox = icon.viewBox;
  entries.push([name, icon.d]);
  console.error(`ok ${name} (${icon.d.length} bytes)`);
}

const body = entries.map(([name, d]) => `  ${name}: '${d}',`).join('\n');
const file = `// Material Symbols (Outlined) のパスデータ。Apache License 2.0。
// google/material-design-icons から \`npm run icons\` で生成している（手で編集しない）。
// アイコンを増やすときは tools/make-icons.mjs の ICONS に名前を足して再生成する。

export const ICON_VIEWBOX = '${viewBox}';

export const ICON_PATHS = {
${body}
};
`;

await writeFile(OUT, file, 'utf8');
console.error(`\n${OUT} に ${entries.length} 個書き出しました`);
