/* Two fingers on the drawing area pinch to zoom and drag to pan.
 *
 * Piskel already draws with one finger: DrawingController listens for
 * touchstart/touchmove/touchend on window. It has no pinch, so a second
 * finger only painted another dot, and with no touch-action on the canvas
 * Safari was free to scroll or zoom the page under a stroke.
 *
 * These listeners sit on the drawing container in the capture phase, so they
 * run before Piskel's window listeners and can keep a gesture from reaching
 * them. A first finger waits HOLD_MS before Piskel sees it: if a second one
 * lands in that time it was a pinch and nothing is drawn. Zoom goes through
 * updateZoom_, the same call the mouse wheel makes, and pan through setOffset.
 */
(function () {
  var HOLD_MS = 80;

  function init() {
    var host = document.getElementById('drawing-canvas-container');
    var dc = window.pskl && pskl.app && pskl.app.drawingController;
    if (!host || !dc) {
      setTimeout(init, 300);
      return;
    }
    host.style.touchAction = 'none';

    var pending = null;   // a first finger Piskel has not been told about yet
    var down = false;     // Piskel has a press open
    var last = null;      // where that finger was last seen
    var pinch = null;

    function centroid(ts) {
      return {
        x: (ts[0].clientX + ts[1].clientX) / 2,
        y: (ts[0].clientY + ts[1].clientY) / 2,
        d: Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY) || 1
      };
    }

    function flush() {
      if (!pending) return;
      clearTimeout(pending.timer);
      var ev = pending.ev;
      pending = null;
      down = true;
      dc.onTouchstart_(ev);
    }

    // Ends Piskel's press where the first finger was, not at the second
    // finger, so a line or shape in progress keeps its end point.
    function endPress() {
      if (!down || !last) return;
      down = false;
      var t = { clientX: last.x, clientY: last.y };
      dc.onTouchend_({
        type: 'touchend', changedTouches: [t], touches: [], clientX: t.clientX, clientY: t.clientY,
        button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
        preventDefault: function () {}, stopPropagation: function () {}
      });
    }

    host.addEventListener('touchstart', function (e) {
      if (e.touches.length >= 2) {
        e.stopPropagation();
        e.preventDefault();
        if (pending) { clearTimeout(pending.timer); pending = null; }
        else if (!pinch) endPress();
        pinch = centroid(e.touches);
        return;
      }
      if (pinch) { e.stopPropagation(); return; }
      var t = e.touches[0];
      last = { x: t.clientX, y: t.clientY };
      e.stopPropagation();
      pending = { ev: e, timer: setTimeout(flush, HOLD_MS) };
    }, true);

    host.addEventListener('touchmove', function (e) {
      if (pinch) {
        e.stopPropagation();
        e.preventDefault();
        if (e.touches.length < 2) return;
        var c = centroid(e.touches);
        var zoom = dc.renderer.getZoom();
        var want = zoom * (c.d / pinch.d);
        if (want !== zoom) dc.updateZoom_((want - zoom) / dc.getZoomStep_(), dc.getSpriteCoordinates(c.x, c.y));
        var off = dc.getOffset();
        zoom = dc.renderer.getZoom();
        dc.setOffset(off.x - (c.x - pinch.x) / zoom, off.y - (c.y - pinch.y) / zoom);
        pinch = c;
        return;
      }
      if (pending) flush();
      var t = e.touches[0];
      if (t) last = { x: t.clientX, y: t.clientY };
    }, true);

    function end(e) {
      if (pinch) {
        e.stopPropagation();
        if (e.touches.length === 0) pinch = null;
        return;
      }
      if (pending) flush();   // a quick tap still draws
      down = false;
    }
    host.addEventListener('touchend', end, true);
    host.addEventListener('touchcancel', end, true);
  }

  init();
})();
