#!/usr/bin/env bash
# 紙 (kami) テストランナー
#   1) Node: pdfwriter.js の構造検証（依存ゼロ）
#   2) Chrome があればブラウザ統合テスト（実 measureText / Canvas / 書き出し）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "── (1) pdfwriter 構造テスト (node) ────────────────────"
node test_pdfwriter.js

echo
echo "── (2) ブラウザ統合テスト (headless Chrome) ───────────"
CHROME=""
for c in \
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
  "$(command -v google-chrome 2>/dev/null)" \
  "$(command -v chromium 2>/dev/null)" \
  "$(command -v chromium-browser 2>/dev/null)"; do
  [ -n "$c" ] && [ -x "$c" ] && CHROME="$c" && break
done

if [ -z "$CHROME" ]; then
  echo "スキップ: Chrome/Chromium が見つかりません（手動で test/harness.html を開いてください）"
  exit 0
fi

if command -v wslpath >/dev/null 2>&1; then
  TARGET="$(wslpath -w "$DIR/harness.html")"
else
  TARGET="file://$DIR/harness.html"
fi

OUT="$(mktemp)"
"$CHROME" --headless=new --no-sandbox --disable-gpu --virtual-time-budget=8000 --dump-dom "$TARGET" 2>/dev/null > "$OUT" || true
TITLE="$(grep -o 'KAMI_TEST [0-9]*/[0-9]* [A-Z]*' "$OUT" | head -1)"
# 結果本文を抽出
python3 - "$OUT" <<'PY' 2>/dev/null || true
import re,sys
h=open(sys.argv[1],encoding='utf-8',errors='replace').read()
m=re.search(r'<pre id="RESULTS"[^>]*>(.*?)</pre>',h,re.S)
if m: print(re.sub(r'<[^>]+>','',m.group(1)).replace('&gt;','>').replace('&lt;','<').strip())
PY
rm -f "$OUT"

echo
echo "結果: ${TITLE:-不明}"
case "$TITLE" in
  *OK) echo "✅ すべて合格" ;;
  *) echo "❌ 失敗あり"; exit 1 ;;
esac
