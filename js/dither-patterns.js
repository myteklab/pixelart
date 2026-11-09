/**
 * dither-patterns.js - Patterns for the Dithering tool, and a Fill mode.
 *
 * Stock Piskel dithers one way: a 50% checkerboard of the primary and
 * secondary colors. This adds a swatch strip under the preview while the
 * tool is selected: five mix levels, four kinds of line, two grids. Fill
 * mode paints the pattern into a connected area of one color, like the
 * bucket.
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

  var api = { patterns: PATTERNS, byId: byId, usesPrimary: usesPrimary, DEFAULT_ID: DEFAULT_ID };
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
  // Fill happens once per real press. Transition mode re-presses the tool
  // when a drag crosses into the next tile, and that must not fill again.
  var fillArmed = false;

  function loadSettings() {
    try {
      var p = localStorage.getItem(PATTERN_KEY);
      if (p && byId(p)) {
        settings.pattern = p;
      }
      settings.mode = localStorage.getItem(MODE_KEY) === 'fill' ? 'fill' : 'paint';
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
      if (settings.mode !== 'fill') {
        return penApply.call(this, col, row, frame, overlay, event);
      }
      this.previousCol = col;
      this.previousRow = row;
      if (!fillArmed) {
        return;
      }
      fillArmed = false;
      var pixels = pskl.PixelUtils.getSimilarConnectedPixelsFromFrame(frame, col, row);
      var o = origin();
      for (var i = 0; i < pixels.length; i++) {
        this.draw(colorAt(pixels[i].col, pixels[i].row, o), pixels[i].col, pixels[i].row, frame, overlay);
      }
    };

    proto.moveToolAt = function (col, row, frame, overlay, event) {
      if (settings.mode !== 'fill') {
        return penMove.call(this, col, row, frame, overlay, event);
      }
      this.previousCol = col;
      this.previousRow = row;
    };

    // A press that filled nothing (a drag carried into another tile, a
    // click off the canvas) would otherwise leave an empty undo step.
    proto.releaseToolAt = function (col, row, frame, overlay, event) {
      if (settings.mode === 'fill' && !this.pixels.length) {
        return;
      }
      return penRelease.call(this, col, row, frame, overlay, event);
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

  function drawSwatch(canvas, id) {
    var ctx = canvas.getContext('2d');
    var colors = pskl.app.selectedColorsService;
    var first = colors.getPrimaryColor();
    var second = colors.getSecondaryColor();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var y = 0; y < SWATCH_CELLS; y++) {
      for (var x = 0; x < SWATCH_CELLS; x++) {
        var c = usesPrimary(id, x, y) ? first : second;
        // A see-through color shows as the dark panel behind it.
        ctx.fillStyle = isSeeThrough(c) ? '#1b1b1b' : c;
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
    panel.appendChild(el('div', 'dth-title', 'Dither pattern'));

    var mode = el('div', 'dth-seg');
    [['paint', 'Paint'], ['fill', 'Fill']].forEach(function (m) {
      var b = el('button', '', m[1]);
      b.type = 'button';
      b.setAttribute('data-mode', m[0]);
      mode.appendChild(b);
    });
    panel.appendChild(mode);

    [['mix', 'Mix'], ['lines', 'Lines'], ['grid', 'Grid']].forEach(function (g) {
      panel.appendChild(el('div', 'dth-label', g[1]));
      var row = el('div', 'dth-swatches');
      PATTERNS.filter(function (p) { return p.group === g[0]; }).forEach(function (p) {
        var b = el('button', 'dth-swatch');
        b.type = 'button';
        b.title = p.title;
        b.setAttribute('aria-label', p.title);
        b.setAttribute('data-pattern', p.id);
        var cv = el('canvas');
        cv.width = cv.height = SWATCH_CELLS * SWATCH_SCALE;
        b.appendChild(cv);
        row.appendChild(b);
      });
      panel.appendChild(row);
    });

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

    // After the text panel when it is there, so the two never swap places.
    var after = document.getElementById('txt-panel') || host;
    after.parentNode.insertBefore(panel, after.nextSibling);
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
      drawSwatch(b.firstChild, id);
    });
    var notes = [];
    notes.push(settings.mode === 'fill' ?
      'Click an area to fill it with the pattern.' :
      'Paints your first and second colors in this pattern.');
    notes.push('Right-click swaps the two colors.');
    if (isSeeThrough(pskl.app.selectedColorsService.getSecondaryColor())) {
      notes.push('Your second color is see-through, so the gaps in the pattern will erase.');
    }
    var box = panel.querySelector('.dth-note');
    box.innerHTML = '';
    notes.forEach(function (n, i) {
      box.appendChild(el('div', i === 2 ? 'dth-warn' : '', n));
    });
  }

  function isCurrent() {
    var tc = pskl.app.toolController;
    return !!(tc && tc.currentSelectedTool && tc.currentSelectedTool.toolId === TOOL_ID);
  }

  function onToolSelected() {
    if (panel) {
      panel.style.display = isCurrent() ? '' : 'none';
      syncPanel();
    }
  }

  function injectStyles() {
    if (document.getElementById('dth-styles')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'dth-styles';
    style.textContent = [
      '#dth-panel { margin: 6px 0 0 0; padding: 5px 8px 8px; background: #262626;',
      '  border: 1px solid #3d3d3d; border-radius: 3px; color: #b3b3b3; font-size: 12px; }',
      '#dth-panel .dth-title { font-weight: bold; color: #d3d3d3; margin-bottom: 5px; }',
      '#dth-panel .dth-label { margin: 7px 0 3px; font-size: 10px; letter-spacing: .06em;',
      '  text-transform: uppercase; color: #8a8a8a; }',
      '#dth-panel .dth-seg { display: flex; border: 1px solid #4a4a4a; border-radius: 4px; overflow: hidden; }',
      '#dth-panel .dth-seg button { flex: 1 1 0; min-width: 0; height: 22px; margin: 0; padding: 0 2px;',
      '  font-family: inherit; font-size: 11px; color: #bdbdbd; background: #2e2e2e; border: 0;',
      '  border-left: 1px solid #4a4a4a; cursor: pointer; }',
      '#dth-panel .dth-seg button:first-child { border-left: 0; }',
      '#dth-panel .dth-seg button:hover { color: #fff; background: #3a3a3a; }',
      '#dth-panel .dth-seg button.dth-on { color: #1d1d1d; background: ' + ACCENT + '; font-weight: bold; }',
      '#dth-panel .dth-swatches { display: flex; flex-wrap: wrap; gap: 4px; }',
      '#dth-panel .dth-swatch { width: 30px; height: 30px; margin: 0; padding: 2px; box-sizing: border-box;',
      '  background: #2e2e2e; border: 1px solid #4a4a4a; border-radius: 3px; cursor: pointer; }',
      '#dth-panel .dth-swatch:hover { border-color: #8a8a8a; }',
      '#dth-panel .dth-swatch.dth-on { border: 2px solid ' + ACCENT + '; padding: 1px; }',
      '#dth-panel .dth-swatch canvas { display: block; width: 24px; height: 24px; image-rendering: pixelated; }',
      '#dth-panel .dth-note { margin-top: 7px; font-size: 11px; line-height: 1.4; color: #8a8a8a; }',
      '#dth-panel .dth-note div { margin-top: 2px; }',
      '#dth-panel .dth-warn { color: #c9a53d; }'
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
