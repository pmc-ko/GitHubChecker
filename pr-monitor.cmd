@echo off
rem PR Monitor を起動してブラウザで開く。
rem 既に起動している場合はサーバを二重に立てず、ブラウザで開くだけで終わる。
rem このファイルをダブルクリック、またはショートカットを作って使う。

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org/ からインストールしてください。
  pause
  exit /b 1
)

node src\server.mjs %*
if errorlevel 1 (
  echo.
  echo 起動に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)
