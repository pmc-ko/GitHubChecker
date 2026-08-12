// アイコン（electron/icon.png と icon.ico）を生成する一度きりのスクリプト。
//   node electron/make-icon.mjs
// 画像ファイルをリポジトリに置きたくない/描き直したいときだけ実行する。
// 依存を増やさないために zlib で PNG を手組みしている（描き変えるのは drawPixel() だけ）。

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 256;
const HERE = dirname(fileURLToPath(import.meta.url));

/** 背景（角丸四角）の色と、電波マークの色 */
const BG = [31, 111, 235, 255];
const FG = [255, 255, 255, 255];

/** 電波の中心（左下）と、扇形の角度範囲（度。0=右, 90=上） */
const ORIGIN = { x: 66, y: 190 };
const FAN = { from: 6, to: 84 };
const ARCS = [46, 88, 130];
const ARC_WIDTH = 15;
const DOT_RADIUS = 17;

/** 0→1 の滑らかな境界。ギザギザを抑えるだけ */
function edge(distance, softness = 1.6) {
  return Math.min(1, Math.max(0, 0.5 - distance / softness));
}

/** 角丸四角の内側らしさ（0→外, 1→内） */
function roundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return edge(Math.hypot(x - cx, y - cy) - radius);
}

function drawPixel(x, y) {
  const px = x + 0.5;
  const py = y + 0.5;
  const inside = roundedRect(px, py, SIZE, 52);
  if (inside <= 0) return [0, 0, 0, 0];

  const dx = px - ORIGIN.x;
  const dy = ORIGIN.y - py;
  const distance = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  let mark = edge(distance - DOT_RADIUS);
  if (angle >= FAN.from && angle <= FAN.to) {
    for (const radius of ARCS) {
      mark = Math.max(mark, edge(Math.abs(distance - radius) - ARC_WIDTH / 2));
    }
  }

  const alpha = inside;
  const mix = (channel) => Math.round(BG[channel] + (FG[channel] - BG[channel]) * mark);
  return [mix(0), mix(1), mix(2), Math.round(255 * alpha)];
}

/* ---------------- PNG 書き出し ---------------- */

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

function encodePng(size) {
  // 各行の先頭にフィルタ種別（0 = フィルタなし）を置く生の RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let at = 0;
  for (let y = 0; y < size; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = drawPixel(x, y);
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
      at += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 6; // カラータイプ RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG を1枚だけ収めた .ico（Vista 以降は PNG 圧縮のエントリを読める） */
function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // タイプ: アイコン
  header.writeUInt16LE(1, 4); // 枚数
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 256 は 0 で表す
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); // 色プレーン
  entry.writeUInt16LE(32, 6); // ビット深度
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

const png = encodePng(SIZE);
writeFileSync(join(HERE, 'icon.png'), png);
writeFileSync(join(HERE, 'icon.ico'), encodeIco(png, SIZE));
console.log(`icon.png (${png.length} bytes) と icon.ico を書き出しました`);
