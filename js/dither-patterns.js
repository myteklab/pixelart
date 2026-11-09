/**
 * dither-patterns.js - Patterns for the Dithering tool, and a Fill mode.
 *
 * Stock Piskel dithers one way: a 50% checkerboard of the primary and
 * secondary colors. This adds a small swatch panel beside the tool column
 * while the tool is selected: five mix levels, four kinds of line, two
 * grids. Fill mode paints the pattern into a connected area of one color,
 * like the bucket. Ramp mode fills that area with a gradient along a drag,
 * stepping through the mix levels from the first color to the second.
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
    { id: 'hatch', group: 'grid', title: 'Diamond grid', test: function (x, y) { return ((x + y) & 3) === 0 || ((x - y) & 3) === 0; } }
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

  var api = {
    patterns: PATTERNS, byId: byId, usesPrimary: usesPrimary, DEFAULT_ID: DEFAULT_ID,
    RAMP_LEVELS: RAMP_LEVELS, rampBand: rampBand, rampUsesPrimary: rampUsesPrimary
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

  var settings = { pattern: DEFAULT_ID, mode: 'paint' };
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
    } catch (e) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(PATTERN_KEY, settings.pattern);
      localStorage.setItem(MODE_KEY, settings.mode);
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
      var colors = pskl.app.selectedColorsService;
      var first = colors.getPrimaryColor();
      var second = colors.getSecondaryColor();
      var swap = swapped();
      overlay.clear();
      tool.pixels = [];
      if (col === r.from.col && row === r.from.row) {
        return;
      }
      for (var i = 0; i < r.area.length; i++) {
        var p = r.area[i];
        var primary = rampUsesPrimary(r.from.col, r.from.row, col, row, p.col, p.row, r.o.x, r.o.y) !== swap;
        var color = primary ? first : second;
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
    panel.classList.toggle('dth-ramp', settings.mode === 'ramp');
    var box = panel.querySelector('.dth-note');
    box.innerHTML = '';
    if (settings.mode === 'ramp') {
      box.appendChild(el('div', '', 'Drag from the first color toward the second. Uses the Mix steps.'));
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
      '#dth-panel.dth-ramp .dth-swatches { opacity: .3; pointer-events: none; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function subscribeAll() {
    $.subscribe(Events.TOOL_SELECTED, onToolSelected);
    $.subscribe(Events.PRIMARY_COLOR_SELECTED, syncPanel);
    $.subscribe(Events.SECONDARY_COLOR_SELECTED, syncPanel);
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
