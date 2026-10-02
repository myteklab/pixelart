/**
 * text-tool.js - A Text tool: type a word, pick a font, click to place it.
 *
 * Fonts are the built-in ones in text-fonts.js plus the student's own
 * FontMaker fonts. FontMaker keeps every letter as an on/off pixel grid, so a
 * FontMaker project converts straight into the same glyph model the built-in
 * fonts use; no font file is rendered anywhere. Spec 144.
 *
 * Placed text is plain pixels on the current frame of the current layer, with
 * one history state holding the pixel list (not the text or the font, so undo
 * never depends on a font that has changed or failed to load since).
 *
 * The app never calls the platform. When the wrapper provides
 * window.pixelartFontSource = { list(), load(id) }, its fonts are offered too.
 * Without it (the /tools page, a bare load) the built-in fonts are all there is.
 *
 * Add-on pattern as in transition-tiles.js: poll for pskl, add to it, inject
 * DOM. The packaged Piskel bundle is not edited.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Fonts and layout. No DOM and no pskl here, so Node can test it.
  // ---------------------------------------------------------------------

  // FontMaker offers grids up to 32; this only keeps junk data from hanging the tab.
  var MAX_GRID = 64;
  var MAX_GLYPHS = 600;

  function parseRows(str, height) {
    var rows = str.split('|').map(function (r) {
      var row = [];
      for (var i = 0; i < r.length; i++) {
        row.push(r.charAt(i) === '#' ? 1 : 0);
      }
      return row;
    });
    var w = rows[0].length;
    while (rows.length < height) {
      rows.push(new Array(w).fill(0));
    }
    return { w: w, rows: rows };
  }

  function compileBuiltIn(def) {
    var glyphs = {};
    Object.keys(def.glyphs).forEach(function (ch) {
      glyphs[ch] = parseRows(def.glyphs[ch], def.height);
    });
    return { name: def.name, height: def.height, space: def.space, glyphs: glyphs };
  }

  function cell(grid, x, y) {
    var row = grid[y];
    return !!(row && row[x]);
  }

  /**
   * FontMaker project data to the glyph model. Returns null when the project
   * has no letters with ink.
   *
   * The vertical crop is shared by the whole font so letters keep their places
   * (a "g" still hangs below an "a"); the horizontal crop is per letter, which
   * is how FontMaker's own preview spaces them. Letters drawn on a different
   * grid size than most of the font sit on the same bottom edge.
   */
  function fromFontMaker(data, name) {
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return null; }
    }
    if (!data || typeof data.characters !== 'object' || !data.characters) {
      return null;
    }

    var entries = [];
    var sizeCount = {};
    Object.keys(data.characters).slice(0, MAX_GLYPHS).forEach(function (key) {
      var c = data.characters[key];
      var code = parseInt(key, 10);
      if (!c || !Array.isArray(c.grid) || !(code > 32)) {
        return;
      }
      var size = Math.min(MAX_GRID, c.gridSize || data.gridSize || c.grid.length);
      entries.push({ ch: String.fromCodePoint(code), grid: c.grid, size: size });
      sizeCount[size] = (sizeCount[size] || 0) + 1;
    });

    var common = 0;
    Object.keys(sizeCount).forEach(function (s) {
      if (!common || sizeCount[s] > sizeCount[common]) {
        common = +s;
      }
    });

    var top = Infinity;
    var bottom = -Infinity;
    entries.forEach(function (e) {
      e.off = common - e.size;
      e.minX = Infinity;
      e.maxX = -Infinity;
      for (var y = 0; y < e.size; y++) {
        for (var x = 0; x < e.size; x++) {
          if (cell(e.grid, x, y)) {
            e.minX = Math.min(e.minX, x);
            e.maxX = Math.max(e.maxX, x);
            top = Math.min(top, y + e.off);
            bottom = Math.max(bottom, y + e.off);
          }
        }
      }
    });

    var glyphs = {};
    var widths = [];
    entries.forEach(function (e) {
      if (e.minX === Infinity) {
        return;
      }
      var w = e.maxX - e.minX + 1;
      var rows = [];
      for (var y = top; y <= bottom; y++) {
        var row = [];
        for (var x = e.minX; x <= e.maxX; x++) {
          row.push(cell(e.grid, x, y - e.off) ? 1 : 0);
        }
        rows.push(row);
      }
      glyphs[e.ch] = { w: w, rows: rows };
      widths.push(w);
    });

    if (!widths.length) {
      return null;
    }
    widths.sort(function (a, b) { return a - b; });
    var median = widths[widths.length >> 1];
    return {
      name: name || data.fontName || 'My font',
      height: bottom - top + 1,
      space: Math.max(1, Math.round(median / 2)),
      glyphs: glyphs
    };
  }

  // A capitals-only font still writes "hello", and the other way round.
  function glyphFor(font, ch) {
    if (font.glyphs[ch]) {
      return font.glyphs[ch];
    }
    var up = ch.toUpperCase();
    if (up !== ch && font.glyphs[up]) {
      return font.glyphs[up];
    }
    var low = ch.toLowerCase();
    if (low !== ch && font.glyphs[low]) {
      return font.glyphs[low];
    }
    return null;
  }

  /**
   * Bold doubles the upright strokes: every column holding two or more ink
   * pixels in a row is drawn twice. The usual pixel bold, each pixel also
   * filling the one to its right, closes every one-pixel gap, and in a font
   * three pixels wide that turns H, O and m into solid blocks. A glyph with no
   * upright stroke at all (a dash, a dot) gets that smear instead.
   */
  function boldGlyph(g) {
    if (g.bold) {
      return g.bold;
    }
    var double = [];
    var any = false;
    for (var x = 0; x < g.w; x++) {
      double[x] = false;
      for (var y = 1; y < g.rows.length; y++) {
        if (g.rows[y][x] && g.rows[y - 1][x]) {
          double[x] = any = true;
          break;
        }
      }
    }
    var rows = g.rows.map(function (row) {
      var out = [];
      for (var x = 0; x < g.w; x++) {
        out.push(row[x]);
        if (any ? double[x] : x === g.w - 1) {
          out.push(any ? row[x] : 0);
        }
      }
      if (!any) {
        for (var i = out.length - 1; i > 0; i--) {
          out[i] = out[i] || out[i - 1];
        }
      }
      return out;
    });
    g.bold = { w: rows[0].length, rows: rows };
    return g.bold;
  }

  /**
   * Lay text out as pixels relative to its top-left corner.
   * opts: scale (1-4), gap (letter gap before scaling), bold, outline.
   * Returns { w, h, ink: [x, y, ...], edge: [x, y, ...], missing: [chars] }.
   *
   * Order matters: bold happens before scaling so it scales with the text,
   * and the outline is added after scaling so it stays one pixel at any size.
   */
  function layout(font, text, opts) {
    opts = opts || {};
    var scale = Math.max(1, Math.min(4, opts.scale | 0 || 1));
    var gap = Math.max(0, opts.gap === undefined ? 1 : opts.gap | 0);
    var missing = [];
    var on = {};
    var w = 0;
    var lines = String(text || '').replace(/\r/g, '').replace(/\t/g, '  ').split('\n');

    lines.forEach(function (line, li) {
      var y0 = li * (font.height + 1);
      var x = 0;
      var right = 0;
      Array.from(line).forEach(function (ch) {
        if (ch === ' ') {
          x += font.space + gap;
          return;
        }
        var g = glyphFor(font, ch);
        if (!g) {
          if (missing.indexOf(ch) === -1) {
            missing.push(ch);
          }
          x += font.space + gap;
          return;
        }
        if (opts.bold) {
          g = boldGlyph(g);
        }
        for (var gy = 0; gy < g.rows.length; gy++) {
          for (var gx = 0; gx < g.w; gx++) {
            if (g.rows[gy][gx]) {
              on[(x + gx) + ',' + (y0 + gy)] = 1;
            }
          }
        }
        x += g.w;
        right = x;
        x += gap;
      });
      w = Math.max(w, right);
    });

    var h = lines.length * (font.height + 1) - 1;
    var pad = opts.outline ? 1 : 0;
    var ink = [];
    var inkSet = {};
    Object.keys(on).forEach(function (k) {
      var p = k.split(',');
      var bx = +p[0] * scale + pad;
      var by = +p[1] * scale + pad;
      for (var sy = 0; sy < scale; sy++) {
        for (var sx = 0; sx < scale; sx++) {
          ink.push(bx + sx, by + sy);
          inkSet[(bx + sx) + ',' + (by + sy)] = 1;
        }
      }
    });

    var edge = [];
    if (opts.outline) {
      var seen = {};
      for (var i = 0; i < ink.length; i += 2) {
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var key = (ink[i] + dx) + ',' + (ink[i + 1] + dy);
            if (!inkSet[key] && !seen[key]) {
              seen[key] = 1;
              edge.push(ink[i] + dx, ink[i + 1] + dy);
            }
          }
        }
      }
    }

    return {
      w: w ? w * scale + pad * 2 : 0,
      h: h * scale + pad * 2,
      ink: ink,
      edge: edge,
      missing: missing
    };
  }

  var api = { compileBuiltIn: compileBuiltIn, fromFontMaker: fromFontMaker, layout: layout };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window === 'undefined') {
    return;
  }
  window.PixelArtText = api;

  // ---------------------------------------------------------------------
  // The tool and its panel.
  // ---------------------------------------------------------------------

  var POLL_INTERVAL = 200;
  var MAX_POLLS = 100;
  var pollCount = 0;

  var TOOL_ID = 'tool-text';
  var STORAGE_KEY = 'pixelart-text-tool';
  var ACCENT = '#00f900';

  var settings = { text: 'Hello', font: 'builtin:classic', scale: 1, bold: false, outline: false, gap: 1 };
  var builtIn = {};
  var ownFonts = null;       // [{ id, title, updated_at }] once listed
  var ownCache = {};         // 'id@updated_at' -> glyph model, or false when it failed
  var loading = null;        // font key being fetched
  var tool = null;
  var panel = null;

  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        Object.keys(settings).forEach(function (k) {
          if (typeof saved[k] === typeof settings[k]) {
            settings[k] = saved[k];
          }
        });
      }
    } catch (e) {}
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function source() {
    var s = window.pixelartFontSource;
    return s && typeof s.list === 'function' && typeof s.load === 'function' ? s : null;
  }

  function ownEntry(key) {
    var id = key.slice(3);
    return (ownFonts || []).filter(function (f) { return String(f.id) === id; })[0] || null;
  }

  function cacheKey(entry) {
    return entry.id + '@' + (entry.updated_at || '');
  }

  // The font to draw with right now, or null while one is loading or broken.
  function currentFont() {
    if (settings.font.indexOf('builtin:') === 0) {
      return builtIn[settings.font.slice(8)] || builtIn.classic;
    }
    var entry = ownEntry(settings.font);
    if (!entry) {
      return builtIn.classic;
    }
    var cached = ownCache[cacheKey(entry)];
    return cached || null;
  }

  function fetchOwnFont(key) {
    var entry = ownEntry(key);
    var src = source();
    if (!entry || !src || ownCache[cacheKey(entry)] !== undefined || loading === key) {
      return;
    }
    loading = key;
    syncPanel();
    Promise.resolve(src.load(entry.id)).then(function (data) {
      ownCache[cacheKey(entry)] = fromFontMaker(data, entry.title) || false;
    }, function () {
      ownCache[cacheKey(entry)] = false;
    }).then(function () {
      if (loading === key) {
        loading = null;
      }
      syncPanel();
      redrawPreview();
    });
  }

  // Asked once, the first time the tool is picked, never at boot.
  function listOwnFonts() {
    var src = source();
    if (!src || ownFonts !== null) {
      return;
    }
    ownFonts = [];
    Promise.resolve(src.list()).then(function (list) {
      ownFonts = Array.isArray(list) ? list.filter(function (f) { return f && f.id; }) : [];
    }, function () {
      ownFonts = [];
    }).then(function () {
      buildFontOptions();
      if (settings.font.indexOf('fm:') === 0) {
        if (ownEntry(settings.font)) {
          fetchOwnFont(settings.font);
        } else {
          settings.font = 'builtin:classic';
          saveSettings();
        }
      }
      syncPanel();
      redrawPreview();
    });
  }

  function currentLayout() {
    var font = currentFont();
    if (!font) {
      return null;
    }
    return layout(font, settings.text, settings);
  }

  function otherColor(color) {
    var colors = pskl.app.selectedColorsService;
    var primary = colors.getPrimaryColor();
    return color === primary ? colors.getSecondaryColor() : primary;
  }

  function isSeeThrough(color) {
    return !color || color === Constants.TRANSPARENT_COLOR || window.tinycolor(color).getAlpha() === 0;
  }

  // ---- the tool ----

  function TextTool() {
    pskl.tools.Tool.call(this);
    this.toolId = TOOL_ID;
    this.helpText = 'Text tool';
    this.shortcut = pskl.service.keyboard.Shortcuts.TOOL.TEXT;
    this.tooltipDescriptors = [
      { description: 'Type in the Text panel, click to place' },
      { description: 'Right click places it in your second color' }
    ];
    this.lastCol = null;
    this.lastRow = null;
  }

  function defineTool() {
    pskl.utils.inherit(TextTool, pskl.tools.drawing.BaseTool);

    TextTool.prototype.drawPreview = function (overlay, col, row) {
      overlay.clear();
      if (col === null || !overlay.containsPixel(col, row)) {
        return;
      }
      var lay = currentLayout();
      if (!lay) {
        return;
      }
      var color = pskl.app.selectedColorsService.getPrimaryColor();
      var edgeColor = pskl.app.selectedColorsService.getSecondaryColor();
      paint(overlay, lay.edge, col, row, isSeeThrough(edgeColor) ? Constants.SELECTION_TRANSPARENT_COLOR : edgeColor);
      paint(overlay, lay.ink, col, row, isSeeThrough(color) ? Constants.SELECTION_TRANSPARENT_COLOR : color);
    };

    TextTool.prototype.moveUnactiveToolAt = function (col, row, frame, overlay) {
      this.lastCol = Math.floor(col);
      this.lastRow = Math.floor(row);
      this.drawPreview(overlay, this.lastCol, this.lastRow);
    };

    TextTool.prototype.moveToolAt = TextTool.prototype.moveUnactiveToolAt;

    TextTool.prototype.hideHighlightedPixel = function (overlay) {
      overlay.clear();
    };

    TextTool.prototype.applyToolAt = function (col, row, frame, overlay) {
      // The text box keeps focus through a click on the canvas, and while it
      // has focus every tool shortcut types a letter instead.
      var box = panel && panel.querySelector('.txt-input');
      if (box && document.activeElement === box) {
        box.blur();
      }
      col = Math.floor(col);
      row = Math.floor(row);
      var lay = currentLayout();
      if (!lay || !lay.ink.length) {
        return;
      }
      var color = this.getToolColor();
      var edgeColor = otherColor(color);
      var data = {
        ink: offset(lay.ink, col, row),
        color: color,
        edge: offset(lay.edge, col, row),
        edgeColor: edgeColor
      };
      this.replay(frame, data);
      this.raiseSaveStateEvent(data);
    };

    TextTool.prototype.releaseToolAt = function (col, row, frame, overlay) {
      this.lastCol = Math.floor(col);
      this.lastRow = Math.floor(row);
      this.drawPreview(overlay, this.lastCol, this.lastRow);
    };

    TextTool.prototype.replay = function (frame, data) {
      paint(frame, data.edge, 0, 0, data.edgeColor);
      paint(frame, data.ink, 0, 0, data.color);
    };
  }

  function offset(points, col, row) {
    var out = [];
    for (var i = 0; i < points.length; i += 2) {
      out.push(points[i] + col, points[i + 1] + row);
    }
    return out;
  }

  // Frame.setPixel ignores anything outside the frame, so text can run off the edge.
  function paint(frame, points, col, row, color) {
    for (var i = 0; i < points.length; i += 2) {
      frame.setPixel(points[i] + col, points[i + 1] + row, color);
    }
  }

  function isCurrent() {
    var dc = pskl.app.drawingController;
    return !!(tool && dc && dc.currentToolBehavior === tool);
  }

  function redrawPreview() {
    if (!isCurrent()) {
      return;
    }
    tool.drawPreview(pskl.app.drawingController.overlayFrame, tool.lastCol, tool.lastRow);
  }

  function addTool() {
    var tc = pskl.app.toolController;
    pskl.service.keyboard.Shortcuts.TOOL.TEXT =
      new pskl.service.keyboard.Shortcut(TOOL_ID, 'Text tool', 'Y');
    defineTool();
    tool = new TextTool();
    tc.tools.push(tool);
    tc.createToolsDom_();
    // createToolsDom_ rebuilds every icon, which drops the selected mark.
    if (tc.currentSelectedTool) {
      $('[data-tool-id=' + tc.currentSelectedTool.toolId + ']').addClass('selected');
    }
    pskl.app.shortcutService.registerShortcut(tool.shortcut, tc.onKeyboardShortcut_.bind(tc, TOOL_ID));
  }

  // ---- the panel ----

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  }

  function segment(name, values, labels) {
    var seg = el('div', 'txt-seg');
    seg.setAttribute('data-setting', name);
    values.forEach(function (v, i) {
      var b = el('button', '', labels[i]);
      b.type = 'button';
      b.setAttribute('data-value', String(v));
      seg.appendChild(b);
    });
    return seg;
  }

  function buildPanel() {
    var host = document.getElementById('animated-preview-container');
    if (!host || document.getElementById('txt-panel')) {
      return;
    }
    panel = el('div');
    panel.id = 'txt-panel';
    panel.style.display = 'none';

    panel.appendChild(el('div', 'txt-title', 'Text'));

    var input = el('textarea', 'txt-input');
    input.rows = 2;
    input.maxLength = 200;
    input.spellcheck = false;
    input.placeholder = 'Type here';
    input.value = settings.text;
    input.addEventListener('input', function () {
      settings.text = input.value;
      saveSettings();
      syncPanel();
      redrawPreview();
    });
    panel.appendChild(input);

    panel.appendChild(el('label', 'txt-label', 'Font'));
    var select = el('select', 'txt-font');
    select.addEventListener('change', function () {
      settings.font = select.value;
      saveSettings();
      if (settings.font.indexOf('fm:') === 0) {
        fetchOwnFont(settings.font);
      }
      syncPanel();
      redrawPreview();
    });
    panel.appendChild(select);

    panel.appendChild(el('label', 'txt-label', 'Size'));
    panel.appendChild(segment('scale', [1, 2, 3, 4], ['1x', '2x', '3x', '4x']));
    panel.appendChild(el('label', 'txt-label', 'Letter gap'));
    panel.appendChild(segment('gap', [0, 1, 2], ['0', '1', '2']));

    var toggles = el('div', 'txt-seg txt-toggles');
    ['bold', 'outline'].forEach(function (name) {
      var b = el('button', '', name === 'bold' ? 'Bold' : 'Outline');
      b.type = 'button';
      b.setAttribute('data-toggle', name);
      toggles.appendChild(b);
    });
    panel.appendChild(toggles);

    panel.appendChild(el('div', 'txt-note'));
    panel.appendChild(el('div', 'txt-help',
      'Click the canvas to place it. Undo takes it back off.'));

    panel.addEventListener('click', function (evt) {
      var b = evt.target.closest('button');
      if (!b) {
        return;
      }
      if (b.hasAttribute('data-toggle')) {
        var name = b.getAttribute('data-toggle');
        settings[name] = !settings[name];
      } else if (b.hasAttribute('data-value')) {
        settings[b.parentNode.getAttribute('data-setting')] = +b.getAttribute('data-value');
      } else {
        return;
      }
      saveSettings();
      syncPanel();
      redrawPreview();
    });

    host.parentNode.insertBefore(panel, host.nextSibling);
    buildFontOptions();
    syncPanel();
  }

  function buildFontOptions() {
    var select = panel && panel.querySelector('.txt-font');
    if (!select) {
      return;
    }
    select.innerHTML = '';
    var group = el('optgroup');
    group.label = 'Built in';
    window.PixelArtFonts.forEach(function (def) {
      var o = el('option', '', def.name);
      o.value = 'builtin:' + def.id;
      group.appendChild(o);
    });
    select.appendChild(group);
    if (ownFonts && ownFonts.length) {
      group = el('optgroup');
      group.label = 'Your fonts';
      ownFonts.forEach(function (f) {
        var o = el('option', '', f.title || 'Untitled font');
        o.value = 'fm:' + f.id;
        group.appendChild(o);
      });
      select.appendChild(group);
    }
    select.value = settings.font;
    if (select.value !== settings.font) {
      select.value = 'builtin:classic';
    }
  }

  function syncPanel() {
    if (!panel) {
      return;
    }
    panel.querySelectorAll('.txt-seg[data-setting] button').forEach(function (b) {
      var name = b.parentNode.getAttribute('data-setting');
      b.classList.toggle('txt-on', String(settings[name]) === b.getAttribute('data-value'));
    });
    panel.querySelectorAll('button[data-toggle]').forEach(function (b) {
      b.classList.toggle('txt-on', !!settings[b.getAttribute('data-toggle')]);
    });

    var notes = [];
    var font = currentFont();
    if (loading === settings.font) {
      notes.push(['Loading your font...', '']);
    } else if (!font) {
      notes.push(['That font could not be read. Try another one.', 'txt-warn']);
    } else {
      var missing = layout(font, settings.text, settings).missing;
      if (missing.length) {
        notes.push(['Not in this font: ' + missing.join(' '), 'txt-warn']);
      }
    }
    if (settings.outline) {
      var colors = pskl.app.selectedColorsService;
      if (isSeeThrough(colors.getSecondaryColor())) {
        notes.push(['The outline uses your second color, and it is see-through, so the outline will clear pixels.', 'txt-warn']);
      } else {
        notes.push(['The outline uses your second color.', '']);
      }
    }
    if (source() && ownFonts && !ownFonts.length) {
      notes.push(['Fonts you make in FontMaker show up here.', '']);
    }

    var box = panel.querySelector('.txt-note');
    box.innerHTML = '';
    notes.forEach(function (n) {
      box.appendChild(el('div', n[1], n[0]));
    });
  }

  function onToolSelected(evt, selected) {
    var on = selected === tool;
    if (panel) {
      panel.style.display = on ? '' : 'none';
    }
    if (on) {
      listOwnFonts();
      syncPanel();
    }
  }

  function injectStyles() {
    if (document.getElementById('txt-styles')) {
      return;
    }
    // A pixel "T" in the stock icons' light gray.
    var icon = '<svg xmlns="http://www.w3.org/2000/svg" width="46" height="46" viewBox="0 0 46 46">' +
      '<path fill="#e4e4e4" d="M11 11h24v5h-9v19h-6V16h-9z"/></svg>';
    var style = document.createElement('style');
    style.id = 'txt-styles';
    style.textContent = [
      '.icon-' + TOOL_ID + ' { background: #3a3a3a url("data:image/svg+xml,' +
        encodeURIComponent(icon) + '") no-repeat center; }',
      '.tool-icon.selected.icon-' + TOOL_ID + ', .icon-' + TOOL_ID + ':hover { background-color: #444; }',
      '#txt-panel { margin: 6px 0 0 0; padding: 5px 8px 8px; background: #262626;',
      '  border: 1px solid #3d3d3d; border-radius: 3px; color: #b3b3b3; font-size: 12px; }',
      '#txt-panel .txt-title { font-weight: bold; color: #d3d3d3; margin-bottom: 5px; }',
      '#txt-panel .txt-input { display: block; box-sizing: border-box; width: 100%; resize: vertical;',
      '  min-height: 38px; margin: 0; padding: 4px 6px; font: 13px/1.35 monospace; color: #eee;',
      '  background: #1b1b1b; border: 1px solid #4a4a4a; border-radius: 4px; }',
      '#txt-panel .txt-input:focus { outline: none; border-color: ' + ACCENT + '; }',
      '#txt-panel .txt-label { display: block; margin: 7px 0 3px; font-size: 10px;',
      '  letter-spacing: .06em; text-transform: uppercase; color: #8a8a8a; }',
      '#txt-panel .txt-font { display: block; box-sizing: border-box; width: 100%; height: 24px;',
      '  font-family: inherit; font-size: 12px; color: #ddd; background: #2e2e2e;',
      '  border: 1px solid #4a4a4a; border-radius: 4px; }',
      '#txt-panel .txt-seg { display: flex; border: 1px solid #4a4a4a; border-radius: 4px;',
      '  overflow: hidden; }',
      '#txt-panel .txt-seg button { flex: 1 1 0; min-width: 0; height: 22px; margin: 0; padding: 0 2px;',
      '  font-family: inherit; font-size: 11px; color: #bdbdbd; background: #2e2e2e; border: 0;',
      '  border-left: 1px solid #4a4a4a; cursor: pointer; white-space: nowrap; }',
      '#txt-panel .txt-seg button:first-child { border-left: 0; }',
      '#txt-panel .txt-seg button:hover { color: #fff; background: #3a3a3a; }',
      '#txt-panel .txt-seg button.txt-on { color: #1d1d1d; background: ' + ACCENT + '; font-weight: bold; }',
      '#txt-panel .txt-toggles { margin-top: 8px; }',
      '#txt-panel .txt-note { margin-top: 6px; font-size: 11px; line-height: 1.4; }',
      '#txt-panel .txt-note div { margin-top: 3px; }',
      '#txt-panel .txt-warn { color: #c9a53d; }',
      '#txt-panel .txt-help { margin-top: 6px; font-size: 11px; color: #8a8a8a; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function subscribeAll() {
    $.subscribe(Events.TOOL_SELECTED, onToolSelected);
    // Swapping or picking colors changes what the outline note says and what
    // the preview shows.
    $.subscribe(Events.PRIMARY_COLOR_SELECTED, function () { syncPanel(); redrawPreview(); });
    $.subscribe(Events.SECONDARY_COLOR_SELECTED, function () { syncPanel(); redrawPreview(); });
    var area = document.getElementById('drawing-canvas-container');
    if (area) {
      area.addEventListener('mouseleave', function () {
        if (isCurrent()) {
          tool.lastCol = tool.lastRow = null;
          pskl.app.drawingController.overlayFrame.clear();
        }
      });
    }
  }

  function waitForPiskel() {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      console.error('[TextTool] Piskel engine not found, text tool disabled');
      return;
    }
    var ready = window.pskl && window.$ && window.Events && window.Constants && pskl.app &&
      pskl.app.toolController && pskl.app.drawingController && pskl.app.shortcutService &&
      pskl.app.selectedColorsService && pskl.tools && pskl.tools.drawing &&
      pskl.tools.drawing.BaseTool && pskl.service && pskl.service.keyboard &&
      window.PixelArtFonts && document.getElementById('animated-preview-container');
    if (!ready) {
      setTimeout(waitForPiskel, POLL_INTERVAL);
      return;
    }
    window.PixelArtFonts.forEach(function (def) {
      builtIn[def.id] = compileBuiltIn(def);
    });
    loadSettings();
    injectStyles();
    addTool();
    buildPanel();
    subscribeAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForPiskel);
  } else {
    waitForPiskel();
  }
})();
