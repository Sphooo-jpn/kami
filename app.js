/* ============================================================
   紙 (kami) — app.js
   依存ゼロの PDF WYSIWYG エディタ。全ロジックをこの IIFE に収める。
   モデル（pt 単位・左上原点）を 3 つのレンダラで共有する:
     1. DOM      … 編集ビュー（.sheet 上に絶対配置 + SVG 図形）
     2. Canvas   … ラスタ書き出し / サムネイル
     3. PDFWriter… ベクター書き出し（欧文は選択可能テキスト）
   日本語など WinAnsi 外の文字を含むページは Canvas 経由で高品質画像化。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------------------------------------------------- 定数・下準備 */
  var PT2PX = 96 / 72;               // 1pt = 1.3333px (96dpi)
  var STORAGE = 'kami.v1';
  var THEME_KEY = 'kami.theme';
  var MIN = 6;                       // 最小サイズ(pt)

  var PAGE_PRESETS = [
    { id: 'a4', name: 'A4', w: 595.28, h: 841.89 },
    { id: 'letter', name: 'Letter', w: 612, h: 792 },
    { id: 'a5', name: 'A5', w: 419.53, h: 595.28 },
    { id: 'a3', name: 'A3', w: 841.89, h: 1190.55 },
    { id: 'b5', name: 'B5(JIS)', w: 515.91, h: 728.5 },
    { id: 'legal', name: 'Legal', w: 612, h: 1008 },
    { id: 'square', name: '正方形', w: 595.28, h: 595.28 },
    { id: 'card', name: '名刺', w: 255.12, h: 155.91 }
  ];

  var FONT_CSS = {
    Helvetica: '"Helvetica Neue", Helvetica, Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif',
    Times: '"Times New Roman", Times, "Hiragino Mincho ProN", "Yu Mincho", serif',
    Courier: '"Courier New", Courier, monospace'
  };
  var PDF_FONT = {
    Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
    Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
    Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']
  };
  function pdfFontName(el) {
    var arr = PDF_FONT[el.font] || PDF_FONT.Helvetica;
    return arr[(el.bold ? 1 : 0) + (el.italic ? 2 : 0)];
  }
  function cssFont(el, sizePx) {
    return (el.italic ? 'italic ' : '') + (el.bold ? '700 ' : '400 ') + sizePx + 'px ' + FONT_CSS[el.font];
  }

  /* -------- DOM helpers -------- */
  var $ = function (id) { return document.getElementById(id); };
  function h(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'html') e.innerHTML = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'style') e.setAttribute('style', props[k]);
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]);
      else if (props[k] != null && props[k] !== false) e.setAttribute(k, props[k]);
    }
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  function uid() { return 'e' + (uid._n = (uid._n || 0) + 1) + '_' + (Date.now() % 100000); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function isCJK(ch) {
    var c = ch.charCodeAt(0);
    return (c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c > 0x1f000;
  }

  /* -------- color helpers -------- */
  function hexToRgb(hex) {
    if (!hex) return null;
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) { m = /^#?([0-9a-f]{3})$/i.exec(hex); if (m) hex = '#' + m[1].split('').map(function (c) { return c + c; }).join(''); else return [0, 0, 0]; }
    var n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* ---------------------------------------------------------- 状態 */
  var doc, assets = {};          // assets: id -> {src, natW, natH}; append-only（Undo安全のため）
  var imgCache = {};             // id -> HTMLImageElement（デコード済み）
  var state = {
    tool: 'select', selId: null, currentPage: 0, zoom: 1, snap: true,
    editing: false, dragging: false
  };
  var undoStack = [], redoStack = [];
  var els = {};                  // ノード参照キャッシュは使わず data 属性で引く

  function newDoc() {
    return { title: '無題のドキュメント', pages: [ newPage('a4') ] };
  }
  function newPage(presetId) {
    var p = PAGE_PRESETS.find(function (x) { return x.id === presetId; }) || PAGE_PRESETS[0];
    return { id: uid(), w: p.w, h: p.h, bg: '#ffffff', els: [] };
  }

  /* 現在のページ（選択要素があればその親、無ければ currentPage） */
  function curPageIndex() {
    if (state.selId) { var f = findEl(state.selId); if (f) return f.pi; }
    return clamp(state.currentPage, 0, doc.pages.length - 1);
  }
  function findEl(id) {
    for (var pi = 0; pi < doc.pages.length; pi++) {
      var arr = doc.pages[pi].els;
      for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return { el: arr[i], pi: pi, i: i, page: doc.pages[pi] };
    }
    return null;
  }
  function selectedEl() { var f = state.selId && findEl(state.selId); return f ? f.el : null; }

  /* ---------------------------------------------------------- 要素ファクトリ */
  function makeElement(type, x, y, w, h2) {
    var base = { id: uid(), type: type, x: x, y: y, w: w, h: h2, opacity: 1 };
    if (type === 'text') Object.assign(base, {
      text: 'テキスト', font: 'Helvetica', size: 16, bold: false, italic: false,
      underline: false, color: '#16181f', align: 'left', lineHeight: 1.3
    });
    else if (type === 'rect') Object.assign(base, { fill: '#dbe4ff', stroke: '#3b4a6b', strokeWidth: 0, radius: 6 });
    else if (type === 'ellipse') Object.assign(base, { fill: '#ffe0e6', stroke: '#c23a56', strokeWidth: 0, radius: 0 });
    else if (type === 'line') Object.assign(base, { stroke: '#16181f', strokeWidth: 2, dir: '\\' });
    else if (type === 'image') Object.assign(base, { asset: null });
    return base;
  }

  /* ---------------------------------------------------------- テキスト折返し（3レンダラ共有） */
  var _measCanvas = document.createElement('canvas');
  var _mctx = _measCanvas.getContext('2d');
  function tokenize(text) {
    var t = [], word = '';
    function flush() { if (word) { t.push(word); word = ''; } }
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === ' ' || ch === '\t') { flush(); t.push(' '); }
      else if (isCJK(ch)) { flush(); t.push(ch); }
      else word += ch;
    }
    flush();
    return t;
  }
  /* ctx.font は呼び出し側で設定済み。maxWidth はフォント設定と同じ単位。 */
  function wrapParagraph(ctx, text, maxWidth) {
    if (text === '') return [''];
    var tokens = tokenize(text), lines = [], cur = '';
    function W(s) { return ctx.measureText(s).width; }
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i], trial = cur + tk;
      if (W(trial) <= maxWidth || cur === '') {
        if (cur === '' && tk !== ' ' && W(tk) > maxWidth) {
          var part = '';
          for (var j = 0; j < tk.length; j++) {
            var c = tk[j];
            if (W(part + c) > maxWidth && part !== '') { lines.push(part); part = c; }
            else part += c;
          }
          cur = part;
        } else cur = trial;
      } else {
        lines.push(cur.replace(/\s+$/, ''));
        cur = (tk === ' ') ? '' : tk;
      }
    }
    lines.push(cur.replace(/\s+$/, ''));
    return lines;
  }
  /* el のテキストを行に。unit=pt をそのまま px として測る（比率は全レンダラで一致） */
  function layoutText(el, ctx) {
    ctx = ctx || _mctx;
    ctx.font = cssFont(el, el.size);
    var paras = String(el.text == null ? '' : el.text).split('\n');
    var lines = [];
    for (var p = 0; p < paras.length; p++) {
      var wl = wrapParagraph(ctx, paras[p], el.w);
      for (var i = 0; i < wl.length; i++) lines.push({ text: wl[i], width: ctx.measureText(wl[i]).width });
    }
    return { lines: lines, lineH: el.size * (el.lineHeight || 1.3), ascent: el.size * 0.8 };
  }

  /* ---------------------------------------------------------- レンダリング(DOM) */
  var canvasEl = $('canvas');
  function displayScale() { return PT2PX * state.zoom; }

  function renderAll() {
    var sc = displayScale();
    canvasEl.innerHTML = '';
    doc.pages.forEach(function (page, pi) {
      var sheet = h('div', { class: 'sheet', 'data-page': pi,
        style: 'width:' + (page.w * sc) + 'px;height:' + (page.h * sc) + 'px;background:' + page.bg + ';' });
      if (pi === state.currentPage && !state.selId) sheet.classList.add('selected-page');
      sheet.appendChild(h('div', { class: 'sheet-label',
        text: 'ページ ' + (pi + 1) + ' · ' + Math.round(page.w) + '×' + Math.round(page.h) + 'pt' }));
      page.els.forEach(function (el) { sheet.appendChild(renderElement(el, sc)); });
      canvasEl.appendChild(sheet);
    });
    renderSelection();
    updateStatus();
  }

  function renderElement(el, sc) {
    var node = h('div', { class: 'el type-' + el.type, 'data-id': el.id,
      style: 'left:' + (el.x * sc) + 'px;top:' + (el.y * sc) + 'px;width:' + (el.w * sc) +
        'px;height:' + (el.h * sc) + 'px;opacity:' + el.opacity + ';' });
    if (el.type === 'text') {
      var t = h('div', { class: 'txt', style:
        'font:' + cssFont(el, el.size * sc) + ';color:' + el.color + ';text-align:' + el.align +
        ';line-height:' + el.lineHeight + ';text-decoration:' + (el.underline ? 'underline' : 'none') + ';' });
      t.textContent = el.text;
      node.appendChild(t);
    } else if (el.type === 'image') {
      var a = el.asset && assets[el.asset];
      if (a) node.appendChild(h('img', { src: a.src }));
      else { node.classList.add('img-empty'); node.style.background = 'var(--surface-3)'; node.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#999;font-size:12px">画像</div>'; }
    } else {
      node.innerHTML = shapeSVG(el);
    }
    return node;
  }

  function shapeSVG(el) {
    var w = el.w, ht = el.h;
    var sw = (el.stroke && el.strokeWidth > 0) ? el.strokeWidth : 0, ins = sw / 2;
    var stroke = sw > 0 ? el.stroke : 'none';
    var open = '<svg width="100%" height="100%" viewBox="0 0 ' + w + ' ' + ht +
      '" preserveAspectRatio="none" style="overflow:visible;display:block">';
    if (el.type === 'rect') {
      return open + '<rect x="' + ins + '" y="' + ins + '" width="' + Math.max(0, w - sw) + '" height="' +
        Math.max(0, ht - sw) + '" rx="' + Math.max(0, (el.radius || 0) - ins) + '" fill="' + (el.fill || 'none') +
        '" stroke="' + stroke + '" stroke-width="' + sw + '"/></svg>';
    }
    if (el.type === 'ellipse') {
      return open + '<ellipse cx="' + (w / 2) + '" cy="' + (ht / 2) + '" rx="' + Math.max(0, w / 2 - ins) +
        '" ry="' + Math.max(0, ht / 2 - ins) + '" fill="' + (el.fill || 'none') + '" stroke="' + stroke +
        '" stroke-width="' + sw + '"/></svg>';
    }
    // line
    var lw = el.strokeWidth || 1;
    var pts = el.dir === '/' ? [0, ht, w, 0] : [0, 0, w, ht];
    return open + '<line x1="' + pts[0] + '" y1="' + pts[1] + '" x2="' + pts[2] + '" y2="' + pts[3] +
      '" stroke="' + (el.stroke || '#000') + '" stroke-width="' + lw + '" stroke-linecap="round"/></svg>';
  }

  /* -------- 選択オーバーレイ + スナップガイド -------- */
  var HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  function sheetForPage(pi) { return canvasEl.querySelector('.sheet[data-page="' + pi + '"]'); }
  function elNode(id) { return canvasEl.querySelector('.el[data-id="' + id + '"]'); }

  function renderSelection() {
    canvasEl.querySelectorAll('.selbox, .guide').forEach(function (n) { n.remove(); });
    var f = state.selId && findEl(state.selId);
    if (!f) return;
    var sc = displayScale(), el = f.el;
    var box = h('div', { class: 'selbox' + (el.type === 'line' ? ' line-sel' : ''),
      style: 'left:' + (el.x * sc) + 'px;top:' + (el.y * sc) + 'px;width:' + (el.w * sc) + 'px;height:' + (el.h * sc) + 'px;' });
    HANDLES.forEach(function (d) { box.appendChild(h('div', { class: 'handle ' + d, 'data-dir': d })); });
    sheetForPage(f.pi).appendChild(box);
  }
  function updateSelboxLive(el) {
    var sc = displayScale(), box = canvasEl.querySelector('.selbox');
    if (!box) return;
    box.style.left = (el.x * sc) + 'px'; box.style.top = (el.y * sc) + 'px';
    box.style.width = (el.w * sc) + 'px'; box.style.height = (el.h * sc) + 'px';
  }
  function drawGuides(pi, guides) {
    canvasEl.querySelectorAll('.guide').forEach(function (n) { n.remove(); });
    var sc = displayScale(), sheet = sheetForPage(pi), page = doc.pages[pi];
    guides.forEach(function (g) {
      if (g.axis === 'x') sheet.appendChild(h('div', { class: 'guide v', style: 'left:' + (g.pos * sc) + 'px;top:0;height:' + (page.h * sc) + 'px;' }));
      else sheet.appendChild(h('div', { class: 'guide h', style: 'top:' + (g.pos * sc) + 'px;left:0;width:' + (page.w * sc) + 'px;' }));
    });
  }

  /* ---------------------------------------------------------- 選択・ツール */
  function setTool(tool) {
    if (tool === 'help') { showHelp(); return; }
    state.tool = tool;
    document.querySelectorAll('.tool').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === tool); });
    canvasEl.style.cursor = tool === 'select' ? '' : 'crosshair';
  }
  function select(id) {
    if (state.editing) commitEdit();
    state.selId = id;
    if (id) { var f = findEl(id); if (f) state.currentPage = f.pi; }
    renderAll();
    buildInspector();
  }

  /* ---------------------------------------------------------- 履歴 */
  function beginChange() { undoStack.push(clone(doc)); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
  function finalize() { renderAll(); buildInspector(); save(); refreshHistoryButtons(); }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(clone(doc)); doc = undoStack.pop();
    fixSelection(); renderAll(); buildInspector(); save(); refreshHistoryButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(clone(doc)); doc = redoStack.pop();
    fixSelection(); renderAll(); buildInspector(); save(); refreshHistoryButtons();
  }
  function fixSelection() { if (state.selId && !findEl(state.selId)) state.selId = null; state.currentPage = clamp(state.currentPage, 0, doc.pages.length - 1); }
  function refreshHistoryButtons() { $('undoBtn').disabled = !undoStack.length; $('redoBtn').disabled = !redoStack.length; }

  /* ---------------------------------------------------------- 永続化 */
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORAGE, JSON.stringify({ v: 1, doc: doc, assets: assets })); }
      catch (e) { toast('保存に失敗（容量超過の可能性）。JSON 保存を推奨します'); }
    }, 250);
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE);
      if (raw) { var d = JSON.parse(raw); if (d && d.doc) { doc = d.doc; assets = d.assets || {}; return true; } }
    } catch (e) {}
    return false;
  }
  function preloadImages() {
    Object.keys(assets).forEach(function (id) {
      if (!imgCache[id]) { var im = new Image(); im.src = assets[id].src; imgCache[id] = im; }
    });
  }

  /* ---------------------------------------------------------- ポインタ操作 */
  var gesture = null;
  canvasEl.addEventListener('pointerdown', onPointerDown);

  function sheetPoint(pi, clientX, clientY) {
    var r = sheetForPage(pi).getBoundingClientRect(), sc = displayScale();
    return { x: (clientX - r.left) / sc, y: (clientY - r.top) / sc };
  }
  function pageIndexAt(clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    while (el && el !== canvasEl) { if (el.classList && el.classList.contains('sheet')) return +el.dataset.page; el = el.parentElement; }
    return -1;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    var handle = e.target.closest('.handle');
    var elDom = e.target.closest('.el');
    var sheet = e.target.closest('.sheet');

    // リサイズ
    if (handle && state.selId) {
      e.preventDefault();
      var f = findEl(state.selId);
      beginChange();
      gesture = { mode: 'resize', dir: handle.dataset.dir, pi: f.pi, start: clone(f.el),
        sx: e.clientX, sy: e.clientY, id: f.el.id, changed: false };
      canvasEl.setPointerCapture(e.pointerId);
      return;
    }
    // 既存要素（選択ツール）
    if (state.tool === 'select' && elDom) {
      if (state.editing && elDom.dataset.id === state.selId) return; // 編集中はテキスト操作優先
      e.preventDefault();
      if (elDom.dataset.id !== state.selId) select(elDom.dataset.id);
      var g = findEl(state.selId);
      beginChange();
      gesture = { mode: 'move', pi: g.pi, start: clone(g.el), sx: e.clientX, sy: e.clientY, id: g.el.id, changed: false };
      canvasEl.setPointerCapture(e.pointerId);
      return;
    }
    // 生成ツール
    if (state.tool !== 'select' && sheet) {
      var pi = +sheet.dataset.page;
      state.currentPage = pi;
      if (state.tool === 'image') { pendingImagePage = pi; pendingImagePoint = sheetPoint(pi, e.clientX, e.clientY); $('imageInput').click(); return; }
      e.preventDefault();
      var p0 = sheetPoint(pi, e.clientX, e.clientY);
      gesture = { mode: 'create', pi: pi, x0: p0.x, y0: p0.y, sx: e.clientX, sy: e.clientY, tool: state.tool, changed: false };
      canvasEl.setPointerCapture(e.pointerId);
      var prev = h('div', { class: 'create-preview', id: 'createPreview' });
      sheet.appendChild(prev);
      return;
    }
    // 空白クリック → 選択解除
    if (state.tool === 'select' && sheet && !elDom) {
      state.currentPage = +sheet.dataset.page;
      if (state.selId) select(null); else { renderAll(); buildInspector(); }
    }
  }

  window.addEventListener('pointermove', function (e) {
    if (!gesture) return;
    var sc = displayScale();
    if (gesture.mode === 'move') moveGesture(e, sc);
    else if (gesture.mode === 'resize') resizeGesture(e, sc);
    else if (gesture.mode === 'create') createGesture(e, sc);
  });
  window.addEventListener('pointerup', function (e) {
    if (!gesture) return;
    var g = gesture; gesture = null;
    canvasEl.querySelectorAll('.guide').forEach(function (n) { n.remove(); });
    try { canvasEl.releasePointerCapture(e.pointerId); } catch (_) {}
    if (g.mode === 'create') finishCreate(g, e);
    else {
      if (!g.changed) undoStack.pop();   // 実変更なし → スナップショット破棄
      finalize();
    }
  });

  function moveGesture(e, sc) {
    var f = findEl(gesture.id), el = f.el, s = gesture.start;
    var dx = (e.clientX - gesture.sx) / sc, dy = (e.clientY - gesture.sy) / sc;
    var nx = s.x + dx, ny = s.y + dy;
    var page = doc.pages[gesture.pi];
    var snapped = state.snap ? snapMove(nx, ny, el.w, el.h, page, el.id) : { x: nx, y: ny, guides: [] };
    el.x = snapped.x; el.y = snapped.y;
    gesture.changed = true;
    var node = elNode(el.id); node.style.left = (el.x * sc) + 'px'; node.style.top = (el.y * sc) + 'px';
    updateSelboxLive(el); drawGuides(gesture.pi, snapped.guides); syncPosFields(el);
  }

  function resizeGesture(e, sc) {
    var f = findEl(gesture.id), el = f.el, s = gesture.start, d = gesture.dir;
    var dx = (e.clientX - gesture.sx) / sc, dy = (e.clientY - gesture.sy) / sc;
    var x = s.x, y = s.y, w = s.w, ht = s.h;
    if (d.indexOf('w') >= 0) { x = s.x + dx; w = s.w - dx; }
    if (d.indexOf('e') >= 0) { w = s.w + dx; }
    if (d.indexOf('n') >= 0) { y = s.y + dy; ht = s.h - dy; }
    if (d.indexOf('s') >= 0) { ht = s.h + dy; }
    // Shift でアスペクト維持（角のみ）
    if (e.shiftKey && d.length === 2 && s.w > 0 && s.h > 0) {
      var ar = s.w / s.h;
      if (Math.abs(w - s.w) > Math.abs(ht - s.h)) ht = w / ar; else w = ht * ar;
      if (d.indexOf('n') >= 0) y = s.y + (s.h - ht);
      if (d.indexOf('w') >= 0) x = s.x + (s.w - w);
    }
    if (w < MIN) { if (d.indexOf('w') >= 0) x = s.x + s.w - MIN; w = MIN; }
    if (ht < MIN) { if (d.indexOf('n') >= 0) y = s.y + s.h - MIN; ht = MIN; }
    el.x = x; el.y = y; el.w = w; el.h = ht;
    gesture.changed = true;
    var node = elNode(el.id);
    node.style.left = (x * sc) + 'px'; node.style.top = (y * sc) + 'px';
    node.style.width = (w * sc) + 'px'; node.style.height = (ht * sc) + 'px';
    if (el.type === 'text') { var t = node.querySelector('.txt'); if (t) t.style.font = cssFont(el, el.size * sc); }
    else if (el.type !== 'image') node.innerHTML = shapeSVG(el);
    updateSelboxLive(el); syncPosFields(el);
  }

  function createGesture(e, sc) {
    var p = sheetPoint(gesture.pi, e.clientX, e.clientY);
    var x = Math.min(gesture.x0, p.x), y = Math.min(gesture.y0, p.y);
    var w = Math.abs(p.x - gesture.x0), ht = Math.abs(p.y - gesture.y0);
    var prev = $('createPreview');
    if (prev) { prev.style.left = (x * sc) + 'px'; prev.style.top = (y * sc) + 'px'; prev.style.width = (w * sc) + 'px'; prev.style.height = (ht * sc) + 'px'; }
    gesture.box = { x: x, y: y, w: w, h: ht, dir: (p.x - gesture.x0) * (p.y - gesture.y0) < 0 ? '/' : '\\' };
    gesture.changed = w > 2 || ht > 2;
  }

  function finishCreate(g, e) {
    var prev = $('createPreview'); if (prev) prev.remove();
    var b = g.box, tool = g.tool;
    var defaults = { text: [220, 54], rect: [180, 110], ellipse: [140, 140], line: [160, 90] };
    var dw = defaults[tool][0], dh = defaults[tool][1];
    var x, y, w, ht, dir = '\\';
    if (!b || (b.w < 4 && b.h < 4)) {           // クリック生成
      var pt = sheetPoint(g.pi, g.sx, g.sy);
      w = dw; ht = dh; x = pt.x; y = pt.y;
    } else { x = b.x; y = b.y; w = Math.max(MIN, b.w); ht = Math.max(tool === 'line' ? 0 : MIN, b.h); dir = b.dir; }
    // ページ内にクランプ
    var page = doc.pages[g.pi];
    x = clamp(x, 0, Math.max(0, page.w - Math.min(w, page.w)));
    y = clamp(y, 0, Math.max(0, page.h - Math.min(ht, page.h)));
    var el = makeElement(tool, x, y, w, Math.max(tool === 'line' ? 2 : MIN, ht));
    if (tool === 'line') { el.dir = dir; if (ht < MIN) el.h = MIN; }
    beginChange();
    page.els.push(el);
    state.selId = el.id; state.currentPage = g.pi;
    setTool('select');
    finalize();
    if (tool === 'text') { el._new = true; setTimeout(function () { startEdit(el.id); }, 0); }
  }

  /* -------- スナップ -------- */
  function snapMove(nx, ny, w, ht, page, selfId) {
    var thr = 6 / displayScale();
    var guides = [];
    var xr = { targets: [], val: nx };
    var yr = { targets: [], val: ny };
    // 候補ライン
    var vx = [0, page.w / 2, page.w], vy = [0, page.h / 2, page.h];
    page.els.forEach(function (o) { if (o.id === selfId) return;
      vx.push(o.x, o.x + o.w / 2, o.x + o.w); vy.push(o.y, o.y + o.h / 2, o.y + o.h); });
    // 対象は 左/中央/右 の3点
    function trySnap(cands, edges, size) {
      var best = null;
      edges.forEach(function (edge) {
        cands.forEach(function (c) {
          var d = Math.abs((edge.at) - c);
          if (d < thr && (!best || d < best.d)) best = { d: d, pos: c, delta: c - edge.at };
        });
      });
      return best;
    }
    var bx = trySnap(vx, [{ at: nx }, { at: nx + w / 2 }, { at: nx + w }]);
    if (bx) { nx += bx.delta; guides.push({ axis: 'x', pos: bx.pos }); }
    var by = trySnap(vy, [{ at: ny }, { at: ny + ht / 2 }, { at: ny + ht }]);
    if (by) { ny += by.delta; guides.push({ axis: 'y', pos: by.pos }); }
    return { x: nx, y: ny, guides: guides };
  }

  /* ---------------------------------------------------------- テキスト編集 */
  function startEdit(id) {
    var f = findEl(id); if (!f || f.el.type !== 'text') return;
    select(id);
    state.editing = true;
    var node = elNode(id); node.classList.add('editing');
    var t = node.querySelector('.txt');
    t.setAttribute('contenteditable', 'true');
    t.style.cursor = 'text';
    node.style.cursor = 'text';
    t.focus();
    // 全選択（新規なら差し替えやすく）
    var range = document.createRange(); range.selectNodeContents(t);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    t.addEventListener('blur', onEditBlur);
    $('hint').textContent = '入力中… Esc または外側クリックで確定';
  }
  function onEditBlur() { commitEdit(); }
  function commitEdit() {
    if (!state.editing) return;
    var f = state.selId && findEl(state.selId); state.editing = false;
    if (!f) { renderAll(); return; }
    var node = elNode(f.el.id); if (!node) { return; }
    var t = node.querySelector('.txt');
    t.removeEventListener('blur', onEditBlur);
    var val = t.innerText.replace(/\n$/, '');
    var changed = val !== f.el.text;
    if (f.el._new && val.trim() === '') {           // 空の新規テキストは破棄
      delete f.el._new;
      beginChange(); doc.pages[f.pi].els.splice(f.i, 1); state.selId = null; finalize();
      return;
    }
    delete f.el._new;
    if (changed) { beginChange(); f.el.text = val; finalize(); }
    else { renderAll(); }
    $('hint').textContent = 'ツールを選んでページ上をドラッグ / 要素をダブルクリックで文字入力';
  }
  canvasEl.addEventListener('dblclick', function (e) {
    var elDom = e.target.closest('.el');
    if (elDom && findEl(elDom.dataset.id) && findEl(elDom.dataset.id).el.type === 'text') startEdit(elDom.dataset.id);
  });

  /* ---------------------------------------------------------- キーボード */
  function isTyping() {
    var a = document.activeElement;
    return a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  }
  window.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { if (!isTyping()) { e.preventDefault(); e.shiftKey ? redo() : undo(); } return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { if (!isTyping()) { e.preventDefault(); redo(); } return; }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveJSON(); return; }
    if (mod && (e.key === 'd' || e.key === 'D')) { if (!isTyping() && state.selId) { e.preventDefault(); duplicateSel(); } return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(state.zoom * 1.2); return; }
    if (mod && e.key === '-') { e.preventDefault(); setZoom(state.zoom / 1.2); return; }
    if (mod && e.key === '0') { e.preventDefault(); fitZoom(); return; }
    if (e.key === 'Escape') {
      if (state.editing) { commitEdit(); }
      else if (!$('exportMenu').hidden) $('exportMenu').hidden = true;
      else if (!$('overlay').hidden) $('overlay').hidden = true;
      else if (state.selId) select(null);
      return;
    }
    if (isTyping()) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (state.selId) { e.preventDefault(); deleteSel(); } return; }
    if (e.key === 'Enter') { if (state.selId && selectedEl().type === 'text') { e.preventDefault(); startEdit(state.selId); } return; }
    var tools = { v: 'select', t: 'text', r: 'rect', o: 'ellipse', l: 'line', i: 'image' };
    if (tools[e.key]) { setTool(tools[e.key]); return; }
    if (state.selId && e.key.indexOf('Arrow') === 0) {
      e.preventDefault();
      var step = e.shiftKey ? 10 : 1, el = selectedEl();
      beginChange();
      if (e.key === 'ArrowLeft') el.x -= step; else if (e.key === 'ArrowRight') el.x += step;
      else if (e.key === 'ArrowUp') el.y -= step; else el.y += step;
      finalize();
    }
  });

  /* ---------------------------------------------------------- 要素操作 */
  function deleteSel() { var f = findEl(state.selId); if (!f) return; beginChange(); f.page.els.splice(f.i, 1); state.selId = null; finalize(); }
  function duplicateSel() {
    var f = findEl(state.selId); if (!f) return;
    beginChange();
    var c = clone(f.el); c.id = uid(); c.x += 12; c.y += 12; delete c._new;
    f.page.els.push(c); state.selId = c.id; finalize();
  }
  function reorder(kind) {
    var f = findEl(state.selId); if (!f) return; beginChange();
    var arr = f.page.els; arr.splice(f.i, 1);
    if (kind === 'front') arr.push(f.el);
    else if (kind === 'back') arr.unshift(f.el);
    else if (kind === 'forward') arr.splice(Math.min(arr.length, f.i + 1), 0, f.el);
    else arr.splice(Math.max(0, f.i - 1), 0, f.el);
    finalize();
  }
  function alignPage(kind) {
    var f = findEl(state.selId); if (!f) return; var el = f.el, p = f.page; beginChange();
    if (kind === 'left') el.x = 0; else if (kind === 'hcenter') el.x = (p.w - el.w) / 2; else if (kind === 'right') el.x = p.w - el.w;
    else if (kind === 'top') el.y = 0; else if (kind === 'vcenter') el.y = (p.h - el.h) / 2; else if (kind === 'bottom') el.y = p.h - el.h;
    finalize();
  }

  /* ---------------------------------------------------------- ページ操作 */
  function addPage(after) {
    beginChange();
    var idx = (after == null ? doc.pages.length - 1 : after) + 1;
    var ref = doc.pages[curPageIndex()] || doc.pages[0];
    var p = newPage(); p.w = ref.w; p.h = ref.h;
    doc.pages.splice(idx, 0, p); state.currentPage = idx; state.selId = null;
    finalize();
    setTimeout(function () { var s = sheetForPage(idx); if (s) s.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 30);
  }
  function duplicatePage(pi) { beginChange(); var c = clone(doc.pages[pi]); c.id = uid(); c.els.forEach(function (e) { e.id = uid(); }); doc.pages.splice(pi + 1, 0, c); state.currentPage = pi + 1; state.selId = null; finalize(); }
  function deletePage(pi) {
    if (doc.pages.length <= 1) { toast('最後の 1 ページは削除できません'); return; }
    beginChange(); doc.pages.splice(pi, 1); state.selId = null; state.currentPage = clamp(pi, 0, doc.pages.length - 1); finalize();
  }
  function setPageSize(pi, w, ht) { beginChange(); doc.pages[pi].w = w; doc.pages[pi].h = ht; finalize(); }

  /* ---------------------------------------------------------- 画像取り込み */
  var pendingImagePage = 0, pendingImagePoint = null, pendingReplaceId = null;
  $('imageInput').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) { pendingReplaceId = null; return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var id = uid();
        assets[id] = { src: reader.result, natW: img.naturalWidth, natH: img.naturalHeight };
        imgCache[id] = img;
        // 既存画像の差し替え
        if (pendingReplaceId) {
          var rf = findEl(pendingReplaceId); pendingReplaceId = null;
          if (rf) { beginChange(); rf.el.asset = id; finalize(); return; }
        }
        var page = doc.pages[pendingImagePage] || doc.pages[curPageIndex()];
        var maxW = page.w * 0.6, maxH = page.h * 0.6;
        var sc2 = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
        var w = img.naturalWidth * sc2, ht = img.naturalHeight * sc2;
        var px = pendingImagePoint ? pendingImagePoint.x : (page.w - w) / 2;
        var py = pendingImagePoint ? pendingImagePoint.y : (page.h - ht) / 2;
        var el = makeElement('image', clamp(px, 0, page.w - w), clamp(py, 0, page.h - ht), w, ht);
        el.asset = id;
        beginChange(); page.els.push(el); state.selId = el.id; state.currentPage = pendingImagePage; setTool('select'); finalize();
        pendingImagePoint = null;
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  /* ---------------------------------------------------------- インスペクタ */
  var inspector = $('inspector');
  var _liveChanging = false;
  function field(label, ctrl) { return h('div', { class: 'field' }, [label ? h('label', { class: 'field-label', text: label }) : null, ctrl]); }
  /* 接頭ラベルの無いプレーンな数値入力（ラベルは field() で上に付ける用） */
  function plainNum(val, apply, opts) {
    opts = opts || {};
    var inp = h('input', { class: 'ctrl', type: 'number', value: Math.round(val * 100) / 100, step: opts.step || 1 });
    if (opts.min != null) inp.min = opts.min;
    inp.addEventListener('input', function () {
      if (!_liveChanging) { beginChange(); _liveChanging = true; }
      apply(parseFloat(inp.value) || 0); renderAll(); save();
    });
    inp.addEventListener('change', function () { _liveChanging = false; refreshHistoryButtons(); });
    return inp;
  }
  function numField(label, val, apply, opts) {
    opts = opts || {};
    var inp = h('input', { class: 'ctrl', type: 'number', value: Math.round(val * 100) / 100, step: opts.step || 1 });
    if (opts.min != null) inp.min = opts.min;
    inp.addEventListener('input', function () {
      if (!_liveChanging) { beginChange(); _liveChanging = true; }
      apply(parseFloat(inp.value) || 0); renderAll(); save();
    });
    inp.addEventListener('change', function () { _liveChanging = false; refreshHistoryButtons(); });
    if (opts.id) inp.id = opts.id;
    var wrap = h('div', { class: 'num-wrap' }, [h('span', { class: 'num-label', text: label }), inp]);
    return wrap;
  }
  function colorControl(label, val, apply, allowNone) {
    var swatch = h('label', { class: 'color-swatch' + (val ? '' : ' color-none') });
    var picker = h('input', { type: 'color', value: val || '#000000' });
    picker.addEventListener('input', function () {
      if (!_liveChanging) { beginChange(); _liveChanging = true; }
      swatch.classList.remove('color-none'); apply(picker.value); renderAll(); save();
    });
    picker.addEventListener('change', function () { _liveChanging = false; refreshHistoryButtons(); });
    swatch.appendChild(picker);
    var row = [h('span', { class: 'field-label', style: 'flex:1;margin:0', text: label }), swatch];
    if (allowNone) {
      var noneBtn = h('button', { class: 'chk-btn' + (val ? '' : ' on'), text: 'なし', onclick: function () {
        beginChange(); apply(null); noneBtn.classList.add('on'); swatch.classList.add('color-none'); finalize();
      } });
      picker.addEventListener('input', function () { noneBtn.classList.remove('on'); });
      row.push(noneBtn);
    }
    return h('div', { class: 'field' }, [h('div', { class: 'color-row' }, row)]);
  }
  function seg(options, current, apply) {
    var box = h('div', { class: 'seg' });
    options.forEach(function (o) {
      box.appendChild(h('button', { class: current === o.v ? 'on' : '', html: o.label, title: o.title || '', onclick: function () {
        beginChange(); apply(o.v); finalize();
      } }));
    });
    return box;
  }
  function toggleBtn(label, on, apply) {
    return h('button', { class: 'chk-btn' + (on ? ' on' : ''), html: label, onclick: function () { beginChange(); apply(!on); finalize(); } });
  }
  function rangeField(label, val, min, max, step, apply, fmt) {
    var rv = h('span', { class: 'rv', text: (fmt ? fmt(val) : val) });
    var r = h('input', { type: 'range', min: min, max: max, step: step, value: val });
    r.addEventListener('input', function () {
      if (!_liveChanging) { beginChange(); _liveChanging = true; }
      var v = parseFloat(r.value); apply(v); rv.textContent = fmt ? fmt(v) : v; renderAll(); save();
    });
    r.addEventListener('change', function () { _liveChanging = false; refreshHistoryButtons(); });
    return field(label, h('div', { class: 'range-row' }, [r, rv]));
  }

  function buildInspector() {
    inspector.innerHTML = '';
    var el = selectedEl();
    if (el) { buildElementInspector(el); }
    buildPageInspector(el == null);
    updateStatus();
  }

  function sec(title, kids) { return h('div', { class: 'insp-sec' }, [h('h3', { text: title })].concat(kids)); }

  function buildElementInspector(el) {
    var apply = function (fn) { return function (v) { fn(v); }; };
    var kids = [];
    var typeLabel = { text: 'テキスト', rect: '長方形', ellipse: '楕円', line: '直線', image: '画像' }[el.type];

    if (el.type === 'text') {
      kids.push(field('フォント', (function () {
        var s = h('select', { class: 'ctrl' });
        ['Helvetica', 'Times', 'Courier'].forEach(function (fn) { s.appendChild(h('option', { value: fn, text: fn, selected: el.font === fn })); });
        s.addEventListener('change', function () { beginChange(); el.font = s.value; finalize(); });
        return s;
      })()));
      kids.push(h('div', { class: 'row' }, [
        field('サイズ pt', plainNum(el.size, function (v) { el.size = clamp(v, 1, 800); }, { min: 1, step: 1 })),
        field('装飾', h('div', { class: 'seg' }, [
          toggleBtn('<b>B</b>', el.bold, function (v) { el.bold = v; }),
          toggleBtn('<i>I</i>', el.italic, function (v) { el.italic = v; }),
          toggleBtn('<u>U</u>', el.underline, function (v) { el.underline = v; })
        ]))
      ]));
      kids.push(field('揃え', seg([
        { v: 'left', label: '⯇' }, { v: 'center', label: '≡' }, { v: 'right', label: '⯈' }
      ], el.align, function (v) { el.align = v; })));
      kids.push(colorControl('文字色', el.color, function (v) { el.color = v || '#000000'; }, false));
      kids.push(rangeField('行間', el.lineHeight, 0.8, 3, 0.05, function (v) { el.lineHeight = v; }, function (v) { return v.toFixed(2); }));
    }
    if (el.type === 'rect' || el.type === 'ellipse') {
      kids.push(colorControl('塗り', el.fill, function (v) { el.fill = v; }, true));
      kids.push(colorControl('線の色', el.stroke, function (v) { el.stroke = v; }, true));
      kids.push(rangeField('線の太さ', el.strokeWidth, 0, 40, 0.5, function (v) { el.strokeWidth = v; }, function (v) { return v + 'pt'; }));
      if (el.type === 'rect') kids.push(rangeField('角丸', el.radius || 0, 0, Math.min(el.w, el.h) / 2, 1, function (v) { el.radius = v; }, function (v) { return Math.round(v) + 'pt'; }));
    }
    if (el.type === 'line') {
      kids.push(colorControl('線の色', el.stroke, function (v) { el.stroke = v || '#000000'; }, false));
      kids.push(rangeField('線の太さ', el.strokeWidth, 0.5, 40, 0.5, function (v) { el.strokeWidth = v; }, function (v) { return v + 'pt'; }));
      kids.push(field('向き', seg([{ v: '\\', label: '╲' }, { v: '/', label: '╱' }], el.dir, function (v) { el.dir = v; })));
    }
    if (el.type === 'image') {
      kids.push(h('div', { class: 'field' }, [h('button', { class: 'chk-btn', style: 'width:100%;padding:8px', text: '画像を差し替え', onclick: function () {
        pendingReplaceId = el.id; $('imageInput').click();
      } })]));
    }
    kids.push(rangeField('不透明度', el.opacity, 0, 1, 0.01, function (v) { el.opacity = v; }, function (v) { return Math.round(v * 100) + '%'; }));

    inspector.appendChild(sec(typeLabel, kids));

    // 位置・サイズ
    inspector.appendChild(sec('位置・サイズ', [
      h('div', { class: 'row' }, [
        numField('X', el.x, function (v) { el.x = v; }, { id: 'fld-x', step: 1 }),
        numField('Y', el.y, function (v) { el.y = v; }, { id: 'fld-y', step: 1 })
      ]),
      h('div', { class: 'row' }, [
        numField('W', el.w, function (v) { el.w = Math.max(MIN, v); }, { id: 'fld-w', min: MIN, step: 1 }),
        numField('H', el.h, function (v) { el.h = Math.max(MIN, v); }, { id: 'fld-h', min: MIN, step: 1 })
      ]),
      field('ページ内で揃える', h('div', { class: 'icon-grid' }, [
        h('button', { html: '⯇', title: '左', onclick: function () { alignPage('left'); } }),
        h('button', { html: '｜', title: '左右中央', onclick: function () { alignPage('hcenter'); } }),
        h('button', { html: '⯈', title: '右', onclick: function () { alignPage('right'); } }),
        h('button', { html: '⯅', title: '上', onclick: function () { alignPage('top'); } }),
        h('button', { html: '―', title: '上下中央', onclick: function () { alignPage('vcenter'); } }),
        h('button', { html: '⯆', title: '下', onclick: function () { alignPage('bottom'); } })
      ]))
    ]));

    // 重ね順・複製・削除
    inspector.appendChild(sec('並び替え', [
      h('div', { class: 'icon-grid' }, [
        h('button', { html: '⤒', title: '最前面', onclick: function () { reorder('front'); } }),
        h('button', { html: '↑', title: '前面へ', onclick: function () { reorder('forward'); } }),
        h('button', { html: '↓', title: '背面へ', onclick: function () { reorder('backward'); } }),
        h('button', { html: '⤓', title: '最背面', onclick: function () { reorder('back'); } })
      ]),
      h('div', { class: 'insp-actions', style: 'margin-top:8px' }, [
        h('button', { text: '複製 (Ctrl+D)', onclick: duplicateSel }),
        h('button', { class: 'danger', text: '削除 (Del)', onclick: deleteSel })
      ])
    ]));
  }

  function buildPageInspector(isOnly) {
    var pi = curPageIndex(), page = doc.pages[pi];
    var kids = [];
    kids.push(field('用紙サイズ', (function () {
      var s = h('select', { class: 'ctrl' });
      var matched = false;
      PAGE_PRESETS.forEach(function (p) {
        var isMatch = (Math.abs(p.w - page.w) < 0.5 && Math.abs(p.h - page.h) < 0.5) ||
                      (Math.abs(p.h - page.w) < 0.5 && Math.abs(p.w - page.h) < 0.5);
        if (isMatch) matched = true;
        s.appendChild(h('option', { value: p.id, text: p.name, selected: isMatch }));
      });
      s.appendChild(h('option', { value: 'custom', text: 'カスタム', selected: !matched }));
      s.addEventListener('change', function () {
        var p = PAGE_PRESETS.find(function (x) { return x.id === s.value; }); if (!p) return;
        var landscape = page.w > page.h;
        setPageSize(pi, landscape ? Math.max(p.w, p.h) : Math.min(p.w, p.h), landscape ? Math.min(p.w, p.h) : Math.max(p.w, p.h));
      });
      return s;
    })()));
    kids.push(field('向き', seg([
      { v: 'portrait', label: '縦' }, { v: 'landscape', label: '横' }
    ], page.w > page.h ? 'landscape' : 'portrait', function (v) {
      var landscape = v === 'landscape';
      if ((page.w > page.h) !== landscape) setPageSize(pi, page.h, page.w);
    })));
    kids.push(h('div', { class: 'row' }, [
      field('幅 pt', plainNum(page.w, function (v) { page.w = Math.max(20, v); }, { min: 20 })),
      field('高 pt', plainNum(page.h, function (v) { page.h = Math.max(20, v); }, { min: 20 }))
    ]));
    kids.push(colorControl('背景色', page.bg, function (v) { page.bg = v || '#ffffff'; }, false));
    kids.push(h('div', { class: 'insp-actions', style: 'margin-top:6px' }, [
      h('button', { text: 'ページ複製', onclick: function () { duplicatePage(pi); } }),
      h('button', { class: 'danger', text: 'ページ削除', onclick: function () { deletePage(pi); } })
    ]));
    inspector.appendChild(sec('ページ ' + (pi + 1) + ' / ' + doc.pages.length, kids));

    if (isOnly) {
      inspector.appendChild(h('div', { class: 'insp-empty' }, [
        h('span', { class: 'big', text: '📄' }),
        h('div', { html: '左のツールでページ上に要素を配置。<br>要素をクリックで選択、ダブルクリックで文字入力。<br><br>Ctrl+Z で元に戻す・Del で削除。' })
      ]));
    }
  }

  function syncPosFields(el) {
    var map = { 'fld-x': el.x, 'fld-y': el.y, 'fld-w': el.w, 'fld-h': el.h };
    for (var id in map) { var f = $(id); if (f && document.activeElement !== f) f.value = Math.round(map[id] * 100) / 100; }
  }

  /* ---------------------------------------------------------- Canvas レンダラ（ラスタ / サムネ用） */
  function renderPageToCanvas(page, scale) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(page.w * scale));
    c.height = Math.max(1, Math.round(page.h * scale));
    var ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = page.bg || '#ffffff';
    ctx.fillRect(0, 0, page.w, page.h);
    page.els.forEach(function (el) { drawElement(ctx, el); });
    return c;
  }
  function roundRectPath(ctx, x, y, w, ht, r) {
    r = Math.max(0, Math.min(r, w / 2, ht / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + ht, r);
    ctx.arcTo(x + w, y + ht, x, y + ht, r);
    ctx.arcTo(x, y + ht, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawElement(ctx, el) {
    ctx.save();
    ctx.globalAlpha = el.opacity == null ? 1 : el.opacity;
    if (el.type === 'rect' || el.type === 'ellipse') {
      var sw = (el.stroke && el.strokeWidth > 0) ? el.strokeWidth : 0, ins = sw / 2;
      var x = el.x + ins, y = el.y + ins, w = Math.max(0, el.w - sw), ht = Math.max(0, el.h - sw);
      if (el.type === 'rect') roundRectPath(ctx, x, y, w, ht, Math.max(0, (el.radius || 0) - ins));
      else { ctx.beginPath(); ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.max(0, el.w / 2 - ins), Math.max(0, el.h / 2 - ins), 0, 0, Math.PI * 2); }
      if (el.fill) { ctx.fillStyle = el.fill; ctx.fill(); }
      if (sw > 0) { ctx.strokeStyle = el.stroke; ctx.lineWidth = sw; ctx.stroke(); }
    } else if (el.type === 'line') {
      var pts = el.dir === '/' ? [el.x, el.y + el.h, el.x + el.w, el.y] : [el.x, el.y, el.x + el.w, el.y + el.h];
      ctx.strokeStyle = el.stroke || '#000'; ctx.lineWidth = el.strokeWidth || 1; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); ctx.lineTo(pts[2], pts[3]); ctx.stroke();
    } else if (el.type === 'image') {
      var im = el.asset && imgCache[el.asset];
      if (im && im.complete && im.naturalWidth) { try { ctx.drawImage(im, el.x, el.y, el.w, el.h); } catch (e) {} }
    } else if (el.type === 'text') {
      var lay = layoutText(el, ctx);
      ctx.font = cssFont(el, el.size); ctx.fillStyle = el.color; ctx.textBaseline = 'alphabetic';
      lay.lines.forEach(function (ln, i) {
        var x = el.x;
        if (el.align === 'center') x = el.x + (el.w - ln.width) / 2;
        else if (el.align === 'right') x = el.x + el.w - ln.width;
        var y = el.y + lay.ascent + i * lay.lineH;
        ctx.fillText(ln.text, x, y);
        if (el.underline && ln.text) { ctx.strokeStyle = el.color; ctx.lineWidth = Math.max(0.5, el.size * 0.06); ctx.beginPath(); var uy = y + el.size * 0.12; ctx.moveTo(x, uy); ctx.lineTo(x + ln.width, uy); ctx.stroke(); }
      });
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------- PDF 書き出し */
  function base64ToBytes(b64) {
    var bin = atob(b64), len = bin.length, out = new Uint8Array(len);
    for (var i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function dataUrlToBytes(url) { return base64ToBytes(url.split(',')[1]); }
  function canvasToJpegOp(canvas, x, y, w, ht, opacity) {
    var url = canvas.toDataURL('image/jpeg', 0.92);
    return { type: 'image', x: x, y: y, w: w, h: ht, iw: canvas.width, ih: canvas.height, data: dataUrlToBytes(url), opacity: opacity == null ? 1 : opacity };
  }
  function imageElToJpeg(im, maxDim) {
    var w = im.naturalWidth || 1, ht = im.naturalHeight || 1;
    var s = Math.min(1, maxDim / Math.max(w, ht));
    var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(ht * s));
    var c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch);
    try { cx.drawImage(im, 0, 0, cw, ch); } catch (e) {}
    return c;
  }

  function pageNeedsRaster(page) {
    for (var i = 0; i < page.els.length; i++) {
      var el = page.els[i];
      if (el.type === 'text' && !PDFWriter.isWinAnsi(el.text || '')) return true;
    }
    return false;
  }

  function buildVectorOps(page) {
    var ops = [];
    if ((page.bg || '#ffffff').toLowerCase() !== '#ffffff')
      ops.push({ type: 'rect', x: 0, y: 0, w: page.w, h: page.h, fill: hexToRgb(page.bg), opacity: 1 });
    page.els.forEach(function (el) {
      var op = el.opacity == null ? 1 : el.opacity;
      if (el.type === 'rect') {
        var sw = (el.stroke && el.strokeWidth > 0) ? el.strokeWidth : 0, ins = sw / 2;
        ops.push({ type: 'rect', x: el.x + ins, y: el.y + ins, w: el.w - sw, h: el.h - sw,
          fill: el.fill ? hexToRgb(el.fill) : null, stroke: sw > 0 ? hexToRgb(el.stroke) : null,
          lineWidth: sw, radius: Math.max(0, (el.radius || 0) - ins), opacity: op });
      } else if (el.type === 'ellipse') {
        var sw2 = (el.stroke && el.strokeWidth > 0) ? el.strokeWidth : 0, ins2 = sw2 / 2;
        ops.push({ type: 'ellipse', x: el.x + ins2, y: el.y + ins2, w: el.w - sw2, h: el.h - sw2,
          fill: el.fill ? hexToRgb(el.fill) : null, stroke: sw2 > 0 ? hexToRgb(el.stroke) : null, lineWidth: sw2, opacity: op });
      } else if (el.type === 'line') {
        var pts = el.dir === '/' ? [el.x, el.y + el.h, el.x + el.w, el.y] : [el.x, el.y, el.x + el.w, el.y + el.h];
        ops.push({ type: 'line', x1: pts[0], y1: pts[1], x2: pts[2], y2: pts[3], stroke: hexToRgb(el.stroke || '#000'), lineWidth: el.strokeWidth || 1, cap: 1, opacity: op });
      } else if (el.type === 'image') {
        var im = el.asset && imgCache[el.asset];
        if (im && im.naturalWidth) { var c = imageElToJpeg(im, 1800); ops.push(canvasToJpegOp(c, el.x, el.y, el.w, el.h, op)); }
      } else if (el.type === 'text') {
        var lay = layoutText(el);
        var fontName = pdfFontName(el), color = hexToRgb(el.color);
        lay.lines.forEach(function (ln, i) {
          if (!ln.text) return;
          var x = el.x;
          if (el.align === 'center') x = el.x + (el.w - ln.width) / 2;
          else if (el.align === 'right') x = el.x + el.w - ln.width;
          var y = el.y + lay.ascent + i * lay.lineH;
          ops.push({ type: 'text', x: x, y: y, size: el.size, font: fontName, color: color, text: ln.text, opacity: op });
          if (el.underline) ops.push({ type: 'line', x1: x, y1: y + el.size * 0.12, x2: x + ln.width, y2: y + el.size * 0.12, stroke: color, lineWidth: Math.max(0.4, el.size * 0.06), opacity: op });
        });
      }
    });
    return ops;
  }

  /* mode に従い PDF バイト列を合成（同期・画像はデコード済み前提）。戻り値 {bytes, rasterCount, vectorCount} */
  function composePdf(mode) {
    var rasterCount = 0, vectorCount = 0;
    var pdfDoc = { title: doc.title || 'kami', pages: [] };
    doc.pages.forEach(function (page) {
      var raster = mode === 'raster' || (mode === 'auto' && pageNeedsRaster(page));
      if (mode === 'vector') raster = false;
      if (raster) {
        var canvas = renderPageToCanvas(page, 2.5);   // ~180dpi 相当
        pdfDoc.pages.push({ width: page.w, height: page.h, ops: [canvasToJpegOp(canvas, 0, 0, page.w, page.h, 1)] });
        rasterCount++;
      } else {
        pdfDoc.pages.push({ width: page.w, height: page.h, ops: buildVectorOps(page) });
        vectorCount++;
      }
    });
    return { bytes: PDFWriter.build(pdfDoc), rasterCount: rasterCount, vectorCount: vectorCount };
  }

  function exportPDF(mode) {
    commitEdit();
    preloadImages();
    // 画像が未デコードなら少し待つ
    var pending = Object.keys(imgCache).filter(function (id) { return imgCache[id] && !imgCache[id].complete; });
    var run = function () {
      try {
        var res = composePdf(mode);
        downloadBlob(new Blob([res.bytes], { type: 'application/pdf' }), safeName(doc.title) + '.pdf');
        var msg = 'PDF を書き出しました（' + doc.pages.length + 'ページ';
        if (res.rasterCount && res.vectorCount) msg += ' / ベクター' + res.vectorCount + '・画像' + res.rasterCount;
        else if (res.rasterCount) msg += ' / 画像';
        else msg += ' / ベクター・選択可能テキスト';
        msg += '）';
        toast(msg);
        if (mode === 'vector' && doc.pages.some(pageNeedsRaster)) toast('注意: 日本語等はベクターで正しく出力できません。「スマート」か「高品質画像」をお使いください');
      } catch (err) { console.error(err); toast('書き出しに失敗しました: ' + err.message); }
    };
    if (pending.length) {
      var done = 0, need = pending.length;
      pending.forEach(function (id) { imgCache[id].onload = imgCache[id].onerror = function () { if (++done >= need) run(); }; });
      setTimeout(run, 1500); // フォールバック
    } else run();
  }

  function safeName(s) { return (s || 'kami').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60) || 'kami'; }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------------------------------------------------------- JSON 入出力 */
  function saveJSON() {
    commitEdit();
    var blob = new Blob([JSON.stringify({ app: 'kami', v: 1, doc: doc, assets: assets }, null, 0)], { type: 'application/json' });
    downloadBlob(blob, safeName(doc.title) + '.kami.json');
    toast('プロジェクトを保存しました (.kami.json)');
  }
  $('jsonInput').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result);
        if (!d.doc || !d.doc.pages) throw new Error('kami プロジェクトではありません');
        beginChange();
        doc = d.doc; assets = d.assets || {}; imgCache = {}; preloadImages();
        state.selId = null; state.currentPage = 0;
        $('docTitle').value = doc.title || '無題のドキュメント';
        finalize(); toast('プロジェクトを読み込みました');
      } catch (err) { toast('読み込み失敗: ' + err.message); }
    };
    reader.readAsText(file);
  });

  /* ---------------------------------------------------------- ズーム・テーマ・トースト・ヘルプ */
  function setZoom(z) {
    state.zoom = clamp(z, 0.1, 5);
    $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
    renderAll();
  }
  function fitZoom() {
    var wrap = $('canvasWrap'), page = doc.pages[curPageIndex()];
    var avail = wrap.clientWidth - 100;
    setZoom(clamp(avail / (page.w * PT2PX), 0.1, 3));
  }
  function updateStatus() {
    $('pageInfo').textContent = (curPageIndex() + 1) + ' / ' + doc.pages.length;
    $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
  }
  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
  }
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function showHelp() {
    var o = $('overlay'); o.hidden = false; o.innerHTML = '';
    var modal = h('div', { class: 'modal' });
    modal.innerHTML =
      '<h2>紙 — kami の使い方</h2>' +
      '<p class="sub">依存ゼロ・ビルド不要の WYSIWYG PDF エディタ。データはこの端末内（localStorage）にのみ保存され、外部送信はありません。</p>' +
      '<h4>基本操作</h4>' +
      '<ul><li>左のツールを選び、ページ上を<b>ドラッグ</b>で作成（クリックでも既定サイズで配置）</li>' +
      '<li>テキストは<b>ダブルクリック</b>で編集。図形の塗り・線・角丸などは右パネルで調整</li>' +
      '<li>要素はドラッグで移動、ハンドルでリサイズ（角を Shift でアスペクト維持）</li>' +
      '<li>画像は取り込むとページ内に配置。差し替えも可能</li></ul>' +
      '<h4>書き出し</h4>' +
      '<ul><li><b>スマート</b>: 欧文ページは選択可能なベクター、日本語を含むページは高品質画像で出力</li>' +
      '<li><b>ベクター</b>: 全ページ軽量・文字選択可（欧文向け）</li>' +
      '<li><b>高品質画像</b>: 見た目を完全再現（全ページ画像化）</li></ul>' +
      '<h4>ショートカット</h4>' +
      '<div class="keys">' +
      '<div><kbd>V</kbd><kbd>T</kbd><kbd>R</kbd><kbd>O</kbd><kbd>L</kbd><kbd>I</kbd></div><div>ツール切替（選択/文字/四角/丸/線/画像）</div>' +
      '<div><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></div><div>元に戻す / やり直し</div>' +
      '<div><kbd>Ctrl</kbd>+<kbd>D</kbd></div><div>複製</div>' +
      '<div><kbd>Del</kbd></div><div>削除</div>' +
      '<div><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></div><div>1pt 移動（Shift で 10pt）</div>' +
      '<div><kbd>Ctrl</kbd>+<kbd>S</kbd></div><div>プロジェクト保存 (.kami.json)</div>' +
      '<div><kbd>Ctrl</kbd>+<kbd>+/−/0</kbd></div><div>拡大 / 縮小 / フィット</div>' +
      '</div>' +
      '<div class="close-row"><button class="tb-btn primary" id="helpClose">閉じる</button></div>';
    o.appendChild(modal);
    $('helpClose').onclick = function () { o.hidden = true; };
    o.onclick = function (e) { if (e.target === o) o.hidden = true; };
  }

  /* ---------------------------------------------------------- 配線 */
  document.querySelectorAll('.tool').forEach(function (b) { b.addEventListener('click', function () { setTool(b.dataset.tool); }); });
  $('undoBtn').onclick = undo; $('redoBtn').onclick = redo;
  $('newBtn').onclick = function () {
    if (!confirm('新規ドキュメントを作成します。現在の内容は失われます（保存推奨）。よろしいですか？')) return;
    beginChange(); doc = newDoc(); assets = {}; imgCache = {}; state.selId = null; state.currentPage = 0;
    $('docTitle').value = doc.title; finalize();
  };
  $('openBtn').onclick = function () { $('jsonInput').click(); };
  $('saveBtn').onclick = saveJSON;
  $('exportBtn').onclick = function (e) { e.stopPropagation(); $('exportMenu').hidden = !$('exportMenu').hidden; };
  document.addEventListener('click', function (e) { if (!e.target.closest('.menu-wrap')) $('exportMenu').hidden = true; });
  $('exportMenu').querySelectorAll('button').forEach(function (b) { b.onclick = function () { $('exportMenu').hidden = true; exportPDF(b.dataset.mode); }; });
  $('themeToggle').onclick = function () { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); };
  $('docTitle').addEventListener('input', function () { doc.title = $('docTitle').value; save(); });
  $('addPageBtn').onclick = function () { addPage(); };
  $('zoomIn').onclick = function () { setZoom(state.zoom * 1.2); };
  $('zoomOut').onclick = function () { setZoom(state.zoom / 1.2); };
  $('zoomLevel').onclick = fitZoom;
  $('snapChk').addEventListener('change', function () { state.snap = $('snapChk').checked; });
  $('canvasWrap').addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9)); }
  }, { passive: false });

  /* ---------------------------------------------------------- 自動化 / テスト用 API
     UI からは使わないが、ヘッドレス検証や外部スクリプトからの操作に使える薄い窓口。 */
  window.kami = {
    getDoc: function () { return doc; },
    setDoc: function (d) { doc = d; assets = {}; imgCache = {}; state.selId = null; state.currentPage = 0; $('docTitle').value = doc.title || ''; renderAll(); buildInspector(); },
    reset: function () { doc = newDoc(); assets = {}; imgCache = {}; undoStack = []; redoStack = []; state.selId = null; state.currentPage = 0; renderAll(); buildInspector(); },
    addElement: function (type, props) {
      var page = doc.pages[curPageIndex()];
      var el = makeElement(type, 40, 40, 200, 60);
      if (props) Object.assign(el, props);
      page.els.push(el); state.selId = el.id; renderAll(); buildInspector(); return el.id;
    },
    addPage: function (presetId) { doc.pages.push(newPage(presetId || 'a4')); renderAll(); },
    layoutText: layoutText,
    buildVectorOps: buildVectorOps,
    pageNeedsRaster: pageNeedsRaster,
    /** PDF を base64 文字列で返す（ダウンロードせずに検証したい時用） */
    exportBase64: function (mode) { var r = composePdf(mode); var b = ''; for (var i = 0; i < r.bytes.length; i++) b += String.fromCharCode(r.bytes[i]); return { b64: btoa(b), rasterCount: r.rasterCount, vectorCount: r.vectorCount, size: r.bytes.length }; },
    select: select, setTool: setTool, undo: undo, redo: redo, state: state
  };

  /* ---------------------------------------------------------- 初期化 */
  function init() {
    var savedTheme = null; try { savedTheme = localStorage.getItem(THEME_KEY); } catch (e) {}
    // 保存済みテーマがあれば尊重、無ければ OS 設定を解決して適用（初期の "auto" を実値に）
    document.documentElement.setAttribute('data-theme',
      savedTheme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    if (!load()) doc = newDoc();
    preloadImages();
    $('docTitle').value = doc.title || '無題のドキュメント';
    state.snap = $('snapChk').checked;
    renderAll(); buildInspector(); refreshHistoryButtons();
    // 画像デコード後に再描画（サムネ/選択が崩れないよう）
    setTimeout(function () { renderAll(); }, 400);
    setTimeout(fitZoom, 60);
  }
  init();
})();
