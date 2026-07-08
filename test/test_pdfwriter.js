/* Node テスト: pdfwriter.js の構造健全性を検証（依存ゼロ） */
'use strict';
var PDFWriter = require('../pdfwriter.js');

var fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; } else { fails++; console.error('  ✗ ' + msg); }
}

/* 1x1 の最小 baseline JPEG（白）。DCTDecode 用のダミー。 */
var TINY_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

var doc = {
  title: 'kami test',
  pages: [
    {
      width: 595.28, height: 841.89, ops: [
        { type: 'rect', x: 40, y: 40, w: 200, h: 100, fill: [230, 60, 60], stroke: [0, 0, 0], lineWidth: 2, radius: 8, opacity: 0.8 },
        { type: 'ellipse', x: 300, y: 40, w: 120, h: 120, fill: [60, 120, 230] },
        { type: 'line', x1: 40, y1: 200, x2: 500, y2: 200, stroke: [20, 20, 20], lineWidth: 3 },
        { type: 'text', x: 40, y: 260, size: 24, font: 'Helvetica-Bold', color: [17, 24, 39], text: 'Hello, kami! (WYSIWYG) — “quotes”' },
        { type: 'text', x: 40, y: 300, size: 12, font: 'Times-Roman', color: [80, 80, 80], text: 'Vector, selectable text.' },
        { type: 'image', x: 40, y: 500, w: 160, h: 120, iw: 1, ih: 1, data: TINY_JPEG, opacity: 1 }
      ]
    },
    { width: 612, height: 792, ops: [
        { type: 'text', x: 50, y: 60, size: 18, font: 'Courier', color: [0,0,0], text: 'Page 2 / Letter' }
    ] }
  ]
};

var bytes = PDFWriter.build(doc);
ok(bytes instanceof Uint8Array, 'build returns Uint8Array');
ok(bytes.length > 300, 'output has reasonable length (' + bytes.length + ')');

/* バイト列を Latin1 文字列化して構造検査 */
var s = '';
for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);

ok(s.slice(0, 8) === '%PDF-1.7', 'has %PDF-1.7 header');
ok(s.indexOf('%%EOF') >= 0, 'has %%EOF');
ok(/\/Type\s*\/Catalog/.test(s), 'has Catalog');
ok(/\/Type\s*\/Pages/.test(s), 'has Pages tree');
ok((s.match(/\/Type\s*\/Page[^s]/g) || []).length === 2, 'has 2 Page objects');
ok(s.indexOf('/DCTDecode') >= 0, 'image uses DCTDecode');
ok(s.indexOf('/WinAnsiEncoding') >= 0, 'text font uses WinAnsi');
ok(s.indexOf('/ExtGState') >= 0, 'opacity emits ExtGState');
ok(/BT[\s\S]*Tj[\s\S]*ET/.test(s), 'has text show operator');
ok(s.indexOf(' re\n') >= 0 || s.indexOf(' re ') >= 0 || / c\n/.test(s), 'has rect/curve path');

/* --- xref オフセット健全性: 各エントリが "N 0 obj" を正しく指すか --- */
var xrefIdx = s.lastIndexOf('\nxref\n');
ok(xrefIdx >= 0, 'has xref section');
var startxrefIdx = s.lastIndexOf('startxref');
var declaredOffset = parseInt(s.slice(startxrefIdx).match(/startxref\s+(\d+)/)[1], 10);
ok(declaredOffset === xrefIdx + 1, 'startxref points to xref keyword (decl=' + declaredOffset + ', actual=' + (xrefIdx + 1) + ')');

var xrefBody = s.slice(xrefIdx + 1);
var m = xrefBody.match(/^xref\n0 (\d+)\n/);
ok(!!m, 'xref subsection header present');
var count = parseInt(m[1], 10);
var lines = xrefBody.split('\n');
// lines[0]="xref", lines[1]="0 N", lines[2..]=entries
var allOffsetsOk = true;
for (var n = 1; n < count; n++) {
  var entry = lines[2 + n];
  var off = parseInt(entry.slice(0, 10), 10);
  var expect = n + ' 0 obj';
  var got = s.slice(off, off + expect.length);
  if (got !== expect) { allOffsetsOk = false; console.error('    obj ' + n + ' offset ' + off + ' -> "' + got + '" (expected "' + expect + '")'); }
}
ok(allOffsetsOk, 'every xref offset points to its object header');

/* Size は total 番号数と一致 */
var sizeMatch = s.match(/\/Size (\d+)/);
ok(sizeMatch && parseInt(sizeMatch[1], 10) === count, 'trailer /Size matches xref count');

/* Stream の /Length が実バイト数と一致するか（コンテンツストリーム1つを抜き検査） */
var streamRe = /<< \/Length (\d+) >>\nstream\n/g;
var mm, lenOk = true;
while ((mm = streamRe.exec(s)) !== null) {
  var declLen = parseInt(mm[1], 10);
  var dataStart = mm.index + mm[0].length;
  var endIdx = s.indexOf('\nendstream', dataStart);
  var actual = endIdx - dataStart;
  if (actual !== declLen) { lenOk = false; console.error('    stream /Length ' + declLen + ' != actual ' + actual); }
}
ok(lenOk, 'content stream /Length values are exact');

/* isWinAnsi 判定 */
ok(PDFWriter.isWinAnsi('Hello — “quotes” café') === true, 'isWinAnsi: latin+smartquotes ok');
ok(PDFWriter.isWinAnsi('日本語テキスト') === false, 'isWinAnsi: Japanese -> false');
ok(PDFWriter.isWinAnsi('emoji 🎉') === false, 'isWinAnsi: emoji -> false');

console.log('\npdfwriter: ' + passes + ' passed, ' + fails + ' failed');

/* PDF ファイルを書き出して手動確認用に残す */
try {
  require('fs').writeFileSync(require('path').join(__dirname, 'out.pdf'), Buffer.from(bytes));
  console.log('wrote test/out.pdf (' + bytes.length + ' bytes)');
} catch (e) {}

process.exit(fails ? 1 : 0);
