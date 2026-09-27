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
 * What it adds (no data model or export changes):
 *  1. Edit in context: in tile mode, the full 3x3 sheet is rendered around
 *     the drawing area in its fixed arrangement, with the tile being edited
 *     live in its own slot, so every seam is visible while drawing. Pressing
 *     on any tile makes it the live one, so the whole sheet is drawable.
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
      markNotAnimation();
    }
    syncUi();
    dropOutline();
    $.publish(Events.PISKEL_RESET);
    if (on) {
      fitSheet();
    } else {
      lastPos = null;
      wasActive = false;
      // Hand the camera back to piskel in a legal state.
      try { pskl.app.drawingController.setOffset(0, 0); } catch (e) {}
    }
  }

  // The tool overlay is cached on zoom, offset and its own pixels. Editing
  // the center tile has offset 0,0, the same as stock, so leaving the mode
  // from there would keep the outline on screen until the mouse moved.
  function dropOutline() {
    try { pskl.app.drawingController.overlayRenderer.serializedFrame = null; } catch (e) {}
  }

  function controller() {
    return pskl.app && pskl.app.piskelController;
  }

  // Platform convention: FPS 0 means "this is a tileset, not an animation".
  // Previews (project card and share page) render the frames as a contact
  // sheet instead of animating when FPS is 0. Tileset intent is explicit
  // here, so set it on the kid's behalf.
  function markNotAnimation() {
    var pc = controller();
    if (pc && pc.getFPS() > 0) {
      pc.setFPS(0);
    }
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

  // Backdrop everywhere except the sheet. Piskel has already cleared one
  // tile around the frame, which overshoots the sheet whenever the live tile
  // is on an edge, and with no wash on the tiles the backdrop is the only
  // thing that shows where the sheet ends.
  function clearSheet(context, rel, tw, th) {
    context.fillStyle = Constants.ZOOMED_OUT_BACKGROUND_COLOR;
    context.fillRect(-4 * tw, -4 * th, 9 * tw, 9 * th);
    context.clearRect(-(rel % 3) * tw, -Math.floor(rel / 3) * th, 3 * tw, 3 * th);
  }

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
        clearSheet(context, cur - base, w * z, h * z);
        return;
      }

      // Draw the WHOLE 3x3 sheet in its fixed arrangement, with the tile
      // being edited live in its own slot. The layout never changes and no
      // tile is ever missing; only which cell is editable moves. Offsets can
      // reach two tiles out (editing a corner), so clear that whole region
      // first: the stock clear only covers one tile around the canvas.
      var col = (cur - base) % 3;
      var row = Math.floor((cur - base) / 3);
      clearSheet(context, cur - base, w * z, h * z);

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
        // No tile mode wash here. Every tile is drawable, and a wash makes
        // one color read as two on either side of a seam.
        context.drawImage(neighbor, dx * w * z, dy * h * z, w * z, h * z);
      }
    };
  }

  // Piskel draws the pixel grid over the current frame only, so with the
  // frame following the pointer the grid jumped from tile to tile. Run it
  // over the whole sheet instead, and mark the live tile with an outline.
  function patchSheetDecor() {
    var FrameRenderer = pskl.rendering.frame.FrameRenderer;
    var original = FrameRenderer.prototype.renderFrame_;

    FrameRenderer.prototype.renderFrame_ = function (frame) {
      original.call(this, frame);
      var cls = (this.displayCanvas && this.displayCanvas.className) || '';
      // Grid goes where the tiles are drawn. The outline goes on the tool
      // overlay, the top canvas of the stack: every canvas paints backdrop
      // outside the sheet, which would bury an outline on a lower one
      // wherever the live tile sits on the edge of the sheet.
      var drawsGrid = cls.indexOf('drawing-canvas') !== -1;
      var drawsOutline = cls.indexOf('canvas-overlay') !== -1;
      if ((!drawsGrid && !drawsOutline) || !cameraActive() ||
          !pskl.UserSettings.get('SEAMLESS_MODE')) {
        return;
      }
      var pc = controller();
      var rel = pc.getCurrentFrameIndex() - currentBase();
      var col = rel % 3;
      var row = Math.floor(rel / 3);
      var z = this.zoom;
      var tw = frame.getWidth() * z;
      var th = frame.getHeight() * z;

      var ctx = this.displayCanvas.getContext('2d');
      ctx.save();
      // Origin at the top-left corner of the SHEET, in screen pixels.
      ctx.translate(this.margin.x - this.offset.x * z - col * tw,
        this.margin.y - this.offset.y * z - row * th);

      var gridWidth = drawsGrid ? this.computeGridWidthForDisplay_() : 0;
      if (gridWidth > 0) {
        var spacing = this.getGridSpacing();
        var color = this.getGridColor();
        var line;
        if (color === Constants.TRANSPARENT_COLOR) {
          line = ctx.clearRect.bind(ctx);
        } else {
          ctx.fillStyle = color;
          line = ctx.fillRect.bind(ctx);
        }
        for (var c = 0; c < 3; c++) {
          for (var r = 0; r < 3; r++) {
            if (c === col && r === row) {
              continue; // piskel already drew this one
            }
            for (var i = 1; i < frame.getWidth(); i++) {
              if (i % spacing === 0) {
                line(c * tw + i * z - gridWidth / 2, r * th, gridWidth, th);
              }
            }
            for (var j = 1; j < frame.getHeight(); j++) {
              if (j % spacing === 0) {
                line(c * tw, r * th + j * z - gridWidth / 2, tw, gridWidth);
              }
            }
          }
        }
        // The seams are grid lines too. Stock piskel never needs them
        // because a lone frame has nothing on the other side of its edge.
        for (var k = 1; k < 3; k++) {
          line(k * tw - gridWidth / 2, 0, gridWidth, 3 * th);
          line(0, k * th - gridWidth / 2, 3 * tw, gridWidth);
        }
      }

      // Sits in the pixel row just outside the tile, so it never covers art
      // on the tile being drawn.
      if (drawsOutline) {
        ctx.strokeStyle = '#ffd93d';
        ctx.lineWidth = 1;
        ctx.strokeRect(col * tw - 0.5, row * th - 0.5, tw + 1, th + 1);
      }
      ctx.restore();
    };
  }

  // ── Camera: keep the sheet pinned on screen ────────────────────
  // The whole point of the mode is that all 9 tiles sit in FIXED positions
  // on screen and selecting a frame only changes which cell is live. Piskel
  // keeps the editable canvas wherever the camera puts it, so we drive the
  // camera: fit the sheet when the mode becomes active, then re-center on
  // every frame switch so the sheet lands in the identical screen rect.

  var lastPos = null;     // sheet position of the previously edited tile
  var wasActive = false;  // detects activation edges (project load, undo, etc.)

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
    var active = cameraActive();
    if (!active) {
      lastPos = null;
      if (wasActive) {
        // Mode just deactivated (undo below 9 frames, or the kid selected a
        // frame in an incomplete bank): hand the camera back in a legal
        // state instead of leaving a sheet-view offset behind.
        wasActive = false;
        dropOutline();
        try { pskl.app.drawingController.setOffset(0, 0); } catch (e) {}
      }
      return;
    }
    if (!wasActive) {
      // Mode just became active. This is how the sheet view engages when a
      // saved project finishes loading (the platform adapter sets the
      // piskel asynchronously, well after boot), when a set gets its 9th
      // frame, or after a redo.
      wasActive = true;
      fitSheet();
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

  // ── Paint anywhere on the sheet ────────────────────────────────
  // Piskel tools only ever write to the current frame, and out-of-bounds
  // pixels are silently dropped. Rather than teach every tool about a 3x3
  // surface, the current frame follows the pointer: pressing on a tile
  // makes that tile current before the tool sees the event. The camera
  // re-centers on the switch, so nothing moves on screen and the tool gets
  // ordinary in-frame coordinates.

  // Frame index of the sheet cell under a sprite coordinate (coordinates are
  // relative to the current tile, so they go negative up and to the left).
  // -1 when the point is off the sheet.
  function cellAt(coords) {
    var pc = controller();
    var rel = pc.getCurrentFrameIndex() - currentBase();
    var col = (rel % 3) + Math.floor(coords.x / pc.getWidth());
    var row = Math.floor(rel / 3) + Math.floor(coords.y / pc.getHeight());
    if (col < 0 || col > 2 || row < 0 || row > 2) {
      return -1;
    }
    return currentBase() + row * 3 + col;
  }

  function makeLive(dc, index) {
    dc.overlayFrame.clear();
    touched(controller().getCurrentFrameIndex());
    controller().setCurrentFrameIndex(index);
    centerSheet();
  }

  function followPointer(clientX, clientY) {
    var dc = pskl.app.drawingController;
    if (!cameraActive() || !dc) {
      return;
    }
    hideHover();
    var target = cellAt(dc.getSpriteCoordinates(clientX, clientY));
    if (target !== -1 && target !== controller().getCurrentFrameIndex()) {
      makeLive(dc, target);
    }
  }

  // Pen-family strokes (pen, eraser, mirror pen, lighten, dithering) carry
  // across seams. The stroke is committed to the tile it is leaving and
  // reopened on the tile it enters, so one drag can run TL -> T -> TR.
  // Each tile's part is its own undo step: piskel history replays an action
  // against a single frame, and a stroke spanning tiles cannot be one.
  function carryStroke(dc, coords, event) {
    var pc = controller();
    var tool = dc.currentToolBehavior;
    var w = pc.getWidth();
    var h = pc.getHeight();
    var rel = pc.getCurrentFrameIndex() - currentBase();
    var liveCol = rel % 3;
    var liveRow = Math.floor(rel / 3);
    var base = currentBase();

    var fromCol = tool.previousCol === null ? coords.x : tool.previousCol;
    var fromRow = tool.previousRow === null ? coords.y : tool.previousRow;
    var line = pskl.PixelUtils.getLinePixels(fromCol, coords.x, fromRow, coords.y);

    // Sheet space keeps the walk independent of which tile is live.
    var originX = liveCol * w;
    var originY = liveRow * h;
    for (var i = 0; i < line.length; i++) {
      var sx = originX + line[i].col;
      var sy = originY + line[i].row;
      var col = Math.floor(sx / w);
      var row = Math.floor(sy / h);
      if (col < 0 || col > 2 || row < 0 || row > 2) {
        continue;
      }
      if (col !== liveCol || row !== liveRow) {
        tool.releaseToolAt(tool.previousCol, tool.previousRow, pc.getCurrentFrame(), dc.overlayFrame, event);
        $.publish(Events.TOOL_RELEASED);
        makeLive(dc, base + row * 3 + col);
        $.publish(Events.TOOL_PRESSED);
        liveCol = col;
        liveRow = row;
      }
      tool.applyToolAt(sx - col * w, sy - row * h, pc.getCurrentFrame(), dc.overlayFrame, event);
    }
    // The pointer may have ended off the sheet. Keep its true position so
    // the next move interpolates from there, not from the last painted pixel.
    tool.previousCol = originX + coords.x - liveCol * w;
    tool.previousRow = originY + coords.y - liveRow * h;
  }

  // Tiles are now left within milliseconds of being painted. Anything that
  // polls only the current frame (live collaboration does) would miss those
  // pixels, so say which tile was just left.
  function touched(index) {
    try {
      window.dispatchEvent(new CustomEvent('pixelart:frame-touched', { detail: { frame: index } }));
    } catch (e) {}
  }

  var hoverEl = null;

  function hideHover() {
    if (hoverEl) {
      hoverEl.style.display = 'none';
    }
  }

  // The stock highlighted pixel lives in the current frame's overlay and
  // cannot leave it, so tiles that are not live get their own marker.
  function showHover(dc, coords, clientX, clientY) {
    var host = document.getElementById('drawing-canvas-container');
    var rect = host && host.getBoundingClientRect();
    if (!rect || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      hideHover();
      return;
    }
    if (!hoverEl) {
      hoverEl = document.createElement('div');
      hoverEl.className = 'tt-hover';
      host.appendChild(hoverEl);
    }
    var tool = dc.currentToolBehavior;
    var size = tool && tool.supportsDynamicPenSize() ? pskl.app.penSizeService.getPenSize() : 1;
    var z = dc.renderer.getZoom();
    var half = Math.floor(size / 2);
    // getScreenCoordinates answers with the CENTER of the pixel.
    var s = dc.getScreenCoordinates(coords.x - half, coords.y - half);
    hoverEl.style.left = (s.x - z / 2 - rect.left - window.pageXOffset) + 'px';
    hoverEl.style.top = (s.y - z / 2 - rect.top - window.pageYOffset) + 'px';
    hoverEl.style.width = hoverEl.style.height = (size * z) + 'px';
    hoverEl.style.display = 'block';
  }

  function patchPaintAnywhere() {
    var host = document.getElementById('drawing-canvas-container');
    // Piskel binds its mousedown and touchstart handlers at init, so
    // patching the prototype would never be called. Capture-phase listeners
    // run first, which is all that is needed: the frame is already switched
    // when piskel reads the coordinates.
    host.addEventListener('mousedown', function (evt) {
      if (evt.button !== Constants.MIDDLE_BUTTON) {
        followPointer(evt.clientX, evt.clientY);
      }
    }, true);
    window.addEventListener('touchstart', function (evt) {
      var t = evt.changedTouches && evt.changedTouches[0];
      if (t && host.contains(evt.target)) {
        followPointer(t.clientX, t.clientY);
      }
    }, true);
    host.addEventListener('mouseleave', hideHover);

    var proto = pskl.controller.DrawingController.prototype;
    var original = proto.moveTool_;
    proto.moveTool_ = function (x, y, event) {
      if (!cameraActive()) {
        hideHover();
        return original.call(this, x, y, event);
      }
      var coords = this.getSpriteCoordinates(x, y);
      var target = cellAt(coords);
      var elsewhere = target !== controller().getCurrentFrameIndex();

      if (!this.isClicked) {
        if (elsewhere && target !== -1) {
          showHover(this, coords, x, y);
        } else {
          hideHover();
        }
        return original.call(this, x, y, event);
      }

      hideHover();
      var tool = this.currentToolBehavior;
      var carries = tool instanceof pskl.tools.drawing.SimplePen &&
        !this.isPickingColor && !pskl.app.mouseStateService.isMiddleButtonPressed();
      if (!carries) {
        return original.call(this, x, y, event);
      }
      var frame = controller().getCurrentFrame();
      var cameFromOutside = tool.previousCol !== null &&
        !frame.containsPixel(tool.previousCol, tool.previousRow);
      if (!elsewhere && !cameFromOutside) {
        return original.call(this, x, y, event);
      }
      $.publish(Events.MOUSE_EVENT, [event, this]);
      carryStroke(this, { x: coords.x | 0, y: coords.y | 0 }, event);
      var now = this.getSpriteCoordinates(x, y);
      $.publish(Events.CURSOR_MOVED, [now.x, now.y]);
    };
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
    syncActions();

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

  // ── Paint-all reach ────────────────────────────────────────────
  // Stock "paint all pixels of the same color" knows two reaches: the
  // current frame, or with shift every frame in the project. A project with
  // several sets needs the one in between, and it is the default here
  // because the sheet on screen reads as one picture.

  // The bucket starts on one tile. A new set is nine empty tiles, and a
  // fill that crossed seams there would flood the whole sheet from a click
  // meant for one tile.
  var REACH = {
    'tool-colorswap': {
      key: 'pixelart-transition-swap-reach',
      says: 'Paint all changes',
      options: ['tile', 'set', 'all'],
      start: 'set'
    },
    'tool-paint-bucket': {
      key: 'pixelart-transition-fill-reach',
      says: 'Bucket fills across',
      options: ['tile', 'set'],
      start: 'tile'
    }
  };

  function reachOf(toolId) {
    var cfg = REACH[toolId];
    var v = null;
    try { v = localStorage.getItem(cfg.key); } catch (e) {}
    return cfg.options.indexOf(v) === -1 ? cfg.start : v;
  }

  function swapReach() {
    return reachOf('tool-colorswap');
  }

  function currentToolId() {
    var tool = pskl.app.drawingController && pskl.app.drawingController.currentToolBehavior;
    return tool ? tool.toolId : '';
  }

  function syncReachUi() {
    if (!panel) {
      return;
    }
    var row = panel.querySelector('.tt-reach');
    var cfg = REACH[currentToolId()];
    if (!cfg || !cameraActive()) {
      row.style.display = 'none';
      return;
    }
    row.style.display = 'block';
    row.querySelector('.tt-reach-says').textContent = cfg.says;
    var reach = reachOf(currentToolId());
    var buttons = row.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var name = buttons[i].getAttribute('data-reach');
      buttons[i].style.display = cfg.options.indexOf(name) === -1 ? 'none' : '';
      buttons[i].className = 'tt-reach-option' + (name === reach ? ' tt-reach-on' : '');
    }
  }

  // Flood fill over the whole set. The nine tiles are laid into one frame
  // so piskel's own fill does the work, then only the pixels it changed are
  // written back. x and y are in sheet space.
  function fillSet(base, x, y, color) {
    var pc = controller();
    var layer = pc.getCurrentLayer();
    var w = pc.getWidth();
    var h = pc.getHeight();
    var sheet = new pskl.model.Frame(3 * w, 3 * h);
    var tiles = [];
    var i;
    for (i = 0; i < 9; i++) {
      tiles.push(layer.getFrameAt(base + i));
    }
    tiles.forEach(function (tile, n) {
      var ox = (n % 3) * w;
      var oy = Math.floor(n / 3) * h;
      tile.forEachPixel(function (c, col, row) {
        sheet.setPixel(ox + col, oy + row, c);
      });
    });
    var before = sheet.getPixels();
    pskl.PixelUtils.paintSimilarConnectedPixelsFromFrame(sheet, x, y, color);
    sheet.forEachPixel(function (c, col, row) {
      if (c !== before[row * 3 * w + col]) {
        tiles[Math.floor(row / h) * 3 + Math.floor(col / w)].setPixel(col % w, row % h, c);
      }
    });
    for (i = 0; i < 9; i++) {
      touched(base + i);
    }
  }

  function patchBucket() {
    var proto = pskl.tools.drawing.PaintBucket.prototype;
    var apply = proto.applyToolAt;
    var replay = proto.replay;

    proto.applyToolAt = function (col, row, frame, overlay, event) {
      if (!cameraActive() || reachOf('tool-paint-bucket') !== 'set' || !frame.containsPixel(col, row)) {
        return apply.call(this, col, row, frame, overlay, event);
      }
      var pc = controller();
      var base = currentBase();
      var rel = pc.getCurrentFrameIndex() - base;
      var x = (rel % 3) * pc.getWidth() + col;
      var y = Math.floor(rel / 3) * pc.getHeight() + row;
      var color = this.getToolColor();
      fillSet(base, x, y, color);
      this.raiseSaveStateEvent({ setBase: base, x: x, y: y, color: color });
    };

    proto.replay = function (frame, data) {
      if (typeof data.setBase === 'number') {
        return fillSet(data.setBase, data.x, data.y, data.color);
      }
      return replay.call(this, frame, data);
    };
  }

  function swapInSet(tool, base, oldColor, newColor, allLayers) {
    var pc = controller();
    var layers = allLayers ? pc.getLayers() : [pc.getCurrentLayer()];
    layers.forEach(function (layer) {
      for (var i = base; i < base + 9; i++) {
        var frame = layer.getFrameAt(i);
        if (frame) {
          tool.applyToolOnFrame_(frame, oldColor, newColor);
        }
      }
    });
  }

  function patchColorSwap() {
    var proto = pskl.tools.drawing.ColorSwap.prototype;
    var apply = proto.applyToolAt;
    var replay = proto.replay;

    proto.applyToolAt = function (col, row, frame, overlay, event) {
      var reach = swapReach();
      // Shift keeps its stock meaning, so the keyboard habit still works.
      if (!cameraActive() || event.shiftKey || reach === 'tile') {
        return apply.call(this, col, row, frame, overlay, event);
      }
      if (!frame.containsPixel(col, row)) {
        return;
      }
      var pc = controller();
      var oldColor = frame.getPixel(col, row);
      var newColor = this.getToolColor();
      var allLayers = pskl.utils.UserAgent.isMac ? event.metaKey : event.ctrlKey;
      var first = 0;
      var count = pc.getFrameCount();
      if (reach === 'set') {
        first = currentBase();
        count = 9;
        swapInSet(this, first, oldColor, newColor, allLayers);
      } else {
        this.swapColors_(oldColor, newColor, allLayers, true);
      }
      for (var i = first; i < first + count; i++) {
        touched(i);
      }
      this.raiseSaveStateEvent({
        allLayers: allLayers,
        allFrames: reach === 'all',
        setBase: reach === 'set' ? first : undefined,
        oldColor: oldColor,
        newColor: newColor
      });
    };

    proto.replay = function (frame, data) {
      if (typeof data.setBase === 'number') {
        return swapInSet(this, data.setBase, data.oldColor, data.newColor, data.allLayers);
      }
      return replay.call(this, frame, data);
    };

    $.subscribe(Events.TOOL_SELECTED, function () {
      // The drawing controller updates its current tool from the same event.
      setTimeout(syncReachUi, 0);
    });
  }

  // ── Mirror ─────────────────────────────────────────────────────
  // A set drawn for a symmetric material only needs three of its eight
  // outer tiles: one corner, one top or bottom edge, one side edge. The
  // rest are the same art flipped.

  var ICON_MIRROR = '<svg viewBox="0 0 16 16"><path d="M8 1.5v13M5.5 4.5 2 8l3.5 3.5zM10.5 4.5 14 8l-3.5 3.5z"/></svg>';
  var ICON_COPY = '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="8.5" height="8.5" rx="1"/>' +
    '<path d="M5.5 13.5h7a1 1 0 0 0 1-1v-7"/></svg>';
  var ICON_PLUS = '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>';

  // Tiles that are each other flipped. The center has no partner.
  var PARTNERS = [[0, 2, 6, 8], [1, 7], [3, 5]];

  function partnersOf(pos) {
    for (var i = 0; i < PARTNERS.length; i++) {
      if (PARTNERS[i].indexOf(pos) !== -1) {
        return PARTNERS[i].filter(function (p) { return p !== pos; });
      }
    }
    return [];
  }

  // Empty means empty on every layer. A tile with art on a hidden or lower
  // layer is somebody's work and must not be filled over.
  function tileEmpty(index) {
    var layers = controller().getLayers();
    for (var i = 0; i < layers.length; i++) {
      var px = layers[i].getFrameAt(index).pixels;
      for (var k = 0; k < px.length; k++) {
        if (px[k] !== 0) {
          return false;
        }
      }
    }
    return true;
  }

  function emptyPairs(base) {
    var pairs = [];
    PARTNERS.forEach(function (group) {
      var drawn = group.filter(function (p) { return !tileEmpty(base + p); });
      if (!drawn.length) {
        return;
      }
      group.forEach(function (p) {
        if (drawn.indexOf(p) === -1) {
          pairs.push([base + drawn[0], base + p]);
        }
      });
    });
    return pairs;
  }

  function livePairs() {
    var pc = controller();
    var cur = pc.getCurrentFrameIndex();
    var base = currentBase();
    if (tileEmpty(cur)) {
      return [];
    }
    return partnersOf(cur - base).map(function (p) {
      return [cur, base + p];
    });
  }

  function flipInto(src, dst, flipH, flipV) {
    var w = src.getWidth();
    var h = src.getHeight();
    var from = src.pixels;
    var to = new Uint32Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        to[y * w + x] = from[(flipV ? h - 1 - y : y) * w + (flipH ? w - 1 - x : x)];
      }
    }
    dst.setPixels(to);
  }

  function applyPairs(pairs) {
    controller().getLayers().forEach(function (layer) {
      pairs.forEach(function (pair) {
        var a = pair[0] % 9;
        var b = pair[1] % 9;
        flipInto(layer.getFrameAt(pair[0]), layer.getFrameAt(pair[1]),
          a % 3 !== b % 3, Math.floor(a / 3) !== Math.floor(b / 3));
      });
    });
    pairs.forEach(function (pair) {
      touched(pair[1]);
    });
  }

  function mirror(pairs) {
    var pc = controller();
    if (!pc || !hasFullSet() || !pairs.length) {
      return;
    }
    applyPairs(pairs);
    // The pairs are decided once, here. Replaying the decision (which tiles
    // are empty) could come out differently and redo would drift.
    $.publish(Events.PISKEL_SAVE_STATE, {
      type: pskl.service.HistoryService.REPLAY,
      scope: { replay: function (frame, data) { applyPairs(data.pairs); } },
      replay: { pairs: pairs }
    });
    $.publish(Events.PISKEL_RESET);
    renderSheet(true);
  }

  function syncActions() {
    if (!panel || !hasFullSet()) {
      return;
    }
    var pc = controller();
    var fill = emptyPairs(currentBase());
    var fillBtn = panel.querySelector('.tt-mirror-empty');
    fillBtn.disabled = !fill.length;

    var liveBtn = panel.querySelector('.tt-mirror-live');
    var says = panel.querySelector('.tt-mirror-live-says');
    var pos = pc.getCurrentFrameIndex() - currentBase();
    var partners = partnersOf(pos);
    if (!partners.length) {
      says.textContent = 'The center tile has no mirror';
      liveBtn.disabled = true;
      liveBtn.title = 'Pick a corner or an edge tile to mirror it.';
      return;
    }
    var to = partners.map(function (p) { return LABELS[p]; }).join(', ');
    says.textContent = 'Mirror ' + LABELS[pos] + ' onto ' + to;
    liveBtn.disabled = tileEmpty(pc.getCurrentFrameIndex());
    liveBtn.title = liveBtn.disabled ? 'This tile is empty, so there is nothing to mirror.' :
      'Replace ' + to + ' with flipped copies of ' + LABELS[pos] + '. Undo brings them back.';
  }

  // Runs against the inner controller: the public one records every frame
  // operation as its own history step, and nine undos for one button press
  // is not what anyone means by undo.
  function copySet(base) {
    var inner = controller().piskelController;
    inner.getLayers().forEach(function (layer) {
      for (var i = 0; i < 9; i++) {
        layer.addFrameAt(layer.getFrameAt(base + i).clone(), base + 9 + i);
      }
    });
  }

  // The copy lands right after its source, which pushes every later set
  // along by exactly one bank, so they all stay whole.
  function duplicateSet() {
    var pc = controller();
    if (!pc || !hasFullSet()) {
      return;
    }
    var base = currentBase();
    var rel = pc.getCurrentFrameIndex() - base;
    var state = { frameIndex: pc.getCurrentFrameIndex(), layerIndex: pc.getCurrentLayerIndex() };
    copySet(base);
    $.publish(Events.PISKEL_SAVE_STATE, {
      type: pskl.service.HistoryService.REPLAY,
      scope: { replay: function (frame, data) { copySet(data.base); } },
      replay: { base: base },
      state: state
    });
    // Same tile, new set: the sheet on screen is replaced by its copy with
    // nothing appearing to move.
    pc.setCurrentFrameIndex(base + 9 + rel);
    cache = {};
    renderSheet(true);
    badgeFrameList();
    // The frame list redraws on its own clock, and the new set is usually
    // below the fold.
    setTimeout(function () {
      var tile = document.querySelector('#preview-list .preview-tile.selected');
      if (tile && tile.scrollIntoView) {
        tile.scrollIntoView({ block: 'nearest' });
      }
    }, 300);
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
      'Each frame is one tile of the 3x3 set. <button type="button" class="tt-make-frames tt-action">' +
      ICON_PLUS + '<span>Add frames to finish this set</span></button></div>' +
      '<div class="tt-body">' +
      '  <canvas class="tt-sheet" title="Click a tile to edit it"></canvas>' +
      '  <div class="tt-reach" style="display:none"><span class="tt-reach-says"></span>' +
      '<div class="tt-seg">' +
      '<button type="button" data-reach="tile">This tile</button>' +
      '<button type="button" data-reach="set">This set</button>' +
      '<button type="button" data-reach="all">Every set</button></div></div>' +
      '  <div class="tt-actions">' +
      '<button type="button" class="tt-mirror-empty tt-action" ' +
      'title="Fill each empty tile with a flipped copy of the matching tile you have drawn. Drawn tiles are left alone.">' +
      ICON_MIRROR + '<span>Mirror into empty tiles</span></button>' +
      '<button type="button" class="tt-mirror-live tt-action">' +
      ICON_MIRROR + '<span class="tt-mirror-live-says"></span></button>' +
      '<button type="button" class="tt-duplicate tt-action" ' +
      'title="Copy all 9 tiles into a new set, right after this one">' +
      ICON_COPY + '<span>Duplicate this set</span></button>' +
      '  </div>' +
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

    panel.querySelector('.tt-duplicate').addEventListener('click', duplicateSet);
    panel.querySelector('.tt-mirror-empty').addEventListener('click', function () {
      mirror(emptyPairs(currentBase()));
    });
    panel.querySelector('.tt-mirror-live').addEventListener('click', function () {
      mirror(livePairs());
    });
    panel.querySelector('.tt-reach').addEventListener('click', function (evt) {
      var reach = evt.target.getAttribute && evt.target.getAttribute('data-reach');
      var cfg = REACH[currentToolId()];
      if (reach && cfg) {
        try { localStorage.setItem(cfg.key, reach); } catch (e) {}
        syncReachUi();
      }
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
      markNotAnimation();
      renderSheet(true);
      badgeFrameList();
      fitSheet();
    });

    syncUi();
  }

  // ── 3. Frame badges ────────────────────────────────────────────

  // Sets are marked with classes and one child label per set, never with
  // extra list items: the list is a jQuery sortable and piskel maps a tile
  // to its frame by position among its siblings.
  function markSet(tile, index, count) {
    var inSet = isEnabled() && bankComplete(bankBase(index));
    // Frames past the last whole set. Only worth saying when there IS a set
    // above them to be told apart from.
    var loose = isEnabled() && !inSet && index >= 9 && index === bankBase(index);
    var setNo = Math.floor(index / 9) + 1;

    tile.classList.toggle('tt-in-set', inSet);
    tile.classList.toggle('tt-set-alt', inSet && setNo % 2 === 0);
    tile.classList.toggle('tt-set-start', (inSet && index % 9 === 0) || loose);
    tile.classList.toggle('tt-set-end', inSet && index % 9 === 8);

    var label = tile.querySelector('.tt-set-label');
    var text = '';
    if (inSet && index % 9 === 0) {
      text = 'Set ' + setNo;
    } else if (loose) {
      text = count - index === 1 ? 'Extra frame' : 'Extra frames';
    }
    if (!text) {
      if (label) {
        label.parentNode.removeChild(label);
      }
      return;
    }
    if (!label) {
      label = document.createElement('span');
      label.className = 'tt-set-label';
      tile.appendChild(label);
    }
    if (label.textContent !== text) {
      label.textContent = text;
    }
  }

  function badgeFrameList() {
    var list = document.getElementById('preview-list');
    if (!list) {
      return;
    }
    var tiles = list.querySelectorAll('.preview-tile');
    for (var i = 0; i < tiles.length; i++) {
      markSet(tiles[i], i, tiles.length);
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
      'Shows the whole set around the canvas, and you can draw on any tile in it without picking its ' +
      'frame first. Pen and eraser strokes carry across the seams. Adds a set preview and labels each ' +
      'tile. Turns on tile mode.</div>' +
      '<div class="preferences-description tt-fps-note">Also sets the animation FPS to 0. ' +
      'FPS 0 tells the gallery this project is a tileset, so previews show your tiles laid out ' +
      'as a sheet instead of playing them like a flipbook. Set FPS above 0 to make it an ' +
      'animation again.</div>';
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
      '#tt-panel .tt-sheet { display: block; margin: 0 auto; max-width: 100%;',
      '  max-height: 160px; image-rendering: pixelated; cursor: pointer;',
      '  background-image: conic-gradient(#3a3a3a 25%, #2c2c2c 0 50%, #3a3a3a 0 75%, #2c2c2c 0);',
      '  background-size: 12px 12px; border: 1px solid #3d3d3d; }',
      '#tt-panel .tt-hint { color: #c9a53d; }',
      '#tt-panel .tt-reach { margin-top: 8px; }',
      '#tt-panel .tt-reach-says { display: block; margin-bottom: 3px; font-size: 10px;',
      '  letter-spacing: .06em; text-transform: uppercase; color: #8a8a8a; }',
      '#tt-panel .tt-seg { display: flex; border: 1px solid #4a4a4a; border-radius: 4px;',
      '  overflow: hidden; }',
      '#tt-panel .tt-seg button { flex: 1 1 0; min-width: 0; height: 22px; margin: 0; padding: 0 2px;',
      '  font-family: inherit; font-size: 11px; color: #bdbdbd; background: #2e2e2e; border: 0;',
      '  border-left: 1px solid #4a4a4a; cursor: pointer; white-space: nowrap; }',
      '#tt-panel .tt-seg button:first-child { border-left: 0; }',
      '#tt-panel .tt-seg button:hover { color: #fff; background: #3a3a3a; }',
      '#tt-panel .tt-seg button.tt-reach-on { color: #1d1d1d; background: #ffd93d; font-weight: bold; }',
      '#tt-panel .tt-actions { display: flex; flex-direction: column; margin-top: 8px;',
      '  padding-top: 8px; border-top: 1px solid #3a3a3a; }',
      '#tt-panel .tt-action { display: flex; align-items: center; box-sizing: border-box; width: 100%;',
      '  height: 24px; margin: 0 0 4px; padding: 0 7px; font-family: inherit; font-size: 11px;',
      '  text-align: left; color: #d3d3d3; background: #333; border: 1px solid #4a4a4a;',
      '  border-radius: 4px; cursor: pointer; }',
      '#tt-panel .tt-action:last-child { margin-bottom: 0; }',
      '#tt-panel .tt-action span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }',
      '#tt-panel .tt-action svg { flex: none; width: 14px; height: 14px; margin-right: 6px;',
      '  fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linejoin: round;',
      '  stroke-linecap: round; }',
      '#tt-panel .tt-action:hover { color: #fff; border-color: #ffd93d; }',
      '#tt-panel .tt-action:disabled { color: #777; border-color: #3a3a3a; background: #2a2a2a;',
      '  cursor: default; }',
      '#tt-panel .tt-make-frames { margin-top: 6px; }',
      '.preview-tile { position: relative; }',
      '.tt-badge { position: absolute; bottom: 2px; left: 2px; background: rgba(0,0,0,.7);',
      '  color: #ffd93d; font-size: 9px; font-weight: bold; padding: 0 3px; border-radius: 2px;',
      '  pointer-events: none; z-index: 5; }',
      '#preview-list .preview-tile.tt-set-start { margin-top: 26px; }',
      '.tt-set-label { position: absolute; top: -22px; left: -3px; right: -3px; height: 16px;',
      '  font-size: 11px; line-height: 16px; font-weight: bold; letter-spacing: .04em;',
      '  text-transform: uppercase; color: #ffd93d; white-space: nowrap; pointer-events: none; }',
      '.tt-set-alt .tt-set-label, .tt-set-alt .tt-badge { color: #5fc9f3; }',
      '.preview-tile:not(.tt-in-set) .tt-set-label { color: #888; }',
      // The rail runs through the gaps between tiles, so a set reads as one
      // block, and stops short at both ends.
      '.preview-tile.tt-in-set:before { content: ""; position: absolute; right: -9px; width: 3px;',
      '  top: -8px; bottom: -8px; background: #ffd93d; }',
      '.preview-tile.tt-in-set.tt-set-alt:before { background: #5fc9f3; }',
      '.preview-tile.tt-in-set.tt-set-start:before { top: -3px; border-radius: 2px 2px 0 0; }',
      '.preview-tile.tt-in-set.tt-set-end:before { bottom: -3px; border-radius: 0 0 2px 2px; }',
      '.preview-tile.tt-in-set.selected:after { z-index: 2; }',
      '.tt-hover { position: absolute; display: none; pointer-events: none; z-index: 20;',
      '  box-sizing: border-box; background: rgba(255,255,255,.3);',
      '  border: 1px solid rgba(0,0,0,.45); }',
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
    // Piskel picks a new zoom for ONE frame 200ms after a resize, which
    // leaves the sheet hanging off the canvas. Fit again once it has.
    var refit = null;
    window.addEventListener('resize', function () {
      clearTimeout(refit);
      refit = setTimeout(fitSheet, 350);
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
        // Switched off from outside setEnabled (another tab shares the
        // setting). The camera and the outline still need handing back.
        if (wasActive) {
          trackFrameChange();
        }
        return;
      }
      trackFrameChange();
      renderSheet(false);
      syncReachUi();
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
      patchSheetDecor();
      patchOffsetClamp();
      patchPaintAnywhere();
      patchColorSwap();
      patchBucket();
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
