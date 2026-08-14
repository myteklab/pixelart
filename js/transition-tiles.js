/**
 * transition-tiles.js - Transition tileset (3x3) support for the frames-as-tiles workflow.
 *
 * When enabled, frames are grouped into BANKS of 9, and each complete bank
 * is a 3x3 transition set (a project can hold several sets):
 *
 *   frame 1  frame 2  frame 3        TL  T  TR
 *   frame 4  frame 5  frame 6   =>   L   C  R      (set 1; frames 10-18
 *   frame 7  frame 8  frame 9        BL  B  BR      are set 2, and so on)
 *
 * Three additions, all render-only (no data model or export changes):
 *  1. Edit in context: in tile mode, the full 3x3 sheet is rendered around
 *     the drawing area in its fixed arrangement, with the tile being edited
 *     live in its own slot, so every seam is visible while drawing.
 *  2. Sheet preview: a clickable 3x3 map of the set for jumping between
 *     tiles, with the edited tile highlighted.
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
    if (on) {
      fitSheet();
    } else {
      lastPos = null;
      // Hand the camera back to piskel in a legal state.
      try { pskl.app.drawingController.setOffset(0, 0); } catch (e) {}
    }
  }

  function controller() {
    return pskl.app && pskl.app.piskelController;
  }

  // Banks: frames [9k, 9k+8] form transition set k. A frame participates
  // only when its whole bank exists; a trailing partial bank keeps stock
  // behavior until it is filled out.
  function bankBase(frameIndex) {
    return Math.floor(frameIndex / 9) * 9;
  }

  function bankComplete(base) {
    var pc = controller();
    return !!pc && pc.getFrameCount() >= base + 9;
  }

  function currentBase() {
    var pc = controller();
    return pc ? bankBase(pc.getCurrentFrameIndex()) : 0;
  }

  function hasFullSet() {
    return bankComplete(currentBase());
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
    if (!pc || index < 0 || index >= pc.getFrameCount()) {
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

  function setHash(base) {
    var pc = controller();
    // Current frame index is part of the hash: the sheet-map highlight
    // depends on it, so switching tiles must trigger a redraw.
    var h = String(base) + '|' + (pc ? pc.getCurrentFrameIndex() : -1) + '|';
    for (var i = base; i < base + 9; i++) {
      h += frameHash(i);
    }
    return h;
  }

  // ── 1. Edit in context: patch the seamless renderer ────────────

  function patchTiledFrames() {
    var FrameRenderer = pskl.rendering.frame.FrameRenderer;
    var original = FrameRenderer.prototype.drawTiledFrames_;

    FrameRenderer.prototype.drawTiledFrames_ = function (context, image, w, h, z) {
      var pc = controller();
      if (!isEnabled() || !pc) {
        return original.call(this, context, image, w, h, z);
      }
      var cur = pc.getCurrentFrameIndex();
      var base = bankBase(cur);
      if (!bankComplete(base)) {
        // Frames of an incomplete bank keep stock behavior (plain tiling),
        // so stray extra tiles work exactly as before the mode existed.
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
        // Companion renderers (tool overlay, layer composites, onion skin)
        // draw no neighbors, but they MUST punch the same wide window: when
        // zoomed out each renderer fills its whole canvas with the opaque
        // background color and only clears one tile around the frame, which
        // would occlude the sheet drawn on the canvas underneath.
        context.clearRect(-4 * w * z, -4 * h * z, 9 * w * z, 9 * h * z);
        return;
      }

      // Draw the WHOLE 3x3 sheet in its fixed arrangement, with the tile
      // being edited live in its own slot. The layout never changes and no
      // tile is ever missing; only which cell is editable moves. Offsets can
      // reach two tiles out (editing a corner), so clear that whole region
      // first: the stock clear only covers one tile around the canvas.
      var col = (cur - base) % 3;
      var row = Math.floor((cur - base) / 3);
      var opacity = pskl.utils.Math.minmax(pskl.UserSettings.get('SEAMLESS_OPACITY'), 0, 1);
      context.clearRect(-4 * w * z, -4 * h * z, 9 * w * z, 9 * h * z);
      context.fillStyle = 'rgba(255, 255, 255, ' + opacity + ')';

      for (var i = 0; i < 9; i++) {
        if (base + i === cur) {
          continue; // the live canvas draws itself
        }
        var dx = (i % 3) - col;
        var dy = Math.floor(i / 3) - row;
        var neighbor = tileCanvas(base + i);
        if (!neighbor) {
          continue;
        }
        context.drawImage(neighbor, dx * w * z, dy * h * z, w * z, h * z);
        context.fillRect(dx * w * z, dy * h * z, w * z, h * z);
      }
    };
  }

  // ── Camera: keep the sheet pinned on screen ────────────────────
  // The whole point of the mode is that all 9 tiles sit in FIXED positions
  // on screen and selecting a frame only changes which cell is live. Piskel
  // keeps the editable canvas wherever the camera puts it, so we drive the
  // camera: fit the sheet on enable, then on every frame switch shift the
  // offset by exactly the tile delta so the sheet does not move at all.

  var lastPos = null; // sheet position of the previously edited tile

  function cameraActive() {
    var pc = controller();
    return isEnabled() && !!pc && bankComplete(currentBase());
  }

  function patchOffsetClamp() {
    var FrameRenderer = pskl.rendering.frame.FrameRenderer;
    var original = FrameRenderer.prototype.setOffset;
    FrameRenderer.prototype.setOffset = function (x, y) {
      if (!cameraActive()) {
        return original.call(this, x, y);
      }
      // The sheet extends up to two tiles beyond the frame; the stock clamp
      // pins offsets to the frame itself and would forbid showing it. Allow
      // the camera anywhere that keeps the sheet within reach of the
      // viewport (viewport size in sprite pixels = display / zoom).
      var pc = controller();
      var w = pc.getWidth();
      var h = pc.getHeight();
      var vw = this.displayWidth / this.zoom;
      var vh = this.displayHeight / this.zoom;
      this.offset.x = pskl.utils.Math.minmax(x, -(2 * w + vw), 3 * w + vw);
      this.offset.y = pskl.utils.Math.minmax(y, -(2 * h + vh), 3 * h + vh);
    };
  }

  function drawingContainerRect() {
    var el = document.getElementById('drawing-canvas-container');
    return el ? el.getBoundingClientRect() : null;
  }

  function fitSheet() {
    var pc = controller();
    var dc = pskl.app.drawingController;
    var rect = drawingContainerRect();
    if (!cameraActive() || !dc || !rect || !rect.width) {
      return;
    }
    var w = pc.getWidth();
    var h = pc.getHeight();
    // 3 tiles plus breathing room on each side. Zoom the WHOLE renderer
    // stack (composite), never a single canvas, or margins diverge and the
    // stacked canvases stop lining up.
    var zoom = Math.max(1, Math.min(rect.width / (w * 3.4), rect.height / (h * 3.4)));
    if (dc.setZoom_) {
      dc.setZoom_(zoom);
    } else {
      dc.compositeRenderer.setZoom(zoom);
    }
    centerSheet();
  }

  function centerSheet() {
    var pc = controller();
    var dc = pskl.app.drawingController;
    var rect = drawingContainerRect();
    if (!cameraActive() || !dc || !rect || !rect.width) {
      return;
    }
    var w = pc.getWidth();
    var h = pc.getHeight();
    var rel = pc.getCurrentFrameIndex() - currentBase();
    var col = rel % 3;
    var row = Math.floor(rel / 3);
    // Piskel centers the FRAME on screen when offset is 0 (margin term), so
    // centering the SHEET reduces to: offset = sheetCenter - frameCenter,
    // which is ((1-col)*w, (1-row)*h). Independent of zoom and viewport.
    dc.setOffset((1 - col) * w, (1 - row) * h);
    lastPos = { col: col, row: row };
  }

  function trackFrameChange() {
    if (!cameraActive()) {
      lastPos = null;
      return;
    }
    var pc = controller();
    var rel = pc.getCurrentFrameIndex() - currentBase();
    var col = rel % 3;
    var row = Math.floor(rel / 3);
    if (lastPos && lastPos.col === col && lastPos.row === row) {
      return;
    }
    // Re-center the sheet at the current zoom on every tile switch. The
    // sheet lands in the identical screen position each time, so only the
    // live cell appears to change. Centering (rather than delta-shifting)
    // is drift-proof: no dependence on the previous camera state.
    centerSheet();
  }

  // ── 2. Sheet preview panel (the clickable 3x3 map) ─────────────

  var panel = null;
  var sheetCanvas = null;
  var lastRenderHash = '';

  function renderSheet(force) {
    if (!panel || panel.style.display === 'none') {
      return;
    }
    var pc = controller();
    var hint = panel.querySelector('.tt-hint');
    var body = panel.querySelector('.tt-body');
    var base = pc ? currentBase() : 0;
    if (!pc || !hasFullSet()) {
      hint.style.display = 'block';
      body.style.display = 'none';
      var have = pc ? Math.min(9, pc.getFrameCount() - base) : 0;
      hint.querySelector('.tt-hint-count').textContent = have;
      return;
    }
    hint.style.display = 'none';
    body.style.display = 'block';
    panel.querySelector('.tt-title').textContent =
      'Transition preview' + (base > 0 ? ' (set ' + (base / 9 + 1) + ')' : '');

    var hash = setHash(base);
    if (!force && hash === lastRenderHash) {
      return;
    }
    lastRenderHash = hash;

    var tw = pc.getCurrentFrame().getWidth();
    var th = pc.getCurrentFrame().getHeight();

    // Sheet map: the raw 3x3, clickable.
    sheetCanvas.width = 3 * tw;
    sheetCanvas.height = 3 * th;
    var sctx = sheetCanvas.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    sctx.clearRect(0, 0, sheetCanvas.width, sheetCanvas.height);
    for (var i = 0; i < 9; i++) {
      var t = tileCanvas(base + i);
      if (t) {
        sctx.drawImage(t, (i % 3) * tw, Math.floor(i / 3) * th, tw, th);
      }
    }
    // Cell grid, then highlight the tile being edited.
    sctx.strokeStyle = 'rgba(255,255,255,.22)';
    sctx.lineWidth = 1;
    for (var sg = 0; sg <= 3; sg++) {
      sctx.beginPath();
      sctx.moveTo(sg * tw + 0.5, 0);
      sctx.lineTo(sg * tw + 0.5, sheetCanvas.height);
      sctx.stroke();
      sctx.beginPath();
      sctx.moveTo(0, sg * th + 0.5);
      sctx.lineTo(sheetCanvas.width, sg * th + 0.5);
      sctx.stroke();
    }
    var rel = pc.getCurrentFrameIndex() - base;
    if (rel >= 0 && rel <= 8) {
      sctx.strokeStyle = '#ffd93d';
      sctx.lineWidth = Math.max(1, Math.round(tw / 16));
      sctx.strokeRect((rel % 3) * tw + 0.5, Math.floor(rel / 3) * th + 0.5, tw - 1, th - 1);
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
      '<div class="tt-title-row"><span class="tt-title">Transition preview</span></div>' +
      '<div class="tt-hint" style="display:none">This set needs 9 frames (it has <span class="tt-hint-count">0</span>). ' +
      'Each frame is one tile of the 3x3 set. <button type="button" class="tt-make-frames button">Add frames to finish this set</button></div>' +
      '<div class="tt-body">' +
      '  <canvas class="tt-sheet" title="Click a tile to edit it"></canvas>' +
      '</div>';
    host.parentNode.insertBefore(panel, host.nextSibling);

    sheetCanvas = panel.querySelector('.tt-sheet');

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
      pc.setCurrentFrameIndex(currentBase() + r * 3 + c);
    });

    panel.querySelector('.tt-make-frames').addEventListener('click', function () {
      var pc = controller();
      if (!pc) {
        return;
      }
      var base = currentBase();
      while (pc.getFrameCount() < base + 9) {
        pc.addFrame();
      }
      pc.setCurrentFrameIndex(base);
      renderSheet(true);
      badgeFrameList();
      fitSheet();
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
      if (isEnabled() && bankComplete(bankBase(i))) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'tt-badge';
          tiles[i].appendChild(badge);
        }
        var setNo = Math.floor(i / 9) + 1;
        badge.textContent = LABELS[i % 9] + (setNo > 1 ? setNo : '');
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
      '<div class="preferences-hint">Transition sets</div>' +
      '<label class="preferences-checkbox-label">' +
      '  <input type="checkbox" class="tt-enable-checkbox"> Group frames into 3x3 transition tilesets' +
      '</label>' +
      '<div class="preferences-description">Every 9 frames form one set (frames 1-9, 10-18, and so on). ' +
      'Shows the whole set around the canvas while you draw, adds a set preview, and labels each tile. ' +
      'Turns on tile mode.</div>';
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
      '#tt-panel { margin: 6px 0 0 0; padding: 5px 8px 7px; background: #262626;',
      '  border: 1px solid #3d3d3d; border-radius: 3px; color: #b3b3b3; font-size: 12px; }',
      '#tt-panel .tt-title-row { display: flex; justify-content: space-between;',
      '  align-items: center; margin-bottom: 4px; }',
      '#tt-panel .tt-title { font-weight: bold; color: #d3d3d3; white-space: nowrap;',
      '  overflow: hidden; text-overflow: ellipsis; margin-right: 6px; }',
      '#tt-panel .tt-size { white-space: nowrap; flex-shrink: 0; }',
      '#tt-panel .tt-size input { width: 30px; background: #333; color: #ddd;',
      '  border: 1px solid #555; border-radius: 2px; padding: 0 2px; }',
      '#tt-panel .tt-sheet { display: block; margin: 0 auto; max-width: 100%;',
      '  max-height: 160px; image-rendering: pixelated; cursor: pointer;',
      '  background-image: conic-gradient(#3a3a3a 25%, #2c2c2c 0 50%, #3a3a3a 0 75%, #2c2c2c 0);',
      '  background-size: 12px 12px; border: 1px solid #3d3d3d; }',
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
        renderSheet(true);
      }
    }
    // The panel REPLACES the animated preview while the mode is on: an
    // animation preview is meaningless flicker for a tileset project, and
    // stacking both overflows the right column.
    var ap = document.getElementById('animated-preview-container');
    if (ap) {
      ap.style.display = isEnabled() ? 'none' : '';
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
        trackFrameChange();
        renderSheet(false);
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
      var ap = document.getElementById('animated-preview-container');
      if (ap) {
        ap.style.display = isEnabled() ? 'none' : '';
      }
      badgeFrameList();
      if (!isEnabled()) {
        return;
      }
      trackFrameChange();
      renderSheet(false);
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
      patchOffsetClamp();
      buildPanel();
      subscribeAll();
      syncUi();
      // Booting straight into an existing 9-tile project: start in sheet view.
      setTimeout(fitSheet, 600);
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
