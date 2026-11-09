/**
 * dither-patterns.js - Patterns for the Dithering tool, and a Fill mode.
 *
 * Stock Piskel dithers one way: a 50% checkerboard of the primary and
 * secondary colors. This adds a small swatch panel beside the tool column
 * while the tool is selected: five mix levels, four kinds of line, two
 * grids, two stipples. Fill mode paints the pattern into a connected area of one color,
 * like the bucket. Ramp mode fills that area with a gradient along a drag,
 * from the first color to the second, in one of seven styles (ordered,
 * scattered, lines, dashes, upright dashes, dotted lines, plus shapes),
 * optionally through every palette color between the two.
 *
 * The levels come from one 4x4 ordered (Bayer) matrix, so each level holds
 * every pixel of the lighter ones below it. A ramp drawn 25 -> 50 -> 75 has
 * no pixel that flips back, which is what makes it read as one gradient.
 * The 50% level is the stock checkerboard, pixel for pixel.
 *
 * Patterns are anchored to the frame's own corner, as stock is. In
 * transition mode they are anchored to the 3x3 sheet instead, so a pattern
 * runs across tile seams even when the tile size does not divide evenly.
 *
 * Strokes and fills are stored in history as plain pixel lists (the stock
 * SimplePen replay), so undo, redo and collaboration never depend on the
 * pattern setting.
 *
 * Add-on pattern as in transition-tiles.js: poll for pskl, patch, inject
 * DOM. The packaged Piskel bundle is not edited.
 */
(function () {
  'use strict';

  // No DOM and no pskl here, so Node can test it.

  var BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
  ];

  // Shifted one column so level 8 lands on the stock checkerboard, which
  // puts the primary color where (col + row) is odd.
  function level(n) {
    return function (x, y) {
      return BAYER[y & 3][(x + 1) & 3] < n;
    };
  }

  // Stipple: the order dots are added in, on a 16x16 tile that wraps. Each
  // dot goes in the emptiest spot left, with a small random nudge so the
  // dots do not settle into a grid (without it they formed one). Made once,
  // offline, and kept only where it passed: no two dots touching at 12%, no
  // row or column holding more than 2 dots at 6%, and the platform's
  // "Check my tiling" calling a stippled grass tile good. Denser than 12%
  // is left out on purpose: at 25% dots start touching band edges, and
  // "Check my seams" reads those as breaks.
  var STIPPLE = [
     23,138,180, 77,164,237,  6,142, 72,183,102,  5, 41,157,106,225,
    151,212, 35,108,131, 48,206,120,255, 50,221,146, 68,210, 46, 76,
    121, 62,241,197, 22, 90,175, 98, 16,163, 86,117,244,181, 18,167,
    191,  0, 73,156,136,249, 64,219,129,201, 28,192, 10,133, 96,254,
    110,215, 93,227, 42,185,  9,150, 78, 58,220,104,160, 63,224, 38,
     24,140,174, 19,123,103,228, 34,171,238,135, 44,231, 80,147,177,
     91, 59,243, 49,211,158, 83,193,109,  3, 88,179, 21,195, 55,207,
    119,155,190, 75,134, 14,253, 43,141,204,153,250,116,100,  4,246,
     32,222,  7,113,226,176, 65,126,217, 69, 51, 30,162,223,132,166,
     54,101,202,145, 36, 95,196, 20, 99,235,125,199, 74, 39,203, 82,
    251,172, 70,236, 57,165,245,149, 33,169,  8,182,242,144, 11,186,
     26,105, 15,124,187,  1, 79,115,209, 85,139,107, 53, 92,232,122,
    143,208,161,218, 87,137,230, 47,178,247, 60,205, 17,114,168, 67,
    239, 81, 31, 52,248, 27,200, 71, 12,154, 37,229,184,152,216, 45,
    173,128,194,112,148, 94,159,111,214,130, 84,118, 66, 29, 89,  2,
     97, 56,234, 13,213, 61,189, 40,233, 25,170,240,198,127,252,188
  ];

  function stipple(n) {
    return function (x, y) {
      return STIPPLE[(y & 15) * 16 + (x & 15)] < n;
    };
  }

  var PATTERNS = [
    { id: 'mix12', group: 'mix', title: 'A little of the first color', test: level(2) },
    { id: 'mix25', group: 'mix', title: 'One in four first color', test: level(4) },
    { id: 'mix50', group: 'mix', title: 'Half and half (checkerboard)', test: level(8) },
    { id: 'mix75', group: 'mix', title: 'Three in four first color', test: level(12) },
    { id: 'mix88', group: 'mix', title: 'Mostly the first color', test: level(14) },
    { id: 'rows', group: 'lines', title: 'Lines across', test: function (x, y) { return (y & 1) === 1; } },
    { id: 'cols', group: 'lines', title: 'Lines up and down', test: function (x, y) { return (x & 1) === 1; } },
    { id: 'rise', group: 'lines', title: 'Slanted lines, up to the right', test: function (x, y) { return ((x + y) & 3) < 2; } },
    { id: 'fall', group: 'lines', title: 'Slanted lines, down to the right', test: function (x, y) { return ((x - y) & 3) < 2; } },
    { id: 'grid', group: 'grid', title: 'Square grid', test: function (x, y) { return (x & 3) === 0 || (y & 3) === 0; } },
    { id: 'hatch', group: 'grid', title: 'Diamond grid', test: function (x, y) { return ((x + y) & 3) === 0 || ((x - y) & 3) === 0; } },
    { id: 'dots6', group: 'stipple', title: 'A few scattered dots (repeats every 16 pixels)', test: stipple(16) },
    { id: 'dots12', group: 'stipple', title: 'Scattered dots (repeats every 16 pixels)', test: stipple(32) }
  ];

  var DEFAULT_ID = 'mix50';

  function byId(id) {
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i].id === id) {
        return PATTERNS[i];
      }
    }
    return null;
  }

  // True = primary color at this pixel.
  function usesPrimary(id, x, y) {
    var p = byId(id) || byId(DEFAULT_ID);
    return p.test(x, y);
  }

  // Ramp: solid first color, the five mix levels, solid second color, in
  // equal bands along the drag. The same steps as the Mix swatches, so a
  // ramp and a hand-drawn band of swatches match pixel for pixel.
  var RAMP_LEVELS = [16, 14, 12, 8, 4, 2, 0];

  // Which band pixel (x, y) falls in for a drag from a to b, by where it
  // lands along the drag. -1 when the drag has no length.
  function rampBand(ax, ay, bx, by, x, y) {
    var dx = bx - ax;
    var dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (!len2) {
      return -1;
    }
    var t = ((x - ax) * dx + (y - ay) * dy) / len2;
    var n = RAMP_LEVELS.length;
    return Math.min(n - 1, Math.max(0, Math.floor(t * n)));
  }

  // ox, oy: where the frame's corner sits in the pattern.
  function rampUsesPrimary(ax, ay, bx, by, x, y, ox, oy) {
    var band = rampBand(ax, ay, bx, by, x, y);
    return band >= 0 && BAYER[(y + (oy || 0)) & 3][(x + (ox || 0) + 1) & 3] < RAMP_LEVELS[band];
  }

  // Ramp styles. Ordered is the banded ramp above, unchanged. The others
  // fade smoothly: every pixel has a place in a turn-on order (a threshold
  // from 0 to 1), and how far along the drag a pixel sits decides how much
  // of that order has turned over. The first and last seventh of the drag
  // stay solid, as they do in the ordered ramp, so the styles line up.
  var RAMP_STYLES = [
    { id: 'ordered', title: 'Ordered: the Mix steps, one pixel at a time' },
    { id: 'scattered', title: 'Scattered dots, thick near the join and thin away from it' },
    { id: 'lines', title: 'Lines across, thinning away from the join' },
    { id: 'dashes', title: 'Dashes two pixels wide, laid like bricks' },
    { id: 'upright', title: 'Upright dashes two pixels tall' },
    { id: 'dotted', title: 'Lines that break into dots away from the join' },
    { id: 'plus', title: 'Plus shapes, the other color on each side of the join' }
  ];
  var LINE_ORDER = [0, 2, 1, 3];

  // Plus shapes: 16 crosses on a 16 x 16 tile that wraps, rows of four with
  // every other row shifted by two, so no two crosses touch. They switch on
  // in the order the stipple map gives their centers, which scatters them.
  var PLUS_RANK = (function () {
    var centers = [];
    for (var cy = 0; cy < 16; cy += 4) {
      for (var cx = 0; cx < 16; cx += 4) {
        var x = (cx + ((cy / 4) % 2) * 2) & 15;
        centers.push({ x: x, y: cy, order: STIPPLE[cy * 16 + x] });
      }
    }
    centers.sort(function (a, b) { return a.order - b.order; });
    var map = [];
    for (var i = 0; i < 256; i++) {
      map.push(-1);
    }
    centers.forEach(function (c, rank) {
      [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        map[((c.y + d[1]) & 15) * 16 + ((c.x + d[0]) & 15)] = rank;
      });
    });
    return map;
  })();

  function threshold(style, x, y) {
    if (style === 'scattered') {
      return (STIPPLE[(y & 15) * 16 + (x & 15)] + 0.5) / 256;
    }
    if (style === 'lines') {
      return (LINE_ORDER[y & 3] + 0.5) / 4;
    }
    if (style === 'dashes') {
      return (BAYER[y & 3][((x >> 1) + 1) & 3] + 0.5) / 16;
    }
    if (style === 'upright') {
      return (BAYER[(y >> 1) & 3][(x + 1) & 3] + 0.5) / 16;
    }
    if (style === 'dotted') {
      // Whole rows in line order, and inside a row the pixels in dot order,
      // so a row starts as dots, closes up, and ends as a full line.
      return (LINE_ORDER[y & 3] + (LINE_ORDER[x & 3] + 0.5) / 4) / 4;
    }
    return (BAYER[y & 3][(x + 1) & 3] + 0.5) / 16;
  }

  // How far along the drag pixel (x, y) sits, 0 to 1. -1 for no drag.
  function rampT(ax, ay, bx, by, x, y) {
    var dx = bx - ax;
    var dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (!len2) {
      return -1;
    }
    return Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
  }

  // Whether a pixel keeps the start color at position t of a two-color fade.
  function keepsStart(style, t, x, y) {
    if (!style || style === 'ordered') {
      var n = RAMP_LEVELS.length;
      var band = Math.min(n - 1, Math.max(0, Math.floor(t * n)));
      return BAYER[y & 3][(x + 1) & 3] < RAMP_LEVELS[band];
    }
    var u = (t * 7 - 1) / 5;
    if (u <= 0) {
      return true;
    }
    if (u >= 1) {
      return false;
    }
    if (style === 'plus') {
      // First half: crosses of the end color appear on the start color.
      // Second half: crosses of the start color thin out on the end color.
      var rank = PLUS_RANK[(y & 15) * 16 + (x & 15)];
      if (u < 0.5) {
        return !(rank >= 0 && rank < u * 32);
      }
      return rank >= 0 && rank < (1 - u) * 32;
    }
    return threshold(style, x, y) >= u;
  }

  // Which of `count` colors (first = start of the drag) pixel (x, y) gets.
  // Several colors split the drag into equal stretches, each a two-color
  // fade into the next, so a sky ramp passes through every band.
  function rampColor(style, ax, ay, bx, by, x, y, ox, oy, count) {
    var t = rampT(ax, ay, bx, by, x, y);
    if (t < 0) {
      return -1;
    }
    var n = Math.max(2, count || 2);
    var s = t * (n - 1);
    var k = Math.min(n - 2, Math.floor(s));
    return keepsStart(style, s - k, x + (ox || 0), y + (oy || 0)) ? k : k + 1;
  }

  var api = {
    patterns: PATTERNS, byId: byId, usesPrimary: usesPrimary, DEFAULT_ID: DEFAULT_ID,
    RAMP_LEVELS: RAMP_LEVELS, rampBand: rampBand, rampUsesPrimary: rampUsesPrimary,
    RAMP_STYLES: RAMP_STYLES, rampColor: rampColor, keepsStart: keepsStart
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window === 'undefined') {
    return;
  }
  window.PixelArtDither = api;

  var POLL_INTERVAL = 200;
  var MAX_POLLS = 100;
  var pollCount = 0;
  var TOOL_ID = 'tool-dithering';
  var ACCENT = '#00f900';
  var PATTERN_KEY = 'pixelart-dither-pattern';
  var MODE_KEY = 'pixelart-dither-mode';
  var RAMP_STYLE_KEY = 'pixelart-dither-ramp-style';
  var THROUGH_KEY = 'pixelart-dither-ramp-through';

  var settings = { pattern: DEFAULT_ID, mode: 'paint', rampStyle: 'ordered', through: false };
  var panel = null;
  // Fill and Ramp take their area once per real press. Transition mode
  // re-presses the tool when a drag crosses into the next tile, and that
  // must not start another one.
  var fillArmed = false;

  function loadSettings() {
    try {
      var p = localStorage.getItem(PATTERN_KEY);
      if (p && byId(p)) {
        settings.pattern = p;
      }
      var m = localStorage.getItem(MODE_KEY);
      settings.mode = m === 'fill' || m === 'ramp' ? m : 'paint';
      var rs = localStorage.getItem(RAMP_STYLE_KEY);
      settings.rampStyle = RAMP_STYLES.some(function (r) { return r.id === rs; }) ? rs : 'ordered';
      settings.through = localStorage.getItem(THROUGH_KEY) === '1';
    } catch (e) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(PATTERN_KEY, settings.pattern);
      localStorage.setItem(MODE_KEY, settings.mode);
      localStorage.setItem(RAMP_STYLE_KEY, settings.rampStyle);
      localStorage.setItem(THROUGH_KEY, settings.through ? '1' : '0');
    } catch (e) {}
  }

  // Where this frame's corner sits in the pattern.
  function origin() {
    var t = window.PixelArtTransition;
    var o = t && t.tileOrigin ? t.tileOrigin() : null;
    return o || { x: 0, y: 0 };
  }

  function colorAt(col, row, o) {
    var primary = usesPrimary(settings.pattern, col + o.x, row + o.y);
    if (pskl.app.mouseStateService.isRightButtonPressed()) {
      primary = !primary;
    }
    var colors = pskl.app.selectedColorsService;
    return primary ? colors.getPrimaryColor() : colors.getSecondaryColor();
  }

  function swapped() {
    return pskl.app.mouseStateService.isRightButtonPressed();
  }

  function sameColor(c) {
    try {
      return window.tinycolor(c).toHex8String();
    } catch (e) {
      return String(c);
    }
  }

  // The colors a ramp passes through, start first. With "through palette"
  // on, every color of the selected palette from the primary to the
  // secondary, in palette order (either way round), so a palette saved from
  // the gradient maker becomes a whole sky in one drag. missing: one of the
  // two is not in that palette, and the ramp falls back to just the two.
  function rampColors() {
    var colors = pskl.app.selectedColorsService;
    var first = colors.getPrimaryColor();
    var second = colors.getSecondaryColor();
    if (!settings.through) {
      return { colors: [first, second] };
    }
    var list = [];
    try {
      var pal = pskl.app.paletteService.getPaletteById(pskl.UserSettings.get(pskl.UserSettings.SELECTED_PALETTE));
      list = pal && pal.getColors ? pal.getColors() : [];
    } catch (e) {}
    var keys = list.map(sameColor);
    var i = keys.indexOf(sameColor(first));
    var j = keys.indexOf(sameColor(second));
    if (i === -1 || j === -1 || i === j) {
      return { colors: [first, second], missing: true };
    }
    return { colors: i < j ? list.slice(i, j + 1) : list.slice(j, i + 1).reverse() };
  }

  function patchTool() {
    var Tool = pskl.tools.drawing.DitheringTool;
    var proto = Tool.prototype;
    var penApply = proto.applyToolAt;
    var penMove = proto.moveToolAt;
    var penRelease = proto.releaseToolAt;

    proto.applyToolOnPixel = function (col, row, frame, overlay) {
      this.draw(colorAt(col, row, origin()), col, row, frame, overlay);
    };

    proto.applyToolAt = function (col, row, frame, overlay, event) {
      if (settings.mode === 'paint') {
        return penApply.call(this, col, row, frame, overlay, event);
      }
      this.previousCol = col;
      this.previousRow = row;
      if (!fillArmed) {
        return;
      }
      fillArmed = false;
      var pixels = pskl.PixelUtils.getSimilarConnectedPixelsFromFrame(frame, col, row);
      if (settings.mode === 'ramp') {
        this.ramp = { from: { col: col, row: row }, area: pixels, o: origin() };
        return;
      }
      var o = origin();
      for (var i = 0; i < pixels.length; i++) {
        this.draw(colorAt(pixels[i].col, pixels[i].row, o), pixels[i].col, pixels[i].row, frame, overlay);
      }
    };

    // The ramp is redrawn on every move and only shown on the overlay until
    // release. The stock draw() writes a see-through color straight into
    // the frame, which would erase the art under every spot the drag passed.
    function drawRamp(tool, col, row, overlay) {
      var r = tool.ramp;
      var list = rampColors().colors.slice();
      if (swapped()) {
        list.reverse();
      }
      overlay.clear();
      tool.pixels = [];
      if (col === r.from.col && row === r.from.row) {
        return;
      }
      for (var i = 0; i < r.area.length; i++) {
        var p = r.area[i];
        var color = list[rampColor(settings.rampStyle, r.from.col, r.from.row, col, row, p.col, p.row, r.o.x, r.o.y, list.length)];
        overlay.setPixel(p.col, p.row, color);
        tool.pixels.push({ col: p.col, row: p.row, color: color });
      }
    }

    proto.moveToolAt = function (col, row, frame, overlay, event) {
      if (settings.mode === 'paint') {
        return penMove.call(this, col, row, frame, overlay, event);
      }
      this.previousCol = col;
      this.previousRow = row;
      if (settings.mode === 'ramp' && this.ramp) {
        drawRamp(this, col, row, overlay);
      }
    };

    // A press that filled nothing (a drag carried into another tile, a
    // click off the canvas, a ramp with no drag) would otherwise leave an
    // empty undo step.
    proto.releaseToolAt = function (col, row, frame, overlay, event) {
      this.ramp = null;
      if (settings.mode !== 'paint' && !this.pixels.length) {
        overlay.clear();
        return;
      }
      return penRelease.call(this, col, row, frame, overlay, event);
    };

    // Transition mode carries pen strokes from tile to tile. A fill or a
    // ramp belongs to the tile it was pressed in.
    proto.staysOnTile = function () {
      return settings.mode !== 'paint';
    };

    var host = document.getElementById('drawing-canvas-container');
    var arm = function (evt) {
      fillArmed = !!host && host.contains(evt.target);
    };
    window.addEventListener('mousedown', arm, true);
    window.addEventListener('touchstart', arm, true);
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

  function isSeeThrough(color) {
    if (!color || color === Constants.TRANSPARENT_COLOR) {
      return true;
    }
    try {
      return window.tinycolor(color).getAlpha() === 0;
    } catch (e) {
      return false;
    }
  }

  var SWATCH_CELLS = 8;
  var SWATCH_SCALE = 3;

  // Drawn in the stock icons' light gray on near black, not in the
  // student's colors: two neighboring shades (the usual way to dither) would
  // make every swatch look flat, and two strong colors shimmer at this size.
  function drawSwatch(canvas, id) {
    var ctx = canvas.getContext('2d');
    for (var y = 0; y < SWATCH_CELLS; y++) {
      for (var x = 0; x < SWATCH_CELLS; x++) {
        ctx.fillStyle = usesPrimary(id, x, y) ? '#e4e4e4' : '#1b1b1b';
        ctx.fillRect(x * SWATCH_SCALE, y * SWATCH_SCALE, SWATCH_SCALE, SWATCH_SCALE);
      }
    }
  }

  // A tiny ramp, top to bottom, in the same light-on-dark as the patterns.
  function drawRampSwatch(canvas, style) {
    var ctx = canvas.getContext('2d');
    var cells = 12;
    var size = canvas.width / cells;
    for (var y = 0; y < cells; y++) {
      for (var x = 0; x < cells; x++) {
        ctx.fillStyle = keepsStart(style, (y + 0.5) / cells, x, y) ? '#e4e4e4' : '#1b1b1b';
        ctx.fillRect(x * size, y * size, size, size);
      }
    }
  }

  function buildPanel() {
    var host = document.getElementById('animated-preview-container');
    if (!host || document.getElementById('dth-panel')) {
      return;
    }
    panel = el('div');
    panel.id = 'dth-panel';
    panel.style.display = 'none';

    var mode = el('div', 'dth-seg');
    [['paint', 'Paint'], ['fill', 'Fill'], ['ramp', 'Ramp']].forEach(function (m) {
      var b = el('button', '', m[1]);
      b.type = 'button';
      b.setAttribute('data-mode', m[0]);
      b.title = {
        paint: 'Paint the pattern with the brush',
        fill: 'Click an area to fill it with the pattern',
        ramp: 'Drag across an area to blend from your first color to your second'
      }[m[0]];
      mode.appendChild(b);
    });
    panel.appendChild(mode);

    var grid = el('div', 'dth-swatches');
    PATTERNS.forEach(function (p) {
      var b = el('button', 'dth-swatch');
      b.type = 'button';
      b.title = p.title + '. Right-click on the canvas swaps your two colors.';
      b.setAttribute('aria-label', p.title);
      b.setAttribute('data-pattern', p.id);
      var cv = el('canvas');
      cv.width = cv.height = SWATCH_CELLS * SWATCH_SCALE;
      drawSwatch(cv, p.id);
      b.appendChild(cv);
      grid.appendChild(b);
    });
    panel.appendChild(grid);

    // In Ramp mode the patterns give way to the ramp styles.
    var styles = el('div', 'dth-swatches dth-ramp-styles');
    RAMP_STYLES.forEach(function (r) {
      var b = el('button', 'dth-swatch');
      b.type = 'button';
      b.title = r.title;
      b.setAttribute('aria-label', r.title);
      b.setAttribute('data-ramp-style', r.id);
      var cv = el('canvas');
      cv.width = cv.height = SWATCH_CELLS * SWATCH_SCALE;
      drawRampSwatch(cv, r.id);
      b.appendChild(cv);
      styles.appendChild(b);
    });
    panel.appendChild(styles);
    var through = el('button', 'dth-through', 'Through palette');
    through.type = 'button';
    through.setAttribute('data-through', '1');
    through.title = 'Blend through every color of the selected palette between your first and second colors, ' +
      'in palette order. Save the gradient maker\'s palette, pick it, then drag once for a whole sky.';
    panel.appendChild(through);

    panel.appendChild(el('div', 'dth-note'));

    panel.addEventListener('click', function (evt) {
      var b = evt.target.closest('button');
      if (!b) {
        return;
      }
      if (b.hasAttribute('data-mode')) {
        settings.mode = b.getAttribute('data-mode');
      } else if (b.hasAttribute('data-pattern')) {
        settings.pattern = b.getAttribute('data-pattern');
      } else if (b.hasAttribute('data-ramp-style')) {
        settings.rampStyle = b.getAttribute('data-ramp-style');
      } else if (b.hasAttribute('data-through')) {
        settings.through = !settings.through;
      } else {
        return;
      }
      saveSettings();
      syncPanel();
    });

    // Floats beside the tool column, over the frame list, so the right
    // column (layers, palettes, the transition preview) never moves.
    document.body.appendChild(panel);
    window.addEventListener('resize', placePanel);
    syncPanel();
  }

  function syncPanel() {
    if (!panel) {
      return;
    }
    panel.querySelectorAll('button[data-mode]').forEach(function (b) {
      b.classList.toggle('dth-on', b.getAttribute('data-mode') === settings.mode);
    });
    panel.querySelectorAll('button[data-pattern]').forEach(function (b) {
      var id = b.getAttribute('data-pattern');
      b.classList.toggle('dth-on', id === settings.pattern);
    });
    panel.querySelectorAll('button[data-ramp-style]').forEach(function (b) {
      b.classList.toggle('dth-on', b.getAttribute('data-ramp-style') === settings.rampStyle);
    });
    panel.querySelector('.dth-through').classList.toggle('dth-on', settings.through);
    panel.classList.toggle('dth-ramp', settings.mode === 'ramp');
    var box = panel.querySelector('.dth-note');
    box.innerHTML = '';
    if (settings.mode === 'ramp') {
      var rc = rampColors();
      box.appendChild(el('div', '', 'Drag from the first color toward the second.'));
      if (rc.missing) {
        box.appendChild(el('div', 'dth-warn', 'Your two colors are not both in the palette, so just the two.'));
      } else if (settings.through) {
        box.appendChild(el('div', '', 'Through ' + rc.colors.length + ' palette colors.'));
      }
    }
    if (isSeeThrough(pskl.app.selectedColorsService.getSecondaryColor())) {
      box.appendChild(el('div', 'dth-warn', 'Second color is see-through: gaps erase.'));
    }
    box.style.display = box.childNodes.length ? '' : 'none';
    placePanel();
  }

  function placePanel() {
    if (!panel || panel.style.display === 'none') {
      return;
    }
    var btn = document.querySelector('[data-tool-id="' + TOOL_ID + '"]');
    var column = document.getElementById('tool-section');
    if (!btn || !column) {
      return;
    }
    var b = btn.getBoundingClientRect();
    panel.style.left = (column.getBoundingClientRect().right + 2) + 'px';
    var top = Math.min(b.top, window.innerHeight - panel.offsetHeight - 6);
    panel.style.top = Math.max(6, top) + 'px';
  }

  function isCurrent() {
    var tc = pskl.app.toolController;
    return !!(tc && tc.currentSelectedTool && tc.currentSelectedTool.toolId === TOOL_ID);
  }

  function onToolSelected() {
    if (panel) {
      panel.style.display = isCurrent() ? '' : 'none';
      syncPanel();
      placePanel();
    }
  }

  function injectStyles() {
    if (document.getElementById('dth-styles')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'dth-styles';
    style.textContent = [
      '#dth-panel { position: fixed; z-index: 900; box-sizing: border-box; width: 116px; padding: 5px;',
      '  background: #262626; border: 1px solid #4a4a4a; border-radius: 3px;',
      '  box-shadow: 0 2px 8px rgba(0, 0, 0, .5); color: #b3b3b3; font-size: 11px; }',
      '#dth-panel .dth-seg { display: flex; margin-bottom: 5px; border: 1px solid #4a4a4a;',
      '  border-radius: 3px; overflow: hidden; }',
      '#dth-panel .dth-seg button { flex: 1 1 0; min-width: 0; height: 22px; margin: 0; padding: 0;',
      '  font-family: inherit; font-size: 11px; color: #bdbdbd; background: #2e2e2e; border: 0;',
      '  border-left: 1px solid #4a4a4a; cursor: pointer; }',
      '#dth-panel .dth-seg button:first-child { border-left: 0; }',
      '#dth-panel .dth-seg button:hover { color: #fff; background: #3a3a3a; }',
      '#dth-panel .dth-seg button.dth-on { color: #1d1d1d; background: ' + ACCENT + '; font-weight: bold; }',
      '#dth-panel .dth-swatches { display: grid; grid-template-columns: repeat(3, 32px); gap: 4px; }',
      '#dth-panel .dth-swatch { width: 32px; height: 32px; margin: 0; padding: 0; box-sizing: border-box;',
      '  display: flex; align-items: center; justify-content: center; background: #1b1b1b;',
      '  border: 2px solid #3a3a3a; border-radius: 3px; cursor: pointer; }',
      '#dth-panel .dth-swatch:hover { border-color: #8a8a8a; }',
      '#dth-panel .dth-swatch.dth-on { border-color: ' + ACCENT + '; }',
      '#dth-panel .dth-swatch canvas { display: block; width: 24px; height: 24px; image-rendering: pixelated; }',
      '#dth-panel .dth-note { margin-top: 5px; line-height: 1.3; color: #8a8a8a; }',
      '#dth-panel .dth-note .dth-warn { color: #c9a53d; }',
      '#dth-panel .dth-ramp-styles, #dth-panel .dth-through { display: none; }',
      '#dth-panel.dth-ramp .dth-swatches { display: none; }',
      '#dth-panel.dth-ramp .dth-ramp-styles { display: grid; }',
      '#dth-panel.dth-ramp .dth-through { display: block; width: 100%; height: 22px; margin-top: 5px; padding: 0;',
      '  font-family: inherit; font-size: 11px; color: #bdbdbd; background: #2e2e2e;',
      '  border: 1px solid #4a4a4a; border-radius: 3px; cursor: pointer; }',
      '#dth-panel .dth-through:hover { color: #fff; background: #3a3a3a; }',
      '#dth-panel.dth-ramp .dth-through.dth-on { color: #1d1d1d; background: ' + ACCENT + '; font-weight: bold; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function subscribeAll() {
    $.subscribe(Events.TOOL_SELECTED, onToolSelected);
    $.subscribe(Events.PRIMARY_COLOR_SELECTED, syncPanel);
    $.subscribe(Events.SECONDARY_COLOR_SELECTED, syncPanel);
    // Picking another palette changes what "through palette" passes through.
    $.subscribe(Events.USER_SETTINGS_CHANGED, function () {
      if (panel && settings.mode === 'ramp') {
        syncPanel();
      }
    });
  }

  function waitForPiskel() {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      console.error('[Dither] Piskel engine not found, dither patterns disabled');
      return;
    }
    var ready = window.pskl && window.$ && window.Events && window.Constants && pskl.app &&
      pskl.app.toolController && pskl.app.selectedColorsService && pskl.app.mouseStateService &&
      pskl.tools && pskl.tools.drawing && pskl.tools.drawing.DitheringTool && pskl.PixelUtils &&
      document.getElementById('animated-preview-container') &&
      document.getElementById('drawing-canvas-container');
    if (!ready) {
      setTimeout(waitForPiskel, POLL_INTERVAL);
      return;
    }
    loadSettings();
    injectStyles();
    patchTool();
    buildPanel();
    subscribeAll();
    onToolSelected();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForPiskel);
  } else {
    waitForPiskel();
  }
})();
