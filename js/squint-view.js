/**
 * squint-view.js - "Squint at the blend" for transition mode.
 *
 * Pixel artists check a dither by squinting or stepping back: a good one
 * reads as an in-between color, a bad one stays speckled or shows a hard
 * step. One button in the transition panel does that to the 3x3 sheet on
 * screen, and puts two strips beside it: the average color of every pixel
 * row down the middle column of tiles (T, C, B), and of every pixel column
 * across the middle row (L, C, R). A strip set is one column, so it gets
 * the down strip only, the full height of the gradient. A smooth strip is a smooth blend; a jump
 * points at the row to fix.
 *
 * The blur is a 1-2-1 average in art pixels, drawn as crisp blocks, not a
 * CSS filter (missing on iPad Safari). It flattens a dither into its tone
 * but leaves a hard edge hard, so the two can be told apart. Where a strip
 * changes color in one hard step, a mark points at it.
 *
 * Display only. Nothing is written to the project. A press on the canvas
 * turns it off and paints nothing, so nobody paints blind.
 *
 * Add-on pattern as in transition-tiles.js; reads the sheet through
 * window.PixelArtTransition.
 */
(function () {
  'use strict';

  // No DOM and no pskl here, so Node can test it.

  // A 1-2-1 average across, then down. Any pattern that repeats every two
  // pixels (the 25, 50 and 75 Mix levels, lines across, up and down) comes
  // out as one flat tone; the 12 and 88 levels repeat every four across and
  // keep a faint texture. A hard edge stays a sharp two-pixel step. A wider blur
  // makes a hard edge and a dithered one look alike, which defeats the
  // point. Colors are weighted by alpha so see-through pixels do not drag
  // their neighbors toward black.
  function blur(src, w, h) {
    var K = [1, 2, 1];
    var pass = function (from, horiz) {
      var to = new Float32Array(w * h * 4);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var r = 0;
          var g = 0;
          var b = 0;
          var a = 0;
          var n = 0;
          for (var k = -1; k <= 1; k++) {
            var xx = horiz ? x + k : x;
            var yy = horiz ? y : y + k;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
              continue;
            }
            var i = (yy * w + xx) * 4;
            var wa = from[i + 3] * K[k + 1];
            r += from[i] * wa;
            g += from[i + 1] * wa;
            b += from[i + 2] * wa;
            a += wa;
            n += K[k + 1];
          }
          var o = (y * w + x) * 4;
          if (a) {
            to[o] = r / a;
            to[o + 1] = g / a;
            to[o + 2] = b / a;
            to[o + 3] = a / n;
          }
        }
      }
      return to;
    };
    return new Uint8ClampedArray(pass(pass(src, true), false));
  }

  // One [r, g, b, a] per row, averaged over columns from..to-1 (or per
  // column over rows from..to-1 when across is false). a is 0..1.
  function strip(src, w, h, across, from, to) {
    var out = [];
    var len = across ? h : w;
    for (var k = 0; k < len; k++) {
      var r = 0;
      var g = 0;
      var b = 0;
      var a = 0;
      for (var m = from; m < to; m++) {
        var i = across ? (k * w + m) * 4 : (m * w + k) * 4;
        var pa = src[i + 3];
        r += src[i] * pa;
        g += src[i + 1] * pa;
        b += src[i + 2] * pa;
        a += pa;
      }
      out.push(a ? [Math.round(r / a), Math.round(g / a), Math.round(b / a), a / (to - from) / 255] : [0, 0, 0, 0]);
    }
    return out;
  }

  function dist(p, q) {
    var dr = p[0] - q[0];
    var dg = p[1] - q[1];
    var db = p[2] - q[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // Where a strip changes color in one hard step. Measured as color
  // distance, not brightness: grass and dirt are often the same lightness
  // in different hues. Tuned on a grass/dirt set: across the 1-2-1 blur a
  // 75/50/25 dither's steepest step is 37% of the whole change, a hard edge
  // 49%. Empty (undrawn) stretches never count.
  var JUMP = 0.43;
  var JUMP_MIN = 24;

  function jumps(st) {
    var range = 0;
    var i;
    var j;
    for (i = 0; i < st.length; i++) {
      for (j = i + 1; j < st.length; j++) {
        if (st[i][3] >= 0.5 && st[j][3] >= 0.5) {
          range = Math.max(range, dist(st[i], st[j]));
        }
      }
    }
    var out = [];
    if (range < JUMP_MIN) {
      return out;
    }
    for (i = 1; i < st.length; i++) {
      if (st[i][3] >= 0.5 && st[i - 1][3] >= 0.5 && dist(st[i], st[i - 1]) > JUMP * range) {
        out.push(i);
      }
    }
    return out;
  }

  var api = { blur: blur, strip: strip, jumps: jumps };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window === 'undefined') {
    return;
  }
  window.PixelArtSquint = api;

  var POLL_INTERVAL = 200;
  var MAX_POLLS = 100;
  var pollCount = 0;
  var ACCENT = '#00f900';
  var BACKDROP = '#5a5a5a';
  var STRIP_GAP = 6;
  var STRIP_SIZE = 14;
  var JUMP_COLOR = '#ffb020';
  var ICON_EYE = '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/>' +
    '<circle cx="8" cy="8" r="2"/></svg>';

  var on = false;
  var view = null;
  var button = null;
  var lastKey = '';
  var blurred = null;
  var stripDown = null;
  var stripAcross = null;
  var shape = null;
  var jumpsDown = [];
  var jumpsAcross = [];
  var raf = 0;

  function sheet() {
    var t = window.PixelArtTransition;
    return t && t.active && t.active() ? t : null;
  }

  // The set's tiles as one RGBA picture, laid out as on the sheet.
  function readSheet(t, w, h, sh) {
    var W = sh.cols * w;
    var H = sh.rows * h;
    var px = new Uint8ClampedArray(W * H * 4);
    var base = t.base();
    for (var i = 0; i < sh.size; i++) {
      var cv = t.tileCanvas(base + i);
      if (!cv) {
        continue;
      }
      var data = cv.getContext('2d').getImageData(0, 0, w, h).data;
      var ox = (i % sh.cols) * w;
      var oy = Math.floor(i / sh.cols) * h;
      for (var y = 0; y < h; y++) {
        px.set(data.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * W + ox) * 4);
      }
    }
    return { px: px, W: W, H: H };
  }

  function rebuild(t, w, h) {
    var sh = t.shape();
    shape = sh;
    var s = readSheet(t, w, h, sh);
    var soft = blur(s.px, s.W, s.H);
    var img = new ImageData(soft, s.W, s.H);
    blurred = document.createElement('canvas');
    blurred.width = s.W;
    blurred.height = s.H;
    blurred.getContext('2d').putImageData(img, 0, 0);
    // Down the middle column, and across the middle row when there is one
    // to cross (a strip is a single column, so it only gets the down strip).
    var mc = Math.floor(sh.cols / 2);
    var mr = Math.floor(sh.rows / 2);
    stripDown = strip(soft, s.W, s.H, true, mc * w, (mc + 1) * w);
    stripAcross = sh.cols >= 3 ? strip(soft, s.W, s.H, false, mr * h, (mr + 1) * h) : null;
    jumpsDown = jumps(stripDown);
    jumpsAcross = stripAcross ? jumps(stripAcross) : [];
  }

  function rgba(c) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + c[3] + ')';
  }

  function draw() {
    raf = 0;
    if (!on) {
      return;
    }
    var t = sheet();
    if (!t) {
      setOn(false);
      return;
    }
    var pc = pskl.app.piskelController;
    var dc = pskl.app.drawingController;
    var host = view.parentNode;
    var w = pc.getWidth();
    var h = pc.getHeight();
    var z = dc.renderer.getZoom();
    var off = dc.getOffset();
    var key = t.sheetHash() + '|' + w + 'x' + h + '|' + z + '|' + off.x + ',' + off.y + '|' +
      host.clientWidth + 'x' + host.clientHeight;
    if (key !== lastKey) {
      lastKey = key;
      rebuild(t, w, h);
      paint(pc, dc, host, w, h, z);
    }
    raf = requestAnimationFrame(draw);
  }

  function paint(pc, dc, host, w, h, z) {
    if (view.width !== host.clientWidth || view.height !== host.clientHeight) {
      view.width = host.clientWidth;
      view.height = host.clientHeight;
    }
    var ctx = view.getContext('2d');
    ctx.clearRect(0, 0, view.width, view.height);
    var rect = host.getBoundingClientRect();
    var rel = pc.getCurrentFrameIndex() - sheet().base();
    // getScreenCoordinates answers with the center of a pixel, in page space.
    var c = dc.getScreenCoordinates(-(rel % shape.cols) * w, -Math.floor(rel / shape.cols) * h);
    var left = c.x - z / 2 - rect.left - window.pageXOffset;
    var top = c.y - z / 2 - rect.top - window.pageYOffset;
    var W = shape.cols * w * z;
    var H = shape.rows * h * z;

    // A neutral backdrop, so see-through areas read as nothing rather than
    // as the checkerboard and art underneath.
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(left, top, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(blurred, left, top, W, H);

    var sx = left + W + STRIP_GAP;
    var sy = top + H + STRIP_GAP;
    var k;
    ctx.fillStyle = '#111';
    ctx.fillRect(sx - 1, top - 1, STRIP_SIZE + 2, H + 2);
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(sx, top, STRIP_SIZE, H);
    for (k = 0; k < stripDown.length; k++) {
      ctx.fillStyle = rgba(stripDown[k]);
      ctx.fillRect(sx, top + k * z, STRIP_SIZE, Math.ceil(z));
    }
    if (stripAcross) {
      ctx.fillStyle = '#111';
      ctx.fillRect(left - 1, sy - 1, W + 2, STRIP_SIZE + 2);
      ctx.fillStyle = BACKDROP;
      ctx.fillRect(left, sy, W, STRIP_SIZE);
      for (k = 0; k < stripAcross.length; k++) {
        ctx.fillStyle = rgba(stripAcross[k]);
        ctx.fillRect(left + k * z, sy, Math.ceil(z), STRIP_SIZE);
      }
    }
    // Tile edges, so a jump can be read against the seam it sits on.
    ctx.fillStyle = '#111';
    for (k = 1; k < shape.rows; k++) {
      ctx.fillRect(sx - 3, top + k * h * z - 1, 3, 2);
    }
    for (k = 1; stripAcross && k < shape.cols; k++) {
      ctx.fillRect(left + k * w * z - 1, sy - 3, 2, 3);
    }
    // Hard steps: an arrow just outside each strip, on the step.
    ctx.fillStyle = JUMP_COLOR;
    jumpsDown.forEach(function (j) {
      arrow(ctx, sx + STRIP_SIZE + 2, top + j * z, 'left');
    });
    jumpsAcross.forEach(function (j) {
      arrow(ctx, left + j * z, sy + STRIP_SIZE + 2, 'up');
    });
  }

  function arrow(ctx, x, y, points) {
    ctx.beginPath();
    if (points === 'left') {
      ctx.moveTo(x, y);
      ctx.lineTo(x + 8, y - 6);
      ctx.lineTo(x + 8, y + 6);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 6, y + 8);
      ctx.lineTo(x + 6, y + 8);
    }
    ctx.closePath();
    ctx.fill();
  }

  function setOn(value) {
    on = !!value && !!sheet();
    lastKey = '';
    if (view) {
      view.style.display = on ? 'block' : 'none';
    }
    if (button) {
      button.classList.toggle('sq-on', on);
      button.querySelector('span').textContent = on ? 'Stop squinting' : 'Squint at the blend';
    }
    if (on && !raf) {
      raf = requestAnimationFrame(draw);
    }
  }

  function addButton() {
    var actions = document.querySelector('#tt-panel .tt-actions');
    if (!actions || actions.querySelector('.tt-squint')) {
      return !!actions;
    }
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'tt-squint tt-action';
    button.title = 'Blur the sheet the way your eye does from far away. The strips show the average color of ' +
      'each row down the middle tiles and each column across them: smooth strips mean a smooth blend, ' +
      'and an orange arrow marks a hard step. ' +
      'Nothing is changed. Click the canvas to stop.';
    button.innerHTML = ICON_EYE + '<span>Squint at the blend</span>';
    button.addEventListener('click', function () {
      setOn(!on);
    });
    actions.appendChild(button);
    return true;
  }

  function addView() {
    var host = document.getElementById('drawing-canvas-container');
    view = document.createElement('canvas');
    view.className = 'sq-view';
    view.style.display = 'none';
    host.appendChild(view);
    // The press that ends the squint only ends it. The student has not seen
    // where they are about to paint yet.
    var stop = function (evt) {
      if (on && host.contains(evt.target)) {
        setOn(false);
        evt.stopPropagation();
        evt.preventDefault();
      }
    };
    window.addEventListener('mousedown', stop, true);
    window.addEventListener('touchstart', stop, true);
    window.addEventListener('keydown', function (evt) {
      if (on && evt.key === 'Escape') {
        setOn(false);
      }
    });
  }

  function injectStyles() {
    var style = document.createElement('style');
    style.id = 'sq-styles';
    style.textContent = [
      '#drawing-canvas-container .sq-view { position: absolute; left: 0; top: 0; z-index: 20;',
      '  pointer-events: none; }',
      '#tt-panel .tt-squint.sq-on { color: #fff; border-color: ' + ACCENT + '; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function sweep() {
    if (!button || !button.isConnected) {
      button = null;
      addButton();
    }
    if (button) {
      button.disabled = !sheet();
      if (on && !sheet()) {
        setOn(false);
      }
    }
  }

  function waitForPiskel() {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      console.error('[Squint] transition mode not found, squint view disabled');
      return;
    }
    var ready = window.pskl && pskl.app && pskl.app.piskelController && pskl.app.drawingController &&
      pskl.app.drawingController.renderer && window.PixelArtTransition &&
      window.PixelArtTransition.sheetHash && document.getElementById('drawing-canvas-container') &&
      document.querySelector('#tt-panel .tt-actions');
    if (!ready) {
      setTimeout(waitForPiskel, POLL_INTERVAL);
      return;
    }
    injectStyles();
    addView();
    addButton();
    sweep();
    setInterval(sweep, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForPiskel);
  } else {
    waitForPiskel();
  }
})();
