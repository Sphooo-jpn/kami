/*
 * pdfwriter.js — 依存ゼロの PDF バイナリ生成器
 *
 * PDF/1.7 のごく一部（テキスト・ベクター図形・JPEG 画像）だけを、
 * 外部ライブラリを一切使わず素の JS で書き出す。kami エディタの心臓部。
 *
 * 設計:
 *  - 入力 doc は「点(pt)・左上原点・y は下向き」の素直な座標系。
 *    PDF の「左下原点・y 上向き」への変換はこのモジュール内に閉じ込める。
 *  - テキストは標準14フォント + WinAnsiEncoding（=欧文は選択可能）。
 *    WinAnsi で表せない文字（日本語等）は呼び出し側でページごと
 *    ラスタライズ（image op 1枚）してから渡す想定。
 *  - オフセットは必ず「バイト長」で数える（JPEG 等バイナリを含むため）。
 *
 * ブラウザ: window.PDFWriter / Node: module.exports（テスト用）。
 */
(function (global) {
  'use strict';

  /* ---- WinAnsiEncoding (CP1252): Unicode code point -> byte 0..255 ---- */
  var WIN_ANSI = (function () {
    var m = {};
    var i;
    for (i = 0x20; i <= 0x7e; i++) m[i] = i;      // ASCII 可視域
    for (i = 0xa0; i <= 0xff; i++) m[i] = i;      // Latin-1 Supplement
    // 0x80–0x9F の CP1252 特殊割り当て（スマートクォート・ダッシュ等）
    var special = {
      0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
      0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
      0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
      0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
      0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
      0x017e: 0x9e, 0x0178: 0x9f
    };
    for (var k in special) m[k] = special[k];
    return m;
  })();

  /** 文字列全体が WinAnsi で表現可能か（改行/タブは許容） */
  function isWinAnsi(str) {
    if (str == null) return true;
    for (var i = 0; i < str.length; i++) {
      var cp = str.charCodeAt(i);
      if (cp === 0x0a || cp === 0x0d || cp === 0x09) continue;
      if (WIN_ANSI[cp] === undefined) return false;
    }
    return true;
  }

  /** テキストを PDF リテラル文字列のバイト列(各charが1byte)に変換。未対応字は '?' */
  function encodePdfText(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var cp = str.charCodeAt(i);
      var b = WIN_ANSI[cp];
      if (b === undefined) b = 0x3f; // '?'
      var ch = String.fromCharCode(b);
      if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
      else if (b === 0x0a) out += '\\n';
      else if (b === 0x0d) out += '\\r';
      else if (b === 0x09) out += '\\t';
      else out += ch;
    }
    return out;
  }

  /* ---- 数値整形: 指数表記を避け、末尾ゼロを削る ---- */
  function fmt(n) {
    if (!isFinite(n)) n = 0;
    var s = n.toFixed(4);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    return s;
  }

  /* ---- バイト列ビルダ: 文字列(Latin1)とバイナリを連結し、長さを追跡 ---- */
  function ByteBuilder() {
    this.chunks = [];
    this.length = 0;
  }
  ByteBuilder.prototype.pushStr = function (str) {
    var arr = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
    this.chunks.push(arr);
    this.length += arr.length;
  };
  ByteBuilder.prototype.pushBytes = function (u8) {
    this.chunks.push(u8);
    this.length += u8.length;
  };
  ByteBuilder.prototype.toUint8Array = function () {
    var out = new Uint8Array(this.length);
    var off = 0;
    for (var i = 0; i < this.chunks.length; i++) {
      out.set(this.chunks[i], off);
      off += this.chunks[i].length;
    }
    return out;
  };

  /* ---- 標準14フォント名の対応表 ---- */
  var BASE_FONTS = {
    'Helvetica': 1, 'Helvetica-Bold': 1, 'Helvetica-Oblique': 1, 'Helvetica-BoldOblique': 1,
    'Times-Roman': 1, 'Times-Bold': 1, 'Times-Italic': 1, 'Times-BoldItalic': 1,
    'Courier': 1, 'Courier-Bold': 1, 'Courier-Oblique': 1, 'Courier-BoldOblique': 1,
    'Symbol': 1, 'ZapfDingbats': 1
  };
  function normalizeFont(name) {
    return BASE_FONTS[name] ? name : 'Helvetica';
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function col(c) {
    // [r,g,b] を 0..1 に。0..255 でも 0..1 でも受け付ける
    if (!c) return null;
    var r = c[0], g = c[1], b = c[2];
    if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
    return [clamp01(r), clamp01(g), clamp01(b)];
  }

  var KAPPA = 0.5522847498307936;

  /**
   * ページの ops からコンテンツストリーム文字列を生成。
   * @param page {width,height,ops}
   * @param ctx  {font:(baseFontName)->resname, image:(op)->resname, gstate:(alpha)->resname}
   */
  function buildContent(page, ctx) {
    var H = page.height;
    var out = [];
    function push(s) { out.push(s); }
    // top-down y(pt) -> PDF bottom-up y
    function Y(y) { return H - y; }

    function setAlpha(alpha) {
      if (alpha != null && alpha < 1) {
        var g = ctx.gstate(alpha);
        push('/' + g + ' gs');
      }
    }

    var ops = page.ops || [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || !op.type) continue;
      push('q');
      switch (op.type) {
        case 'rect': {
          setAlpha(op.opacity);
          var x = op.x, y = Y(op.y), w = op.w, h = op.h; // rect 左下は (x, y-h)
          var f = col(op.fill), s = col(op.stroke);
          var r = Math.min(op.radius || 0, Math.abs(w) / 2, Math.abs(h) / 2);
          if (f) push(fmt(f[0]) + ' ' + fmt(f[1]) + ' ' + fmt(f[2]) + ' rg');
          if (s) push(fmt(s[0]) + ' ' + fmt(s[1]) + ' ' + fmt(s[2]) + ' RG');
          if (s) push(fmt(op.lineWidth || 1) + ' w');
          if (r > 0) {
            // 角丸: 4隅をベジェで。座標は PDF 系(下原点)。矩形の下辺 = y-h
            var x0 = x, y0 = y - h, x1 = x + w, y1 = y;
            var k = KAPPA;
            push(fmt(x0 + r) + ' ' + fmt(y0) + ' m');
            push(fmt(x1 - r) + ' ' + fmt(y0) + ' l');
            push(fmt(x1 - r + r * k) + ' ' + fmt(y0) + ' ' + fmt(x1) + ' ' + fmt(y0 + r - r * k) + ' ' + fmt(x1) + ' ' + fmt(y0 + r) + ' c');
            push(fmt(x1) + ' ' + fmt(y1 - r) + ' l');
            push(fmt(x1) + ' ' + fmt(y1 - r + r * k) + ' ' + fmt(x1 - r + r * k) + ' ' + fmt(y1) + ' ' + fmt(x1 - r) + ' ' + fmt(y1) + ' c');
            push(fmt(x0 + r) + ' ' + fmt(y1) + ' l');
            push(fmt(x0 + r - r * k) + ' ' + fmt(y1) + ' ' + fmt(x0) + ' ' + fmt(y1 - r + r * k) + ' ' + fmt(x0) + ' ' + fmt(y1 - r) + ' c');
            push(fmt(x0) + ' ' + fmt(y0 + r) + ' l');
            push(fmt(x0) + ' ' + fmt(y0 + r - r * k) + ' ' + fmt(x0 + r - r * k) + ' ' + fmt(y0) + ' ' + fmt(x0 + r) + ' ' + fmt(y0) + ' c');
            push('h');
          } else {
            push(fmt(x) + ' ' + fmt(y - h) + ' ' + fmt(w) + ' ' + fmt(h) + ' re');
          }
          push(f && s ? 'B' : f ? 'f' : s ? 'S' : 'n');
          break;
        }
        case 'ellipse': {
          setAlpha(op.opacity);
          var ex = op.x, ey = Y(op.y), ew = op.w, eh = op.h;
          var cx = ex + ew / 2, cy = ey - eh / 2, rx = ew / 2, ry = eh / 2;
          var ef = col(op.fill), es = col(op.stroke);
          if (ef) push(fmt(ef[0]) + ' ' + fmt(ef[1]) + ' ' + fmt(ef[2]) + ' rg');
          if (es) push(fmt(es[0]) + ' ' + fmt(es[1]) + ' ' + fmt(es[2]) + ' RG');
          if (es) push(fmt(op.lineWidth || 1) + ' w');
          var kx = rx * KAPPA, ky = ry * KAPPA;
          push(fmt(cx + rx) + ' ' + fmt(cy) + ' m');
          push(fmt(cx + rx) + ' ' + fmt(cy + ky) + ' ' + fmt(cx + kx) + ' ' + fmt(cy + ry) + ' ' + fmt(cx) + ' ' + fmt(cy + ry) + ' c');
          push(fmt(cx - kx) + ' ' + fmt(cy + ry) + ' ' + fmt(cx - rx) + ' ' + fmt(cy + ky) + ' ' + fmt(cx - rx) + ' ' + fmt(cy) + ' c');
          push(fmt(cx - rx) + ' ' + fmt(cy - ky) + ' ' + fmt(cx - kx) + ' ' + fmt(cy - ry) + ' ' + fmt(cx) + ' ' + fmt(cy - ry) + ' c');
          push(fmt(cx + kx) + ' ' + fmt(cy - ry) + ' ' + fmt(cx + rx) + ' ' + fmt(cy - ky) + ' ' + fmt(cx + rx) + ' ' + fmt(cy) + ' c');
          push('h');
          push(ef && es ? 'B' : ef ? 'f' : es ? 'S' : 'n');
          break;
        }
        case 'line': {
          setAlpha(op.opacity);
          var ls = col(op.stroke) || [0, 0, 0];
          push(fmt(ls[0]) + ' ' + fmt(ls[1]) + ' ' + fmt(ls[2]) + ' RG');
          push(fmt(op.lineWidth || 1) + ' w');
          if (op.cap) push(op.cap + ' J');
          push(fmt(op.x1) + ' ' + fmt(Y(op.y1)) + ' m ' + fmt(op.x2) + ' ' + fmt(Y(op.y2)) + ' l S');
          break;
        }
        case 'text': {
          setAlpha(op.opacity);
          var tc = col(op.color) || [0, 0, 0];
          var fname = normalizeFont(op.font);
          var res = ctx.font(fname);
          var size = op.size || 12;
          push('BT');
          push('/' + res + ' ' + fmt(size) + ' Tf');
          push(fmt(tc[0]) + ' ' + fmt(tc[1]) + ' ' + fmt(tc[2]) + ' rg');
          if (op.charSpacing) push(fmt(op.charSpacing) + ' Tc');
          // op.y はベースライン(top-down)
          push(fmt(op.x) + ' ' + fmt(Y(op.y)) + ' Td');
          push('(' + encodePdfText(op.text || '') + ') Tj');
          push('ET');
          break;
        }
        case 'image': {
          setAlpha(op.opacity);
          var res2 = ctx.image(op);
          // 画像は単位正方形を CTM で拡大配置。左下 = (x, y-h)
          push(fmt(op.w) + ' 0 0 ' + fmt(op.h) + ' ' + fmt(op.x) + ' ' + fmt(Y(op.y) - op.h) + ' cm');
          push('/' + res2 + ' Do');
          break;
        }
      }
      push('Q');
    }
    return out.join('\n') + '\n';
  }

  /**
   * ドキュメントを PDF バイト列に。
   * @param doc {title?, pages:[{width,height,ops:[...]}]}
   * @returns Uint8Array
   */
  function build(doc) {
    var pages = (doc && doc.pages) || [];
    if (!pages.length) pages = [{ width: 595.28, height: 841.89, ops: [] }];

    var bb = new ByteBuilder();
    var offsets = {}; // objNum -> byte offset
    var nextNum = 1;
    function alloc() { return nextNum++; }
    function beginObj(num) {
      offsets[num] = bb.length;
      bb.pushStr(num + ' 0 obj\n');
    }
    function endObj() { bb.pushStr('\nendobj\n'); }

    // ヘッダ（バイナリコメントで「テキスト扱いされない」ことを明示）
    bb.pushStr('%PDF-1.7\n');
    bb.pushStr('%');
    bb.pushBytes(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]));
    bb.pushStr('\n');

    var catalogNum = alloc();   // 1
    var pagesNum = alloc();     // 2

    // 使用フォントを収集し番号割当（BaseFont -> {num,res}）
    var fontMap = {};
    var fontOrder = [];
    function ensureFont(name) {
      name = normalizeFont(name);
      if (!fontMap[name]) {
        var num = alloc();
        var res = 'F' + fontOrder.length;
        fontMap[name] = { num: num, res: res };
        fontOrder.push(name);
      }
      return fontMap[name];
    }
    // 事前スキャンでフォント確定（オブジェクトは後で書く）
    for (var p = 0; p < pages.length; p++) {
      var pops = pages[p].ops || [];
      for (var q = 0; q < pops.length; q++) {
        if (pops[q] && pops[q].type === 'text') ensureFont(pops[q].font);
      }
    }
    if (fontOrder.length === 0) ensureFont('Helvetica'); // Resources を空にしない保険

    // 各ページ用オブジェクト番号を予約
    var pageNums = [];
    for (var pp = 0; pp < pages.length; pp++) pageNums.push(alloc());

    // --- ページごとにリソース(画像/透明度)とコンテンツを書く ---
    var pageObjs = []; // {num, contentNum, width, height, images:[{res,num}], gstates:[{res,num}], fontsUsed:Set}
    for (var pi = 0; pi < pages.length; pi++) {
      var page = pages[pi];
      var images = [];      // {res, num}
      var imageByRef = new Map();
      var gstates = [];     // {res, num, alpha}
      var gstateByAlpha = {};
      var fontsUsed = {};

      var ctx = {
        font: function (name) {
          var f = ensureFont(name);
          fontsUsed[f.res] = f.num;
          return f.res;
        },
        image: function (op) {
          var key = op;
          if (imageByRef.has(key)) return imageByRef.get(key).res;
          var num = alloc();
          var res = 'Im' + images.length;
          var rec = { res: res, num: num, op: op };
          images.push(rec);
          imageByRef.set(key, rec);
          return res;
        },
        gstate: function (alpha) {
          var a = Math.round(clamp01(alpha) * 1000) / 1000;
          var k = String(a);
          if (gstateByAlpha[k]) return gstateByAlpha[k].res;
          var num = alloc();
          var res = 'GS' + gstates.length;
          var rec = { res: res, num: num, alpha: a };
          gstates.push(rec);
          gstateByAlpha[k] = rec;
          return res;
        }
      };

      var content = buildContent(page, ctx);

      // 画像オブジェクトを書く
      for (var ii = 0; ii < images.length; ii++) {
        var im = images[ii];
        var op = im.op;
        beginObj(im.num);
        var dict = '<< /Type /XObject /Subtype /Image /Width ' + Math.round(op.iw) +
          ' /Height ' + Math.round(op.ih) + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
          op.data.length + ' >>\nstream\n';
        bb.pushStr(dict);
        bb.pushBytes(op.data);
        bb.pushStr('\nendstream');
        endObj();
      }
      // 透明度 ExtGState を書く
      for (var gi = 0; gi < gstates.length; gi++) {
        var gs = gstates[gi];
        beginObj(gs.num);
        bb.pushStr('<< /Type /ExtGState /ca ' + fmt(gs.alpha) + ' /CA ' + fmt(gs.alpha) + ' >>');
        endObj();
      }
      // コンテンツストリームを書く
      var contentNum = alloc();
      beginObj(contentNum);
      var cbytes = new Uint8Array(content.length);
      for (var ci = 0; ci < content.length; ci++) cbytes[ci] = content.charCodeAt(ci) & 0xff;
      bb.pushStr('<< /Length ' + cbytes.length + ' >>\nstream\n');
      bb.pushBytes(cbytes);
      bb.pushStr('\nendstream');
      endObj();

      pageObjs.push({
        num: pageNums[pi], contentNum: contentNum, width: page.width, height: page.height,
        images: images, gstates: gstates, fontsUsed: fontsUsed
      });
    }

    // --- フォントオブジェクト ---
    for (var fo = 0; fo < fontOrder.length; fo++) {
      var fn = fontOrder[fo];
      var frec = fontMap[fn];
      beginObj(frec.num);
      var enc = (fn === 'Symbol' || fn === 'ZapfDingbats') ? '' : ' /Encoding /WinAnsiEncoding';
      bb.pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /' + fn + enc + ' >>');
      endObj();
    }

    // --- ページオブジェクト ---
    for (var po = 0; po < pageObjs.length; po++) {
      var pg = pageObjs[po];
      beginObj(pg.num);
      var fontDict = '';
      for (var res in pg.fontsUsed) fontDict += '/' + res + ' ' + pg.fontsUsed[res] + ' 0 R ';
      if (!fontDict) { var ff = fontMap[fontOrder[0]]; fontDict = '/' + ff.res + ' ' + ff.num + ' 0 R '; }
      var xobjDict = '';
      for (var xi = 0; xi < pg.images.length; xi++) xobjDict += '/' + pg.images[xi].res + ' ' + pg.images[xi].num + ' 0 R ';
      var gsDict = '';
      for (var gj = 0; gj < pg.gstates.length; gj++) gsDict += '/' + pg.gstates[gj].res + ' ' + pg.gstates[gj].num + ' 0 R ';
      var resources = '<< /Font << ' + fontDict + '>>';
      if (xobjDict) resources += ' /XObject << ' + xobjDict + '>>';
      if (gsDict) resources += ' /ExtGState << ' + gsDict + '>>';
      resources += ' /ProcSet [/PDF /Text /ImageC] >>';
      bb.pushStr('<< /Type /Page /Parent ' + pagesNum + ' 0 R /MediaBox [0 0 ' +
        fmt(pg.width) + ' ' + fmt(pg.height) + '] /Resources ' + resources +
        ' /Contents ' + pg.contentNum + ' 0 R >>');
      endObj();
    }

    // --- Pages ツリー ---
    beginObj(pagesNum);
    var kids = '';
    for (var ki = 0; ki < pageNums.length; ki++) kids += pageNums[ki] + ' 0 R ';
    bb.pushStr('<< /Type /Pages /Kids [ ' + kids + '] /Count ' + pageNums.length + ' >>');
    endObj();

    // --- Catalog ---
    beginObj(catalogNum);
    bb.pushStr('<< /Type /Catalog /Pages ' + pagesNum + ' 0 R >>');
    endObj();

    // --- xref ---
    var total = nextNum; // 実際に使った番号数(1..total-1) + 0
    var xrefOffset = bb.length;
    bb.pushStr('xref\n');
    bb.pushStr('0 ' + total + '\n');
    bb.pushStr('0000000000 65535 f \n');
    for (var n = 1; n < total; n++) {
      var off = offsets[n] || 0;
      var s = String(off);
      while (s.length < 10) s = '0' + s;
      bb.pushStr(s + ' 00000 n \n');
    }
    // --- trailer ---
    bb.pushStr('trailer\n<< /Size ' + total + ' /Root ' + catalogNum + ' 0 R');
    if (doc && doc.title) bb.pushStr(' /Info << /Title (' + encodePdfText(String(doc.title)) + ') >>');
    bb.pushStr(' >>\nstartxref\n' + xrefOffset + '\n%%EOF\n');

    return bb.toUint8Array();
  }

  var api = { build: build, isWinAnsi: isWinAnsi, encodePdfText: encodePdfText, WIN_ANSI: WIN_ANSI };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PDFWriter = api;
})(typeof window !== 'undefined' ? window : this);
