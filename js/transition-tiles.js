/**
 * transition-tiles.js - Transition tileset (3x3) support for the frames-as-tiles workflow.
 *
 * When enabled, frames 1-9 are treated as a 3x3 transition set:
 *
 *   frame 1  frame 2  frame 3        TL  T  TR
 *   frame 4  frame 5  frame 6   =>   L   C  R
 *   frame 7  frame 8  frame 9        BL  B  BR
 *
 * Three additions, all render-only (no data model or export changes):
 *  1. Edit in context: in tile mode, the 8 canvases around the drawing area
 *     show the NEIGHBORING TILES from the sheet instead of copies of the
 *     current frame, so seams are visible while drawing.
 *  2. Island preview: a panel that assembles an N x M rectangle island from
 *     the 9 tiles (corners, repeated edges, filled center), plus a clickable
 *     3x3 sheet map for jumping between tiles.
 *  3. Frame badges: TL/T/TR/... labels on the frame list so tile identity
 *     survives visually even though it is carried by frame order.
 *
 * The existing tileset workflow (each frame is a tile, spritesheet export
 * builds the tileset image) is untouched. With 9 frames and 3 columns the
 * stock export already produces the standard 3x3 transition sheet.
 *
 * Follows the perfect-pixel-import.js add-on pattern: poll for pskl, patch
 * prototypes, inject DOM. Nothing in the packaged Piskel bundle is edited.
 */
(function () {
  'use strict';

  var POLL_INTERVAL = 200;
  var MAX_POLLS = 100;
  var pollCount = 0;

  var STORAGE_KEY = 'pixelart-transition-tiles';
  var LABELS = ['TL', 'T', 'TR', 'L', 'C', 'R', 'BL', 'B', 'BR'];

  // Island preview dimensions in tiles (user adjustable).
  var islandW = 5;
  var islandH = 4;

  var exportPrefilled = false;

  function isEnabled() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
  }

  function setEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) {}
    if (on) {
      // Context drawing rides on tile mode, so switch it on too.
      pskl.UserSettings.set(pskl.UserSettings.SEAMLESS_MODE, true);
    }
    syncUi();
    $.publish(Events.PISKEL_RESET);
  }

  function controller() {
    return pskl.app && pskl.app.piskelController;
  }

  function hasFullSet() {
    var pc = controller();
    return !!pc && pc.getFrameCount() >= 9;
  }

  // ── Frame render cache ─────────────────────────────────────────
  // renderFrameAt merges layers; cache per tile keyed by the layer frame
  // hashes so repeated renders during a drag stay cheap.

  var cache = {};

  function frameHash(index) {
    var pc = controller();
    var layers = pc.getLayers();
    var h = '';
    for (var i = 0; i < layers.length; i++) {
      var f = layers[i].getFrameAt(index);
      h += (f ? f.getHash() : 'x') + '-';
    }
    return h;
  }

  function tileCanvas(index) {
    var pc = controller();
    if (!pc || index < 0 || index > 8 || index >= pc.getFrameCount()) {
      return null;
    }
    var hash = frameHash(index);
    var entry = cache[index];
    if (!entry || entry.hash !== hash) {
      entry = { hash: hash, canvas: pc.renderFrameAt(index, true) };
      cache[index] = entry;
    }
    return entry.canvas;
  }

  function setHash() {
    var h = '';
    for (var i = 0; i < 9; i++) {
      h += frameHash(i);
    }
    return h + '|' + islandW + 'x' + islandH;
  }

  // ── 1. Edit in context: patch the seamless renderer ────────────

  function patchTiledFrames() {
    var FrameRenderer = pskl.rendering.frame.FrameRenderer;
    var original = FrameRenderer.prototype.drawTiledFrames_;

    FrameRenderer.prototype.drawTiledFrames_ = function (context, image, w, h, z) {
      var pc = controller();
      if (!isEnabled() || !pc || pc.getFrameCount() < 9) {
        return original.call(this, context, image, w, h, z);
      }
      var cur = pc.getCurrentFrameIndex();
      if (cur > 8) {
        // Frames beyond the transition set keep stock behavior (plain tiling),
        // so extra tiles (variants, decorations) work exactly as before.
        return original.call(this, context, image, w, h, z);
      }

      // The drawing area is a STACK of FrameRenderers (frame, tool overlay,
      // layers above/below, onion skin) and each one calls this method in
      // seamless mode. Neighbors are full merged-layer renders, so exactly
      // one canvas may draw them: the main frame canvas. The others draw
      // nothing, otherwise a stale overlay (it only re-renders on mouse
      // activity) leaves the previous tile's neighbors painted on top.
      var cls = (this && this.displayCanvas && this.displayCanvas.className) || '';
      if (cls.indexOf('drawing-canvas') === -1) {
        return;
      }

      var col = cur % 3;
      var row = Math.floor(cur / 3);
      var opacity = pskl.utils.Math.minmax(pskl.UserSettings.get('SEAMLESS_OPACITY'), 0, 1);
      context.fillStyle = 'rgba(255, 255, 255, ' + opacity + ')';

      [[0, -1], [0, 1], [-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]].forEach(function (d) {
        var cc = col + d[0];
        var rr = row + d[1];
        if (cc < 0 || cc > 2 || rr < 0 || rr > 2) {
          // Outside the 3x3 sheet = outside the island. Leave it empty.
          return;
        }
        var neighbor = tileCanvas(rr * 3 + cc);
        if (!neighbor) {
          return;
        }
        context.drawImage(neighbor, d[0] * w * z, d[1] * h * z, w * z, h * z);
        context.fillRect(d[0] * w * z, d[1] * h * z, w * z, h * z);
      });
    };
  }

  // ── 2. Island preview panel ────────────────────────────────────

  var panel = null;
  var islandCanvas = null;
  var sheetCanvas = null;
  var lastRenderHash = '';

  function tileIndexForCell(x, y, w, h) {
    var c = x === 0 ? 0 : (x === w - 1 ? 2 : 1);
    var r = y === 0 ? 0 : (y === h - 1 ? 2 : 1);
    return r * 3 + c;
  }

  function renderIsland(force) {
    if (!panel || panel.style.display === 'none') {
      return;
    }
    var pc = controller();
    var hint = panel.querySelector('.tt-hint');
    var body = panel.querySelector('.tt-body');
    if (!pc || !hasFullSet()) {
      hint.style.display = 'block';
      body.style.display = 'none';
      hint.querySelector('.tt-hint-count').textContent = pc ? pc.getFrameCount() : 0;
      return;
    }
    hint.style.display = 'none';
    body.style.display = 'block';

    var hash = setHash();
    if (!force && hash === lastRenderHash) {
      return;
    }
    lastRenderHash = hash;

    var tw = pc.getCurrentFrame().getWidth();
    var th = pc.getCurrentFrame().getHeight();

    // Island: corners at corners, edges repeated along runs, center filling.
    islandCanvas.width = islandW * tw;
    islandCanvas.height = islandH * th;
    var ctx = islandCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, islandCanvas.width, islandCanvas.height);
    for (var y = 0; y < islandH; y++) {
      for (var x = 0; x < islandW; x++) {
        var tile = tileCanvas(tileIndexForCell(x, y, islandW, islandH));
        if (tile) {
          ctx.drawImage(tile, x * tw, y * th, tw, th);
        }
      }
    }

    // Sheet map: the raw 3x3, clickable.
    sheetCanvas.width = 3 * tw;
    sheetCanvas.height = 3 * th;
    var sctx = sheetCanvas.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    sctx.clearRect(0, 0, sheetCanvas.width, sheetCanvas.height);
    for (var i = 0; i < 9; i++) {
      var t = tileCanvas(i);
      if (t) {
        sctx.drawImage(t, (i % 3) * tw, Math.floor(i / 3) * th, tw, th);
      }
    }
    // Highlight the tile being edited.
    var cur = pc.getCurrentFrameIndex();
    if (cur <= 8) {
      sctx.strokeStyle = '#ffd93d';
      sctx.lineWidth = Math.max(1, Math.round(tw / 16));
      sctx.strokeRect((cur % 3) * tw + 0.5, Math.floor(cur / 3) * th + 0.5, tw - 1, th - 1);
    }
  }

  function buildPanel() {
    var host = document.getElementById('animated-preview-container');
    if (!host || document.getElementById('tt-panel')) {
      return;
    }
    panel = document.createElement('div');
    panel.id = 'tt-panel';
    panel.innerHTML =
      '<div class="tt-title">Transition preview</div>' +
      '<div class="tt-hint" style="display:none">Needs 9 frames (you have <span class="tt-hint-count">0</span>). ' +
      'Each frame is one tile of the 3x3 set. <button type="button" class="tt-make-frames button">Add frames up to 9</button></div>' +
      '<div class="tt-body">' +
      '  <canvas class="tt-island"></canvas>' +
      '  <div class="tt-controls">' +
      '    <label>Island <input type="number" class="tt-w" min="3" max="12" step="1"> x ' +
      '    <input type="number" class="tt-h" min="3" max="12" step="1"> tiles</label>' +
      '  </div>' +
      '  <div class="tt-sheet-row"><canvas class="tt-sheet" title="Click a tile to edit it"></canvas>' +
      '  <span class="tt-sheet-caption">the 9 tiles<br>(click to edit)</span></div>' +
      '</div>';
    host.parentNode.insertBefore(panel, host.nextSibling);

    islandCanvas = panel.querySelector('.tt-island');
    sheetCanvas = panel.querySelector('.tt-sheet');

    var wInput = panel.querySelector('.tt-w');
    var hInput = panel.querySelector('.tt-h');
    wInput.value = islandW;
    hInput.value = islandH;
    wInput.addEventListener('change', function () {
      islandW = pskl.utils.Math.minmax(parseInt(wInput.value, 10) || 5, 3, 12);
      wInput.value = islandW;
      renderIsland(true);
    });
    hInput.addEventListener('change', function () {
      islandH = pskl.utils.Math.minmax(parseInt(hInput.value, 10) || 4, 3, 12);
      hInput.value = islandH;
      renderIsland(true);
    });

    sheetCanvas.addEventListener('click', function (evt) {
      var pc = controller();
      if (!pc || !hasFullSet()) {
        return;
      }
      var rect = sheetCanvas.getBoundingClientRect();
      var c = Math.floor((evt.clientX - rect.left) / (rect.width / 3));
      var r = Math.floor((evt.clientY - rect.top) / (rect.height / 3));
      c = pskl.utils.Math.minmax(c, 0, 2);
      r = pskl.utils.Math.minmax(r, 0, 2);
      pc.setCurrentFrameIndex(r * 3 + c);
    });

    panel.querySelector('.tt-make-frames').addEventListener('click', function () {
      var pc = controller();
      if (!pc) {
        return;
      }
      while (pc.getFrameCount() < 9) {
        pc.addFrame();
      }
      pc.setCurrentFrameIndex(0);
      renderIsland(true);
      badgeFrameList();
    });

    syncUi();
  }

  // ── 3. Frame badges ────────────────────────────────────────────

  function badgeFrameList() {
    var list = document.getElementById('preview-list');
    if (!list) {
      return;
    }
    var tiles = list.querySelectorAll('.preview-tile');
    for (var i = 0; i < tiles.length; i++) {
      var badge = tiles[i].querySelector('.tt-badge');
      if (isEnabled() && i < 9) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'tt-badge';
          tiles[i].appendChild(badge);
        }
        badge.textContent = LABELS[i];
      } else if (badge) {
        badge.parentNode.removeChild(badge);
      }
    }
  }

  // ── Settings UI (injected into the Tile mode preferences tab) ──

  function injectSettings(tilePanel) {
    if (tilePanel.querySelector('.tt-settings')) {
      return;
    }
    var div = document.createElement('div');
    div.className = 'tt-settings';
    div.innerHTML =
      '<div class="preferences-hint">Transition set</div>' +
      '<label class="preferences-checkbox-label">' +
      '  <input type="checkbox" class="tt-enable-checkbox"> Frames 1-9 form a 3x3 transition tileset' +
      '</label>' +
      '<div class="preferences-description">Shows neighboring tiles around the canvas while you draw, ' +
      'adds an island preview, and labels the first 9 frames. Turns on tile mode.</div>';
    tilePanel.appendChild(div);
    var box = div.querySelector('.tt-enable-checkbox');
    box.checked = isEnabled();
    box.addEventListener('change', function () {
      setEnabled(box.checked);
    });
  }

  // ── Export convenience: prefill 3 columns once per session ─────

  function maybePrefillExport() {
    if (exportPrefilled || !isEnabled() || !hasFullSet()) {
      return;
    }
    var input = document.getElementById('png-export-columns');
    if (!input) {
      return;
    }
    exportPrefilled = true;
    input.value = 3;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Styles ─────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('tt-styles')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'tt-styles';
    style.textContent = [
      '#tt-panel { margin: 6px 0 0 0; padding: 6px 8px; background: #262626;',
      '  border: 1px solid #3d3d3d; border-radius: 3px; color: #b3b3b3; font-size: 12px; }',
      '#tt-panel .tt-title { font-weight: bold; margin-bottom: 5px; color: #d3d3d3; }',
      '#tt-panel .tt-island { display: block; width: 100%; image-rendering: pixelated;',
      '  background-image: conic-gradient(#3a3a3a 25%, #2c2c2c 0 50%, #3a3a3a 0 75%, #2c2c2c 0);',
      '  background-size: 12px 12px; border: 1px solid #3d3d3d; }',
      '#tt-panel .tt-controls { margin: 5px 0; }',
      '#tt-panel .tt-controls input { width: 38px; background: #333; color: #ddd;',
      '  border: 1px solid #555; border-radius: 2px; padding: 1px 3px; }',
      '#tt-panel .tt-sheet-row { display: flex; align-items: center; gap: 8px; }',
      '#tt-panel .tt-sheet { width: 60%; image-rendering: pixelated; cursor: pointer;',
      '  border: 1px solid #3d3d3d; }',
      '#tt-panel .tt-sheet-caption { font-size: 10px; color: #888; }',
      '#tt-panel .tt-hint { color: #c9a53d; }',
      '#tt-panel .tt-make-frames { margin-top: 4px; font-size: 11px; }',
      '.preview-tile { position: relative; }',
      '.tt-badge { position: absolute; bottom: 2px; left: 2px; background: rgba(0,0,0,.7);',
      '  color: #ffd93d; font-size: 9px; font-weight: bold; padding: 0 3px; border-radius: 2px;',
      '  pointer-events: none; z-index: 5; }',
      '.tt-settings { margin-top: 12px; }',
      '.tt-settings .preferences-description { font-size: 11px; color: #888; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function syncUi() {
    if (panel) {
      panel.style.display = isEnabled() ? 'block' : 'none';
      if (isEnabled()) {
        renderIsland(true);
      }
    }
    badgeFrameList();
  }

  // ── Wiring ─────────────────────────────────────────────────────

  function subscribeAll() {
    [Events.PISKEL_RESET, Events.TOOL_RELEASED, Events.FRAME_SIZE_CHANGED].forEach(function (ev) {
      $.subscribe(ev, function () {
        if (!isEnabled()) {
          return;
        }
        renderIsland(false);
        badgeFrameList();
      });
    });
    // Fallback sweep: catches frame add/delete/reorder, settings panels
    // appearing, and external enable/disable changes, without chasing every
    // internal event. Badges and panel visibility self-clean when disabled.
    setInterval(function () {
      var tilePanel = document.querySelector('.preferences-panel-tile');
      if (tilePanel) {
        injectSettings(tilePanel);
      }
      if (panel) {
        panel.style.display = isEnabled() ? 'block' : 'none';
      }
      badgeFrameList();
      if (!isEnabled()) {
        return;
      }
      renderIsland(false);
      maybePrefillExport();
    }, 700);
  }

  function waitForPiskel() {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      console.error('[TransitionTiles] Piskel engine not found, transition tiles disabled');
      return;
    }
    var ready = window.pskl && window.$ && window.Events && pskl.app &&
      pskl.app.piskelController && pskl.rendering && pskl.rendering.frame &&
      pskl.rendering.frame.FrameRenderer && pskl.UserSettings && pskl.utils &&
      pskl.utils.Math && document.getElementById('animated-preview-container');
    if (ready) {
      injectStyles();
      patchTiledFrames();
      buildPanel();
      subscribeAll();
      syncUi();
    } else {
      setTimeout(waitForPiskel, POLL_INTERVAL);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForPiskel);
  } else {
    waitForPiskel();
  }
})();
