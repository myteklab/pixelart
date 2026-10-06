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
  // Piskel's own selection green (selected frame, selected tool).
  var ACCENT = '#00f900';
  // Every other set in the frame list, so two neighbors still differ.
  var ACCENT_ALT = '#00a35c';
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
    if (!on && seamsOn) {
      setSeamsOn(false);
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
        // Dark line outside the green one. Green alone is lost on grass,
        // which is what most tilesets are made of.
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0, 0, 0, .7)';
        ctx.strokeRect(col * tw - 1.5, row * th - 1.5, tw + 3, th + 3);
        ctx.strokeStyle = ACCENT;
        ctx.strokeRect(col * tw - 0.5, row * th - 0.5, tw + 1, th + 1);
        drawSeamMarks(ctx, z, tw, th);
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
    if (seamsOn) {
      refreshSeams();
    }

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
      var lw = Math.max(1, Math.round(tw / 16));
      sctx.lineWidth = lw;
      sctx.strokeStyle = 'rgba(0, 0, 0, .7)';
      sctx.strokeRect((rel % 3) * tw + 0.5 + lw, Math.floor(rel / 3) * th + 0.5 + lw, tw - 1 - 2 * lw, th - 1 - 2 * lw);
      sctx.strokeStyle = ACCENT;
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

  // ── Seam check ─────────────────────────────────────────────────
  // Finds the places where a tile's edge does not continue into the tile
  // beside it, and flashes them. It only points. Nothing is written to the
  // project: the marks are painted on the tool overlay at render time, so
  // they cannot reach a save, an export, a preview, or a collaborator.

  var SEAM_FLASH_MS = 360;
  // Owned by the platform's tiling helper. Its flashing marks are not art.
  var HELPER_LAYER = 'AI: fix these';
  // Colors closer than this are one color to the check. Hand-picked
  // palettes keep their shades further apart than that (the closest pair in
  // the tileset this was tuned on is 40), while soft shading and imported
  // art with dozens of near-identical shades collapse into a few.
  var SAME_COLOR = 24;
  // Texture: a patch of one color this small, counting diagonal touches.
  var SPECK_MAX = 2;

  // [tile A, direction to B, tile B]. The first twelve are the seams
  // inside the sheet. The rest are tiles that repeat against themselves on
  // a real map: edges run along their own direction, the center both ways.
  var SEAMS = [
    [0, 'r', 1], [1, 'r', 2], [3, 'r', 4], [4, 'r', 5], [6, 'r', 7], [7, 'r', 8],
    [0, 'b', 3], [3, 'b', 6], [1, 'b', 4], [4, 'b', 7], [2, 'b', 5], [5, 'b', 8],
    [1, 'r', 1], [7, 'r', 7], [3, 'b', 3], [5, 'b', 5], [4, 'r', 4], [4, 'b', 4]
  ];

  var seamsOn = false;
  var seamPick = '';    // the one seam whose marks are showing, when a row is picked
  var seamMarks = [];   // {pos, x, y} within the current set
  var seamPhase = 0;
  var seamTimer = null;

  function mergedTile(index) {
    var pc = controller();
    var w = pc.getWidth();
    var h = pc.getHeight();
    var out = new Uint32Array(w * h);
    var layers = pc.getLayers();
    var any = false;
    for (var l = layers.length - 1; l >= 0; l--) {
      if (layers[l].getName() === HELPER_LAYER) {
        continue;
      }
      var px = layers[l].getFrameAt(index).pixels;
      for (var i = 0; i < px.length; i++) {
        if (!out[i] && px[i] >>> 24) {
          out[i] = px[i];
          any = true;
        }
      }
    }
    return { w: w, h: h, px: out, empty: !any };
  }

  function colorDist(p, q) {
    var pa = p >>> 24;
    var qa = q >>> 24;
    if (!pa || !qa) {
      return pa === qa ? 0 : 255;
    }
    var dr = (p & 255) - (q & 255);
    var dg = ((p >> 8) & 255) - ((q >> 8) & 255);
    var db = ((p >> 16) & 255) - ((q >> 16) & 255);
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // The two tiles of a seam laid against each other as one picture, with
  // every pixel replaced by the number of its color class. Working on the
  // pair means a shape that crosses the seam is measured whole.
  function seamStrip(a, b, dir) {
    var w = a.w;
    var h = a.h;
    var W = dir === 'r' ? 2 * w : w;
    var H = dir === 'r' ? h : 2 * h;
    var raw = new Uint32Array(W * H);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        raw[y * W + x] = a.px[y * w + x];
        if (dir === 'r') {
          raw[y * W + x + w] = b.px[y * w + x];
        } else {
          raw[(y + h) * W + x] = b.px[y * w + x];
        }
      }
    }
    // Most used colors become the class representatives.
    var count = {};
    var i;
    for (i = 0; i < raw.length; i++) {
      count[raw[i]] = (count[raw[i]] || 0) + 1;
    }
    var colors = Object.keys(count).map(Number).sort(function (p, q) { return count[q] - count[p]; });
    var reps = [];
    var classOf = {};
    colors.forEach(function (c) {
      for (var r = 0; r < reps.length; r++) {
        if (colorDist(c, reps[r]) <= SAME_COLOR) {
          classOf[c] = r;
          return;
        }
      }
      classOf[c] = reps.length;
      reps.push(c);
    });
    var cls = new Int32Array(W * H);
    for (i = 0; i < raw.length; i++) {
      cls[i] = classOf[raw[i]];
    }
    return { W: W, H: H, cls: cls };
  }

  // Texture out, structure kept. Specks share their colors with the real
  // shapes (the dark water of a shoreline is also the dark fleck in open
  // water), so color cannot tell them apart. Size can.
  function dropSpecks(strip) {
    var W = strip.W;
    var H = strip.H;
    var cls = strip.cls;
    var size = new Int32Array(W * H);
    var seen = new Uint8Array(W * H);
    var i;
    var dx;
    var dy;
    for (i = 0; i < W * H; i++) {
      if (seen[i]) {
        continue;
      }
      var stack = [i];
      var members = [];
      seen[i] = 1;
      while (stack.length) {
        var p = stack.pop();
        members.push(p);
        var px = p % W;
        var py = (p - px) / W;
        // Diagonals count. A band that wanders one pixel sideways per row
        // is still one band.
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            var nx = px + dx;
            var ny = py + dy;
            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H) {
              var q = ny * W + nx;
              if (!seen[q] && cls[q] === cls[p]) {
                seen[q] = 1;
                stack.push(q);
              }
            }
          }
        }
      }
      for (var m = 0; m < members.length; m++) {
        size[members[m]] = members.length;
      }
    }
    var out = new Int32Array(cls);
    for (i = 0; i < W * H; i++) {
      if (size[i] > SPECK_MAX) {
        continue;
      }
      var x = i % W;
      var y = (i - x) / W;
      var votes = {};
      var best = -1;
      var bestVotes = 0;
      for (dy = -1; dy <= 1; dy++) {
        for (dx = -1; dx <= 1; dx++) {
          var vx = x + dx;
          var vy = y + dy;
          if ((dx || dy) && vx >= 0 && vy >= 0 && vx < W && vy < H && size[vy * W + vx] > SPECK_MAX) {
            var c = cls[vy * W + vx];
            votes[c] = (votes[c] || 0) + (dx && dy ? 1 : 2);
            if (votes[c] > bestVotes) {
              bestVotes = votes[c];
              best = c;
            }
          }
        }
      }
      if (best !== -1) {
        out[i] = best;
      }
    }
    return out;
  }

  // One seam. For each position along it: the pixel on A's edge, the one
  // on B's edge, and the pixel behind each.
  // Which pixels of one tile are patches of SPECK_MAX or fewer.
  function fleckMask(px, w, h) {
    var mask = new Uint8Array(w * h);
    var seen = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) {
      if (seen[i]) {
        continue;
      }
      var stack = [i];
      var members = [];
      seen[i] = 1;
      while (stack.length) {
        var p = stack.pop();
        members.push(p);
        var x = p % w;
        var y = (p - x) / w;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx;
            var ny = y + dy;
            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
              var q = ny * w + nx;
              if (!seen[q] && px[q] === px[p]) {
                seen[q] = 1;
                stack.push(q);
              }
            }
          }
        }
      }
      if (members.length <= SPECK_MAX) {
        for (var m = 0; m < members.length; m++) {
          mask[members[m]] = 1;
        }
      }
    }
    return mask;
  }

  // A fleck that touches a band of its own color is part of that band as
  // far as size can tell, and it gets reported as the band sticking out.
  // Tilesets are usually made by stamping one texture into every tile and
  // drawing the transition over it, so the same flecks sit at the same
  // place in tile after tile. Two references: what most tiles have at each
  // position (the outer material, it covers most of 8 tiles), and the
  // center tile (the inner material). A set with no shared texture gives
  // references with no flecks in them, and nothing is excused.
  function textureOf(tiles) {
    var w = tiles[0].w;
    var h = tiles[0].h;
    var drawn = tiles.filter(function (t) { return !t.empty; });
    var common = new Uint32Array(w * h);
    var known = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) {
      var count = {};
      for (var t = 0; t < drawn.length; t++) {
        var c = drawn[t].px[i];
        count[c] = (count[c] || 0) + 1;
        if (count[c] >= 4) {
          common[i] = c;
          known[i] = 1;
        }
      }
    }
    var refs = [{ px: common, known: known, fleck: fleckMask(common, w, h) }];
    if (!tiles[4].empty) {
      refs.push({ px: tiles[4].px, known: null, fleck: fleckMask(tiles[4].px, w, h) });
    }
    return function (tile, x, y) {
      var at = y * w + x;
      for (var r = 0; r < refs.length; r++) {
        if (refs[r].fleck[at] && (!refs[r].known || refs[r].known[at]) && refs[r].px[at] === tile.px[at]) {
          return true;
        }
      }
      return false;
    };
  }

  function checkSeam(a, b, dir, posA, posB, isTexture) {
    var strip = seamStrip(a, b, dir);
    var cls = dropSpecks(strip);
    var W = strip.W;
    var n = dir === 'r' ? a.h : a.w;
    var rows = [];
    var k;
    for (k = 0; k < n; k++) {
      var at = dir === 'r' ? k * W + a.w - 1 : (a.h - 1) * W + k;
      var step = dir === 'r' ? 1 : W;
      rows.push({ a: cls[at], b: cls[at + step], behindA: cls[at - step], behindB: cls[at + 2 * step] });
    }
    // Anything that holds for this long is running ALONG the seam.
    var along = Math.max(4, Math.ceil(n / 4));
    var marks = [];
    var breaks = 0;
    var line = false;
    var from = 0;
    while (from < n) {
      var to = from;
      while (to + 1 < n && rows[to + 1].a === rows[from].a && rows[to + 1].b === rows[from].b) {
        to++;
      }
      var r = rows[from];
      var len = to - from + 1;
      // A stripe sitting on the seam with the same material on both sides
      // of it. One pixel wide on either tile, or two wide across both.
      var stripe = r.a === r.b ?
        (r.behindA !== r.a && r.behindB !== r.b && r.behindA === r.behindB) :
        ((r.behindA === r.b && r.behindA !== r.a) || (r.behindB === r.a && r.behindB !== r.b));
      var kind = '';
      if (stripe && len >= along) {
        kind = 'line';
      } else if (r.a !== r.b && len < along) {
        kind = 'break';
      }
      // What is left over is either a match, or two materials meeting
      // exactly on the seam for a long stretch, which is a fair way to
      // draw a set.
      if (kind) {
        for (k = from; k <= to; k++) {
          var ax = dir === 'r' ? a.w - 1 : k;
          var ay = dir === 'r' ? k : a.h - 1;
          var bx = dir === 'r' ? 0 : k;
          var by = dir === 'r' ? k : 0;
          if (kind === 'break') {
            if (isTexture(a, ax, ay) || isTexture(b, bx, by)) {
              continue;
            }
            breaks++;
          }
          if (kind === 'break' || r.a !== r.behindA) {
            marks.push({ pos: posA, at: { x: ax, y: ay } });
          }
          if (kind === 'break' || r.b !== r.behindB) {
            marks.push({ pos: posB, at: { x: bx, y: by } });
          }
        }
        if (kind === 'line') {
          line = true;
        }
      }
      from = to + 1;
    }
    return { a: posA, b: posB, breaks: breaks, line: line, stacked: dir === 'b', marks: marks, length: n };
  }

  function checkSeams(base) {
    var tiles = [];
    var empty = [];
    for (var i = 0; i < 9; i++) {
      tiles.push(mergedTile(base + i));
      if (tiles[i].empty) {
        empty.push(i);
      }
    }
    var found = [];
    var wrecked = 0;
    var isTexture = textureOf(tiles);
    SEAMS.forEach(function (seam) {
      var a = tiles[seam[0]];
      var b = tiles[seam[2]];
      // A tile that is not drawn yet is not a mistake.
      if (a.empty || b.empty) {
        return;
      }
      var result = checkSeam(a, b, seam[1], seam[0], seam[2], isTexture);
      if (result.marks.length) {
        found.push(result);
        if (seam[0] !== seam[2] && result.breaks >= result.length / 4) {
          wrecked++;
        }
      }
    });
    // Nine unrelated tiles (trees, rocks, signs) kept in one bank. Every
    // edge differs from its neighbor and none of it is a mistake.
    // Half of the twelve inner seams each broken along a quarter of their
    // length is not a set with mistakes in it.
    return { seams: found, empty: empty, checked: 9 - empty.length, unrelated: wrecked >= 6 };
  }

  function drawSeamMarks(ctx, z, tw, th) {
    if (!seamsOn || !seamMarks.length || seamPhase === 2) {
      return;
    }
    // White, then magenta, then nothing. The gap is what makes it read as
    // a blink on any color, black and white included.
    ctx.fillStyle = seamPhase === 0 ? '#ffffff' : '#ff00e5';
    for (var i = 0; i < seamMarks.length; i++) {
      var m = seamMarks[i];
      ctx.fillRect((m.pos % 3) * tw + m.at.x * z, Math.floor(m.pos / 3) * th + m.at.y * z, z, z);
    }
  }

  function seamSays(seam) {
    // A tile against a copy of itself, the way it repeats on a map.
    var joins = seam.a !== seam.b ? ' and ' : (seam.stacked ? ' above ' : ' beside ');
    var pair = '<b translate="no">' + LABELS[seam.a] + '</b>' + joins +
      '<b translate="no">' + LABELS[seam.b] + '</b>';
    if (!seam.breaks) {
      return { pair: pair, what: 'line on the edge' };
    }
    return { pair: pair, what: seam.breaks + (seam.breaks === 1 ? ' pixel' : ' pixels') };
  }

  function refreshSeams() {
    if (!panel) {
      return;
    }
    var box = panel.querySelector('.tt-seams');
    var btn = panel.querySelector('.tt-seam-check span');
    btn.textContent = seamsOn ? 'Hide seam check' : 'Check my seams';
    box.style.display = seamsOn ? 'block' : 'none';
    if (!seamsOn || !hasFullSet()) {
      seamMarks = [];
      dropOutline();
      return;
    }
    var result = checkSeams(currentBase());
    var keyOf = function (seam) {
      return currentBase() + ':' + seam.a + (seam.stacked ? '/' : '|') + seam.b;
    };
    var picked = result.seams.filter(function (seam) { return keyOf(seam) === seamPick; })[0];
    if (!picked) {
      seamPick = '';
    }
    // A tile's left and right edge flashing at once, in a sheet where it
    // meets its neighbors perfectly, reads as the check being wrong. Repeat
    // seams only flash when their own row is picked.
    seamMarks = [];
    if (!result.unrelated) {
      result.seams.forEach(function (seam) {
        if (picked ? seam === picked : seam.a !== seam.b) {
          seamMarks = seamMarks.concat(seam.marks);
        }
      });
    }

    var between = [];
    var repeated = [];
    if (!result.unrelated) {
      result.seams.forEach(function (seam) {
        (seam.a === seam.b ? repeated : between).push(seam);
      });
    }
    var head;
    var cls = 'tt-seams-head';
    if (result.checked < 2) {
      head = 'Draw at least two tiles, then check again.';
    } else if (result.unrelated) {
      head = 'These 9 tiles do not look like one transition set, so there are no seams to check.';
    } else if (!between.length) {
      head = 'Every tile lines up with its neighbors.';
      cls += ' tt-seams-good';
    } else {
      head = between.length === 1 ? '1 seam does not line up' : between.length + ' seams do not line up';
      cls += ' tt-seams-bad';
    }
    var html = '<div class="' + cls + '">' + head + '</div>';
    var rowsOf = function (list) {
      return list.map(function (seam) {
        var says = seamSays(seam);
        return '<button type="button" class="tt-seam-row' + (seam === picked ? ' tt-seam-picked' : '') +
          '" data-frame="' + (currentBase() + seam.a) + '" data-seam="' + keyOf(seam) + '">' +
          '<span>' + says.pair + '</span><span class="tt-seam-count">' + says.what + '</span></button>';
      }).join('');
    };
    html += rowsOf(between);
    if (repeated.length) {
      html += '<div class="tt-seams-cap" title="Only matters on a map wider or taller than 3 tiles, where ' +
        'an edge tile or the center sits next to a copy of itself. Click a row to see where.">' +
        'Only if a tile repeats</div>' + rowsOf(repeated);
    }
    if (result.empty.length && result.checked >= 2 && !result.unrelated) {
      html += '<div class="tt-seams-note">Not checked, still empty: <span translate="no">' +
        result.empty.map(function (p) { return LABELS[p]; }).join(', ') + '</span></div>';
    }
    if (box.innerHTML !== html) {
      box.innerHTML = html;
    }
    dropOutline();
  }

  function setSeamsOn(on) {
    seamsOn = on;
    clearInterval(seamTimer);
    seamTimer = null;
    if (on) {
      seamPhase = 0;
      seamTimer = setInterval(function () {
        seamPhase = (seamPhase + 1) % 3;
        dropOutline();
      }, SEAM_FLASH_MS);
    }
    refreshSeams();
  }

  // ── Mirror ─────────────────────────────────────────────────────
  // A set drawn for a symmetric material only needs three of its eight
  // outer tiles: one corner, one top or bottom edge, one side edge. The
  // rest are the same art flipped.

  var ICON_MIRROR = '<svg viewBox="0 0 16 16"><path d="M8 1.5v13M5.5 4.5 2 8l3.5 3.5zM10.5 4.5 14 8l-3.5 3.5z"/></svg>';
  var ICON_COPY = '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="8.5" height="8.5" rx="1"/>' +
    '<path d="M5.5 13.5h7a1 1 0 0 0 1-1v-7"/></svg>';
  var ICON_SEAM = '<svg viewBox="0 0 16 16"><path d="M8 1.5v2M8 5.5v2M8 9.5v2M8 13v1.5M2 5h3.5M10.5 5H14M2 11h3.5M10.5 9H14"/></svg>';
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
      // Set gaps first. They move every tile below them, and scrolling
      // before they are in place lands on the wrong spot.
      badgeFrameList();
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
      '<button type="button" class="tt-seam-check tt-action" ' +
      'title="Flash the pixels where one tile does not continue into the tile next to it. Nothing is changed.">' +
      ICON_SEAM + '<span>Check my seams</span></button>' +
      '  </div>' +
      '  <div class="tt-seams" style="display:none"></div>' +
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
    panel.querySelector('.tt-seam-check').addEventListener('click', function () {
      setSeamsOn(!seamsOn);
    });
    panel.querySelector('.tt-seams').addEventListener('click', function (evt) {
      var row = evt.target.closest && evt.target.closest('.tt-seam-row');
      if (row) {
        var key = row.getAttribute('data-seam');
        seamPick = seamPick === key ? '' : key;
        controller().setCurrentFrameIndex(+row.getAttribute('data-frame'));
        refreshSeams();
      }
    });
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

  // ── Export: sets side by side ──────────────────────────────────
  // Stock export fills the sheet frame by frame, so at 6 columns set 1's
  // TL T TR L C R share a row and every set comes out scrambled. With the
  // mode on, the first N banks are exported as sets: each is drawn as its 3x3
  // block, blocks fill rows of the chosen width, and every frame after them
  // follows in frame order, in rows of that same width.
  //
  // N is asked, not assumed. The mode calls every 9 frames a set, but a
  // tileset often keeps loose tiles after its sets, and drawing those as 3x3
  // blocks scrambled them (Stephen's RPG tileset, 10-06: 2 sets, then 29
  // loose tiles read as 3 more sets). The field starts at the leading banks
  // the seam check accepts as one set.

  var exportSetsPerRow = 1;
  var exportSetCount = null;  // null until the student changes the field
  var exportSetCountGuessed = false;

  function wholeBanks() {
    var pc = controller();
    return isEnabled() && pc ? Math.floor(pc.getFrameCount() / 9) : 0;
  }

  function guessSetCount() {
    var banks = wholeBanks();
    for (var n = 0; n < banks; n++) {
      var result = checkSeams(n * 9);
      if (result.empty.length || result.unrelated) {
        return n;
      }
    }
    return banks;
  }

  function exportSets() {
    var banks = wholeBanks();
    if (!banks) {
      return 0;
    }
    if (exportSetCount === null) {
      exportSetCount = guessSetCount();
      exportSetCountGuessed = true;
    }
    return Math.min(exportSetCount, banks);
  }

  // Sheet cell [col, row] for every frame, plus the sheet size in cells.
  // The first `sets` banks of 9 are sets; everything after is in frame order.
  function setSheetLayout(frameCount, perRow, sets) {
    sets = Math.max(0, Math.min(sets, Math.floor(frameCount / 9)));
    perRow = Math.max(1, Math.min(perRow, sets));
    var columns = perRow * 3;
    var setRows = Math.ceil(sets / perRow) * 3;
    var cells = [];
    for (var i = 0; i < frameCount; i++) {
      if (i < sets * 9) {
        var set = Math.floor(i / 9);
        var tile = i % 9;
        cells.push([(set % perRow) * 3 + tile % 3, Math.floor(set / perRow) * 3 + Math.floor(tile / 3)]);
      } else {
        var extra = i - sets * 9;
        cells.push([extra % columns, setRows + Math.floor(extra / columns)]);
      }
    }
    var extras = frameCount - sets * 9;
    return {
      perRow: perRow,
      columns: columns,
      rows: setRows + Math.ceil(extras / columns),
      extras: extras,
      cells: cells
    };
  }

  function exportLayout() {
    var sets = exportSets();
    return sets ? setSheetLayout(controller().getFrameCount(), exportSetsPerRow, sets) : null;
  }

  // What the columns field asks for, read as whole sets. The field is only
  // rewritten on change, so typing 12 one key at a time is not snapped to 3
  // after the first key.
  function readSetsPerRow(input, sets) {
    var value = parseInt(input.value, 10);
    if (isNaN(value)) {
      return exportSetsPerRow;
    }
    return Math.max(1, Math.min(sets, Math.round(value / 3) || 1));
  }

  function exportNote(ctrl, layout) {
    var note = ctrl.layoutContainer && ctrl.layoutContainer.querySelector('.tt-export-note');
    if (!note && ctrl.layoutContainer) {
      note = document.createElement('div');
      note.className = 'tt-export-note';
      ctrl.layoutContainer.appendChild(note);
    }
    if (!note) {
      return;
    }
    if (!layout) {
      note.style.display = 'none';
      return;
    }
    // Frame numbers, not bank counts: "2 of 5" read as "you have 5 sets" to
    // someone whose project has 2 sets and a pile of loose tiles.
    var total = layout.cells.length;
    var last = total - layout.extras;
    var sets = last / 9;
    var text = 'Frames 1-' + last + ' are ' + (sets === 1 ? '1 set' : sets + ' sets') +
      (sets > 1 ? ', ' + layout.perRow + ' per row.' : '.');
    if (layout.extras === 1) {
      text += ' Frame ' + total + ' goes underneath.';
    } else if (layout.extras) {
      text += ' Frames ' + (last + 1) + '-' + total + ' go underneath in order, ' +
        layout.columns + ' across.';
    }
    if (exportSetCountGuessed) {
      text += ' The number of sets was read from your seams. Change it if it is wrong.';
    }
    note.textContent = text;
    note.style.display = '';
  }

  function patchSetExport() {
    var Png = pskl.controller && pskl.controller.settings && pskl.controller.settings.exportimage &&
      pskl.controller.settings.exportimage.PngExportController;
    if (!Png || Png.prototype.ttSetExport) {
      return;
    }
    var proto = Png.prototype;
    proto.ttSetExport = true;

    var stockBestFit = proto.getBestFit_;
    proto.getBestFit_ = function () {
      var sets = exportSets();
      return sets ? Math.min(exportSetsPerRow, sets) * 3 : stockBestFit.call(this);
    };

    var stockColumns = proto.getColumns_;
    proto.getColumns_ = function () {
      var layout = exportLayout();
      return layout ? layout.columns : stockColumns.call(this);
    };

    var stockInit = proto.initLayoutSection_;
    proto.initLayoutSection_ = function () {
      stockInit.call(this);
      var input = this.columnsInput;
      if (!input || input.ttSnap) {
        return;
      }
      input.ttSnap = true;
      var self = this;
      input.addEventListener('change', function () {
        var layout = exportLayout();
        if (layout) {
          input.value = layout.columns;
        }
      });
      buildSetCountField(self);
      self.onColumnsInput_();
    };

    // "Keep as 3x3 sets [N]", counted from frame 1. The stock tab is built once per
    // open, so the field and the column limits are set up here each time.
    function buildSetCountField(ctrl) {
      var banks = wholeBanks();
      if (!banks || !ctrl.layoutContainer || ctrl.layoutContainer.querySelector('.tt-export-sets')) {
        return;
      }
      var row = document.createElement('div');
      row.className = 'tt-export-sets';
      row.innerHTML = '<span>Keep as 3x3 sets</span>' +
        '<input type="number" min="0" class="textfield tt-export-sets-input">';
      var field = row.querySelector('input');
      field.setAttribute('max', banks);
      field.value = exportSets();
      field.addEventListener('input', function () {
        var n = parseInt(field.value, 10);
        if (isNaN(n)) {
          return;
        }
        exportSetCount = Math.max(0, Math.min(banks, n));
        exportSetCountGuessed = false;
        if (exportSetCount) {
          // Keep the width the student asked for, in whole sets.
          exportSetsPerRow = Math.min(exportSetsPerRow, exportSetCount);
          ctrl.columnsInput.value = exportSetsPerRow * 3;
        }
        columnLimits(ctrl);
        ctrl.onColumnsInput_();
      });
      field.addEventListener('change', function () {
        field.value = exportSets();
      });
      var title = ctrl.layoutContainer.querySelector('.highlight');
      ctrl.layoutContainer.insertBefore(row, title ? title.nextSibling : ctrl.layoutContainer.firstChild);
      columnLimits(ctrl);
    }

    function columnLimits(ctrl) {
      var input = ctrl.columnsInput;
      var sets = exportSets();
      if (sets) {
        input.setAttribute('min', 3);
        input.setAttribute('step', 3);
        input.setAttribute('max', sets * 3);
      } else {
        input.setAttribute('min', 1);
        input.removeAttribute('step');
        input.setAttribute('max', ctrl.piskelController.getFrameCount());
      }
    }

    var stockColumnsInput = proto.onColumnsInput_;
    proto.onColumnsInput_ = function () {
      var sets = exportSets();
      if (!sets) {
        exportNote(this, null);
        return stockColumnsInput.call(this);
      }
      if (this.columnsInput.value === '') {
        return;
      }
      exportSetsPerRow = readSetsPerRow(this.columnsInput, sets);
      var layout = exportLayout();
      this.rowsInput.value = layout.rows;
      this.updateDimensionLabel_();
      exportNote(this, layout);
    };

    var stockSheet = proto.createPngSpritesheet_;
    proto.createPngSpritesheet_ = function () {
      var layout = exportLayout();
      if (!layout) {
        return stockSheet.call(this);
      }
      var pc = this.piskelController;
      var w = pc.getWidth();
      var h = pc.getHeight();
      var renderer = new pskl.rendering.PiskelRenderer(pc);
      var canvas = pskl.utils.CanvasUtils.createCanvas(layout.columns * w, layout.rows * h);
      var ctx = canvas.getContext('2d');
      renderer.frames.forEach(function (frame, i) {
        ctx.drawImage(frame, layout.cells[i][0] * w, layout.cells[i][1] * h);
      });
      var zoom = this.exportController.getExportZoom();
      if (zoom != 1) {
        canvas = pskl.utils.ImageResizer.resize(canvas, canvas.width * zoom, canvas.height * zoom, false);
      }
      return canvas;
    };

    // The PixiJS JSON gives each frame's place on the sheet, so it has to
    // follow the same layout or it would point at the wrong tiles.
    var stockPixi = proto.onPixiDownloadClick_;
    proto.onPixiDownloadClick_ = function () {
      var layout = exportLayout();
      if (!layout) {
        return stockPixi.call(this);
      }
      var zip = new window.JSZip();
      var canvas = this.createPngSpritesheet_();
      var name = this.piskelController.getPiskel().getDescriptor().name;
      zip.file(name + '.png', pskl.utils.CanvasUtils.getBase64FromCanvas(canvas) + '\n', { base64: true });

      var width = canvas.width / layout.columns;
      var height = canvas.height / layout.rows;
      var frames = {};
      layout.cells.forEach(function (cell, i) {
        frames[name + i + '.png'] = {
          'frame': { 'x': width * cell[0], 'y': height * cell[1], 'w': width, 'h': height },
          'rotated': false,
          'trimmed': false,
          'spriteSourceSize': { 'x': 0, 'y': 0, 'w': width, 'h': height },
          'sourceSize': { 'w': width, 'h': height }
        };
      });
      zip.file(name + '.json', JSON.stringify({
        'frames': frames,
        'meta': {
          'app': 'https://github.com/piskelapp/piskel/',
          'version': '1.0',
          'image': name + '.png',
          'format': 'RGBA8888',
          'size': { 'w': canvas.width, 'h': canvas.height }
        }
      }));
      pskl.utils.FileUtils.downloadAsFile(zip.generate({ type: 'blob' }), name + '.zip');
    };
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
      '.tt-export-note { margin-top: 6px; font-size: 11px; line-height: 1.4; color: #b3b3b3; }',
      '.tt-export-sets { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; line-height: 20px; }',
      '.tt-export-sets input { width: 46px; }',
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
      '#tt-panel .tt-seg button.tt-reach-on { color: #1d1d1d; background: ' + ACCENT + '; font-weight: bold; }',
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
      '#tt-panel .tt-action:hover { color: #fff; border-color: ' + ACCENT + '; }',
      '#tt-panel .tt-action:disabled { color: #777; border-color: #3a3a3a; background: #2a2a2a;',
      '  cursor: default; }',
      '#tt-panel .tt-make-frames { margin-top: 6px; }',
      '#tt-panel .tt-seams { margin-top: 8px; padding-top: 8px; border-top: 1px solid #3a3a3a;',
      '  font-size: 11px; max-height: 132px; overflow-y: auto; }',
      '#tt-panel .tt-seams-head { margin-bottom: 4px; font-weight: bold; color: #d3d3d3; }',
      '#tt-panel .tt-seams-good { color: #7ddc8a; }',
      '#tt-panel .tt-seams-bad { color: #ff8ad8; }',
      '#tt-panel .tt-seam-row { display: flex; justify-content: space-between; box-sizing: border-box;',
      '  width: 100%; margin: 0; padding: 2px 5px; font-family: inherit; font-size: 11px;',
      '  line-height: 16px; text-align: left; color: #bdbdbd; background: none; border: 0;',
      '  border-radius: 3px; cursor: pointer; }',
      '#tt-panel .tt-seam-row:hover { color: #fff; background: #3a3a3a; }',
      '#tt-panel .tt-seam-picked, #tt-panel .tt-seam-picked:hover { color: #fff; background: #3a3a3a;',
      '  box-shadow: inset 2px 0 0 ' + ACCENT + '; }',
      '#tt-panel .tt-seam-row b { color: ' + ACCENT + '; }',
      '#tt-panel .tt-seam-count { flex: none; margin-left: 6px; color: #8a8a8a; white-space: nowrap; }',
      '#tt-panel .tt-seams-note { margin-top: 4px; color: #8a8a8a; }',
      '#tt-panel .tt-seams-cap { margin: 6px 0 2px; font-size: 10px; letter-spacing: .06em;',
      '  text-transform: uppercase; color: #8a8a8a; cursor: help; }',
      '.preview-tile { position: relative; }',
      '.tt-badge { position: absolute; bottom: 2px; left: 2px; background: rgba(0,0,0,.7);',
      '  color: ' + ACCENT + '; font-size: 9px; font-weight: bold; padding: 0 3px; border-radius: 2px;',
      '  pointer-events: none; z-index: 5; }',
      '#preview-list .preview-tile.tt-set-start { margin-top: 26px; }',
      '.tt-set-label { position: absolute; top: -22px; left: -3px; right: -3px; height: 16px;',
      '  font-size: 11px; line-height: 16px; font-weight: bold; letter-spacing: .04em;',
      '  text-transform: uppercase; color: ' + ACCENT + '; white-space: nowrap; pointer-events: none; }',
      '.tt-set-alt .tt-set-label, .tt-set-alt .tt-badge { color: ' + ACCENT_ALT + '; }',
      '.preview-tile:not(.tt-in-set) .tt-set-label { color: #888; }',
      // The rail runs through the gaps between tiles, so a set reads as one
      // block, and stops short at both ends.
      '.preview-tile.tt-in-set:before { content: ""; position: absolute; right: -9px; width: 3px;',
      '  top: -8px; bottom: -8px; background: ' + ACCENT + '; }',
      '.preview-tile.tt-in-set.tt-set-alt:before { background: ' + ACCENT_ALT + '; }',
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
        if (ev === Events.FRAME_SIZE_CHANGED) {
          // Piskel has just zoomed to fit one frame of the new size.
          cache = {};
          fitSheet();
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
      patchSetExport();
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
