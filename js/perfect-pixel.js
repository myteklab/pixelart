/**
 * perfect-pixel.js — Pixel grid detection and snapping for AI-generated pixel art.
 *
 * JavaScript port of the perfectPixel algorithm (github.com/theamusing/perfectPixel, MIT).
 * Takes an image that looks like pixel art but is not grid aligned (AI generated,
 * upscaled, or photographed pixel art) and recovers the true low-resolution image:
 *   1. Detect the pixel cell size via 2D FFT peak analysis (gradient fallback).
 *   2. Refine each grid line by snapping to local maxima of Sobel gradient sums.
 *   3. Sample each cell into one output pixel (center, median, or majority color).
 *
 * Dependency free. Works on plain {width, height, data} RGBA objects so it runs
 * both in the browser (ImageData) and in Node for testing.
 */
(function (root) {
  'use strict';

  // ── Basic utilities ────────────────────────────────────────────

  /** RGBA image -> grayscale Float32Array (luminance weighted by alpha). */
  function rgbaToGray(img) {
    var n = img.width * img.height;
    var gray = new Float32Array(n);
    var d = img.data;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      var lum = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      gray[i] = lum * (d[o + 3] / 255);
    }
    return gray;
  }

  /** Normalize array values to [a, b] in place. Returns the array. */
  function normalizeMinMax(x, a, b) {
    var mn = Infinity;
    var mx = -Infinity;
    for (var i = 0; i < x.length; i++) {
      if (x[i] < mn) { mn = x[i]; }
      if (x[i] > mx) { mx = x[i]; }
    }
    if (mx - mn < 1e-8) {
      for (i = 0; i < x.length; i++) { x[i] = a; }
      return x;
    }
    var scale = (b - a) / (mx - mn);
    for (i = 0; i < x.length; i++) {
      x[i] = a + (x[i] - mn) * scale;
    }
    return x;
  }

  /**
   * Column sums of |Sobel gx| and row sums of |Sobel gy| for a grayscale
   * image, with reflect padding (matches the reference conv2d).
   * Returns {colSum: Float32Array(W), rowSum: Float32Array(H)}.
   */
  function sobelGradientSums(gray, W, H) {
    var colSum = new Float32Array(W);
    var rowSum = new Float32Array(H);
    // reflect index (numpy pad mode "reflect": edge not repeated)
    function rx(x) { return x < 0 ? -x : (x >= W ? 2 * W - 2 - x : x); }
    function ry(y) { return y < 0 ? -y : (y >= H ? 2 * H - 2 - y : y); }
    for (var y = 0; y < H; y++) {
      var ym = ry(y - 1) * W;
      var y0 = y * W;
      var yp = ry(y + 1) * W;
      for (var x = 0; x < W; x++) {
        var xm = rx(x - 1);
        var xp = rx(x + 1);
        var tl = gray[ym + xm]; var tc = gray[ym + x]; var tr = gray[ym + xp];
        var ml = gray[y0 + xm];                        var mr = gray[y0 + xp];
        var bl = gray[yp + xm]; var bc = gray[yp + x]; var br = gray[yp + xp];
        var gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        var gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
        colSum[x] += Math.abs(gx);
        rowSum[y] += Math.abs(gy);
      }
    }
    return { colSum: colSum, rowSum: rowSum };
  }

  /** In-place iterative radix-2 FFT. re/im are Float64Array, length power of 2. */
  function fft1d(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) { j ^= bit; }
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang);
      var wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cwr = 1;
        var cwi = 0;
        for (j = 0; j < len / 2; j++) {
          var ur = re[i + j];
          var ui = im[i + j];
          var vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
          var vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
          re[i + j] = ur + vr;
          im[i + j] = ui + vi;
          re[i + j + len / 2] = ur - vr;
          im[i + j + len / 2] = ui - vi;
          var nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
    }
  }

  function largestPow2NotAbove(n) {
    var p = 1;
    while (p * 2 <= n) { p *= 2; }
    return p;
  }

  /**
   * Row and column sums of the (shifted, log-inverted, normalized) 2D FFT
   * magnitude of a centered power-of-two crop of the grayscale image.
   * Returns {rowSum, colSum, cropW, cropH} or null for degenerate sizes.
   */
  function fftProjections(gray, W, H, maxCrop) {
    var Wc = Math.min(largestPow2NotAbove(W), maxCrop);
    var Hc = Math.min(largestPow2NotAbove(H), maxCrop);
    if (Wc < 16 || Hc < 16) { return null; }
    var offX = Math.floor((W - Wc) / 2);
    var offY = Math.floor((H - Hc) / 2);

    // 2D FFT: rows then columns, on the cropped region.
    var re = new Float64Array(Wc * Hc);
    var im = new Float64Array(Wc * Hc);
    var y;
    var x;
    for (y = 0; y < Hc; y++) {
      var src = (y + offY) * W + offX;
      var dst = y * Wc;
      for (x = 0; x < Wc; x++) { re[dst + x] = gray[src + x]; }
    }
    var rowRe = new Float64Array(Wc);
    var rowIm = new Float64Array(Wc);
    for (y = 0; y < Hc; y++) {
      var off = y * Wc;
      for (x = 0; x < Wc; x++) { rowRe[x] = re[off + x]; rowIm[x] = im[off + x]; }
      fft1d(rowRe, rowIm);
      for (x = 0; x < Wc; x++) { re[off + x] = rowRe[x]; im[off + x] = rowIm[x]; }
    }
    var colRe = new Float64Array(Hc);
    var colIm = new Float64Array(Hc);
    for (x = 0; x < Wc; x++) {
      for (y = 0; y < Hc; y++) { colRe[y] = re[y * Wc + x]; colIm[y] = im[y * Wc + x]; }
      fft1d(colRe, colIm);
      for (y = 0; y < Hc; y++) { re[y * Wc + x] = colRe[y]; im[y * Wc + x] = colIm[y]; }
    }

    // Magnitude transform: 1 - log1p(|F|), fftshifted, normalized to [0,1].
    var mag = new Float32Array(Wc * Hc);
    for (y = 0; y < Hc; y++) {
      var sy = (y + (Hc >> 1)) % Hc; // shifted y reads from unshifted sy
      for (x = 0; x < Wc; x++) {
        var sx = (x + (Wc >> 1)) % Wc;
        var idx = sy * Wc + sx;
        var m = Math.sqrt(re[idx] * re[idx] + im[idx] * im[idx]);
        mag[y * Wc + x] = 1 - Math.log(1 + m);
      }
    }
    normalizeMinMax(mag, 0, 1);

    var rowSum = new Float32Array(Hc);
    var colSum = new Float32Array(Wc);
    for (y = 0; y < Hc; y++) {
      var acc = 0;
      for (x = 0; x < Wc; x++) { acc += mag[y * Wc + x]; }
      rowSum[y] = acc;
    }
    for (x = 0; x < Wc; x++) {
      acc = 0;
      for (y = 0; y < Hc; y++) { acc += mag[y * Wc + x]; }
      colSum[x] = acc;
    }
    return { rowSum: rowSum, colSum: colSum, cropW: Wc, cropH: Hc };
  }

  /** Gaussian smoothing of a 1D signal, kernel size k (matches reference). */
  function smooth1d(v, k) {
    k = Math.floor(k);
    if (k < 3) { return v; }
    if (k % 2 === 0) { k += 1; }
    var sigma = k / 6;
    var half = Math.floor(k / 2);
    var ker = new Float32Array(k);
    var sum = 0;
    var i;
    for (i = 0; i < k; i++) {
      var t = i - half;
      ker[i] = Math.exp(-(t * t) / (2 * sigma * sigma));
      sum += ker[i];
    }
    for (i = 0; i < k; i++) { ker[i] /= (sum + 1e-8); }
    // np.convolve(v, ker, mode="same"): zero padded
    var n = v.length;
    var out = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var acc = 0;
      for (var j = 0; j < k; j++) {
        var s = i + half - j;
        if (s >= 0 && s < n) { acc += v[s] * ker[j]; }
      }
      out[i] = acc;
    }
    return out;
  }

  /**
   * Find the symmetric frequency peak pair around the spectrum center and
   * return half their distance (the grid cell count), or null.
   */
  function detectPeak(proj, peakWidth, relThr, minDist) {
    peakWidth = peakWidth || 6;
    relThr = relThr === undefined ? 0.35 : relThr;
    minDist = minDist || 6;
    var n = proj.length;
    var center = Math.floor(n / 2);
    var mx = -Infinity;
    var i;
    for (i = 0; i < n; i++) { if (proj[i] > mx) { mx = proj[i]; } }
    if (mx < 1e-6) { return null; }
    var thr = mx * relThr;

    var candidates = [];
    for (i = 1; i < n - 1; i++) {
      var isPeak = true;
      for (var j = 1; j < peakWidth; j++) {
        if (i - j < 0 || i + j >= n) { continue; }
        if (proj[i - j + 1] < proj[i - j] || proj[i + j - 1] < proj[i + j]) {
          isPeak = false;
          break;
        }
      }
      if (isPeak && proj[i] >= thr) {
        var leftClimb = 0;
        for (var k = i; k > 0; k--) {
          if (proj[k] > proj[k - 1]) { leftClimb = Math.abs(proj[i] - proj[k - 1]); } else { break; }
        }
        var rightFall = 0;
        for (k = i; k < n - 1; k++) {
          if (proj[k] > proj[k + 1]) { rightFall = Math.abs(proj[i] - proj[k + 1]); } else { break; }
        }
        candidates.push({ index: i, score: Math.max(leftClimb, rightFall) });
      }
    }
    if (candidates.length === 0) { return null; }

    var left = candidates.filter(function (c) {
      return c.index < center - minDist && c.index > center * 0.25;
    });
    var right = candidates.filter(function (c) {
      return c.index > center + minDist && c.index < center * 1.75;
    });
    if (left.length === 0 || right.length === 0) { return null; }
    left.sort(function (a, b) { return b.score - a.score; });
    right.sort(function (a, b) { return b.score - a.score; });
    return Math.abs(right[0].index - left[0].index) / 2;
  }

  /** FFT based estimate of (gridW, gridH) for the full image, or null. */
  function estimateGridFft(gray, W, H, peakWidth, maxCrop) {
    var proj = fftProjections(gray, W, H, maxCrop);
    if (!proj) { return null; }
    var rowSum = smooth1d(normalizeMinMax(proj.rowSum, 0, 1), 17);
    var colSum = smooth1d(normalizeMinMax(proj.colSum, 0, 1), 17);
    var scaleRow = detectPeak(rowSum, peakWidth);
    var scaleCol = detectPeak(colSum, peakWidth);
    if (scaleRow === null || scaleCol === null || scaleCol <= 0) { return null; }
    // Scale crop-relative cell counts back to the full image size.
    return { gridW: scaleCol * (W / proj.cropW), gridH: scaleRow * (H / proj.cropH) };
  }

  /** Gradient based fallback estimate of (gridW, gridH), or null. */
  function estimateGridGradient(gray, W, H, relThr) {
    relThr = relThr === undefined ? 0.2 : relThr;
    var sums = sobelGradientSums(gray, W, H);
    var gradX = sums.colSum;
    var gradY = sums.rowSum;

    function findPeaks(arr, thr, minInterval) {
      var peaks = [];
      for (var i = 1; i < arr.length - 1; i++) {
        if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] && arr[i] >= thr) {
          if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minInterval) {
            peaks.push(i);
          }
        }
      }
      return peaks;
    }
    function maxOf(arr) {
      var m = -Infinity;
      for (var i = 0; i < arr.length; i++) { if (arr[i] > m) { m = arr[i]; } }
      return m;
    }
    function median(arr) {
      var s = arr.slice().sort(function (a, b) { return a - b; });
      var mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    var peakX = findPeaks(gradX, relThr * maxOf(gradX), 4);
    var peakY = findPeaks(gradY, relThr * maxOf(gradY), 4);
    if (peakX.length < 4 || peakY.length < 4) { return null; }

    var intervalsX = [];
    var intervalsY = [];
    var i;
    for (i = 1; i < peakX.length; i++) { intervalsX.push(peakX[i] - peakX[i - 1]); }
    for (i = 1; i < peakY.length; i++) { intervalsY.push(peakY[i] - peakY[i - 1]); }
    return {
      gridW: Math.round(W / median(intervalsX)),
      gridH: Math.round(H / median(intervalsY))
    };
  }

  /**
   * Detect the pixel grid dimensions of an RGBA image.
   * Returns {gridW, gridH, pixelSize} or null if no grid could be found.
   */
  function detectGridScale(img, opts) {
    opts = opts || {};
    var peakWidth = opts.peakWidth || 6;
    var maxRatio = opts.maxRatio || 1.5;
    var minSize = opts.minSize || 4;
    var maxPixelSize = opts.maxPixelSize || 20;
    var maxCrop = opts.maxCrop || 1024;

    var W = img.width;
    var H = img.height;
    var gray = rgbaToGray(img);

    var est = estimateGridFft(gray, W, H, peakWidth, maxCrop);
    if (est) {
      var psx = W / est.gridW;
      var psy = H / est.gridH;
      if (Math.min(psx, psy) < minSize || Math.max(psx, psy) > maxPixelSize ||
          psx / psy > maxRatio || psy / psx > maxRatio) {
        est = estimateGridGradient(gray, W, H);
      }
    } else {
      est = estimateGridGradient(gray, W, H);
    }
    if (!est || !est.gridW || !est.gridH) { return null; }

    var pixelSizeX = W / est.gridW;
    var pixelSizeY = H / est.gridH;
    var pixelSize;
    if (pixelSizeX / pixelSizeY > maxRatio || pixelSizeY / pixelSizeX > maxRatio) {
      pixelSize = Math.min(pixelSizeX, pixelSizeY);
    } else {
      pixelSize = (pixelSizeX + pixelSizeY) / 2;
    }
    return {
      gridW: Math.round(W / pixelSize),
      gridH: Math.round(H / pixelSize),
      pixelSize: pixelSize
    };
  }

  // ── Grid refinement ────────────────────────────────────────────

  /** Snap a grid line near `origin` to the strongest gradient peak in range. */
  function findBestGrid(origin, rangeMin, rangeMax, gradSum) {
    var best = Math.round(origin);
    var mx = -Infinity;
    var i;
    for (i = 0; i < gradSum.length; i++) { if (gradSum[i] > mx) { mx = gradSum[i]; } }
    if (mx < 1e-6) { return best; }
    var bestVal = -Infinity;
    var found = false;
    for (i = -Math.round(rangeMin); i <= Math.round(rangeMax); i++) {
      var c = Math.round(origin + i);
      if (c <= 0 || c >= gradSum.length - 1) { continue; }
      if (gradSum[c] > gradSum[c - 1] && gradSum[c] > gradSum[c + 1] && gradSum[c] >= 0) {
        if (gradSum[c] > bestVal) { bestVal = gradSum[c]; best = c; found = true; }
      }
    }
    return found ? best : Math.round(origin);
  }

  /** Compute refined grid line coordinates. Returns {xCoords, yCoords}. */
  function refineGrids(img, gridX, gridY, refineIntensity) {
    refineIntensity = refineIntensity === undefined ? 0.25 : refineIntensity;
    var W = img.width;
    var H = img.height;
    var cellW = W / gridX;
    var cellH = H / gridY;

    var gray = rgbaToGray(img);
    var sums = sobelGradientSums(gray, W, H);
    var gradX = sums.colSum;
    var gradY = sums.rowSum;

    var xCoords = [];
    var yCoords = [];
    var v;

    var anchorX = findBestGrid(W / 2, cellW, cellW, gradX);
    v = anchorX;
    while (v < W + cellW / 2) {
      v = findBestGrid(v, cellW * refineIntensity, cellW * refineIntensity, gradX);
      xCoords.push(v);
      v += cellW;
    }
    v = anchorX - cellW;
    while (v > -cellW / 2) {
      v = findBestGrid(v, cellW * refineIntensity, cellW * refineIntensity, gradX);
      xCoords.push(v);
      v -= cellW;
    }

    var anchorY = findBestGrid(H / 2, cellH, cellH, gradY);
    v = anchorY;
    while (v < H + cellH / 2) {
      v = findBestGrid(v, cellH * refineIntensity, cellH * refineIntensity, gradY);
      yCoords.push(v);
      v += cellH;
    }
    v = anchorY - cellH;
    while (v > -cellH / 2) {
      v = findBestGrid(v, cellH * refineIntensity, cellH * refineIntensity, gradY);
      yCoords.push(v);
      v -= cellH;
    }

    xCoords.sort(function (a, b) { return a - b; });
    yCoords.sort(function (a, b) { return a - b; });
    return { xCoords: xCoords, yCoords: yCoords };
  }

  // ── Cell sampling ──────────────────────────────────────────────

  function makeImage(w, h) {
    var Arr = typeof Uint8ClampedArray !== 'undefined' ? Uint8ClampedArray : Uint8Array;
    return { width: w, height: h, data: new Arr(w * h * 4) };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Sample the pixel at the center of each cell. */
  function sampleCenter(img, xCoords, yCoords) {
    var W = img.width;
    var H = img.height;
    var nx = xCoords.length - 1;
    var ny = yCoords.length - 1;
    var out = makeImage(nx, ny);
    for (var j = 0; j < ny; j++) {
      var cy = clamp(Math.floor((yCoords[j] + yCoords[j + 1]) * 0.5), 0, H - 1);
      for (var i = 0; i < nx; i++) {
        var cx = clamp(Math.floor((xCoords[i] + xCoords[i + 1]) * 0.5), 0, W - 1);
        var s = (cy * W + cx) * 4;
        var d = (j * nx + i) * 4;
        out.data[d] = img.data[s];
        out.data[d + 1] = img.data[s + 1];
        out.data[d + 2] = img.data[s + 2];
        out.data[d + 3] = img.data[s + 3];
      }
    }
    return out;
  }

  function cellBounds(coords, idx, limit) {
    var a = clamp(Math.floor(coords[idx]), 0, limit);
    var b = clamp(Math.floor(coords[idx + 1]), 0, limit);
    if (b <= a) { b = Math.min(a + 1, limit); }
    return [a, b];
  }

  /** Per-channel median of each cell. */
  function sampleMedian(img, xCoords, yCoords) {
    var W = img.width;
    var H = img.height;
    var nx = xCoords.length - 1;
    var ny = yCoords.length - 1;
    var out = makeImage(nx, ny);
    var vals = [[], [], [], []];
    for (var j = 0; j < ny; j++) {
      var yb = cellBounds(yCoords, j, H);
      for (var i = 0; i < nx; i++) {
        var xb = cellBounds(xCoords, i, W);
        var c;
        for (c = 0; c < 4; c++) { vals[c].length = 0; }
        for (var y = yb[0]; y < yb[1]; y++) {
          for (var x = xb[0]; x < xb[1]; x++) {
            var s = (y * W + x) * 4;
            vals[0].push(img.data[s]);
            vals[1].push(img.data[s + 1]);
            vals[2].push(img.data[s + 2]);
            vals[3].push(img.data[s + 3]);
          }
        }
        var d = (j * nx + i) * 4;
        for (c = 0; c < 4; c++) {
          var arr = vals[c];
          if (arr.length === 0) { out.data[d + c] = 0; continue; }
          arr.sort(function (a, b) { return a - b; });
          var mid = Math.floor(arr.length / 2);
          var med = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
          out.data[d + c] = Math.round(med);
        }
      }
    }
    return out;
  }

  /** Deterministic xorshift32 RNG so results are reproducible. */
  function makeRng(seed) {
    var state = seed >>> 0 || 0x9e3779b9;
    return function () {
      state ^= state << 13; state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5; state >>>= 0;
      return state / 4294967296;
    };
  }

  /** Dominant color of each cell via a tiny 2-means clustering (RGBA). */
  function sampleMajority(img, xCoords, yCoords, maxSamples, iters) {
    maxSamples = maxSamples || 128;
    iters = iters || 6;
    var rng = makeRng(1);
    var W = img.width;
    var H = img.height;
    var nx = xCoords.length - 1;
    var ny = yCoords.length - 1;
    var out = makeImage(nx, ny);
    var cell = [];
    for (var j = 0; j < ny; j++) {
      var yb = cellBounds(yCoords, j, H);
      for (var i = 0; i < nx; i++) {
        var xb = cellBounds(xCoords, i, W);
        cell.length = 0;
        for (var y = yb[0]; y < yb[1]; y++) {
          for (var x = xb[0]; x < xb[1]; x++) {
            var s = (y * W + x) * 4;
            cell.push([img.data[s], img.data[s + 1], img.data[s + 2], img.data[s + 3]]);
          }
        }
        var d = (j * nx + i) * 4;
        if (cell.length === 0) {
          out.data[d] = out.data[d + 1] = out.data[d + 2] = out.data[d + 3] = 0;
          continue;
        }
        var pts = cell;
        if (cell.length > maxSamples) {
          pts = [];
          for (var t = 0; t < maxSamples; t++) {
            pts.push(cell[Math.floor(rng() * cell.length)]);
          }
        }
        var result = twoMeansDominant(pts, iters);
        out.data[d] = Math.round(clamp(result[0], 0, 255));
        out.data[d + 1] = Math.round(clamp(result[1], 0, 255));
        out.data[d + 2] = Math.round(clamp(result[2], 0, 255));
        out.data[d + 3] = Math.round(clamp(result[3], 0, 255));
      }
    }
    return out;
  }

  function dist2(a, b) {
    var s = 0;
    for (var c = 0; c < 4; c++) { var t = a[c] - b[c]; s += t * t; }
    return s;
  }

  function twoMeansDominant(pts, iters) {
    var n = pts.length;
    var c0 = pts[0].slice();
    // farthest point from c0 seeds the second cluster
    var far = 0;
    var farD = -1;
    var i;
    for (i = 0; i < n; i++) {
      var dd = dist2(pts[i], c0);
      if (dd > farD) { farD = dd; far = i; }
    }
    var c1 = pts[far].slice();
    var mask = new Uint8Array(n);
    for (var it = 0; it < iters; it++) {
      var sum0 = [0, 0, 0, 0];
      var sum1 = [0, 0, 0, 0];
      var n0 = 0;
      var n1 = 0;
      for (i = 0; i < n; i++) {
        var inC1 = dist2(pts[i], c1) < dist2(pts[i], c0);
        mask[i] = inC1 ? 1 : 0;
        var acc = inC1 ? sum1 : sum0;
        for (var c = 0; c < 4; c++) { acc[c] += pts[i][c]; }
        if (inC1) { n1++; } else { n0++; }
      }
      if (n0 > 0) { for (c = 0; c < 4; c++) { c0[c] = sum0[c] / n0; } }
      if (n1 > 0) { for (c = 0; c < 4; c++) { c1[c] = sum1[c] / n1; } }
    }
    var cnt1 = 0;
    for (i = 0; i < n; i++) { cnt1 += mask[i]; }
    return cnt1 >= n - cnt1 ? c1 : c0;
  }

  // ── Square fixup ───────────────────────────────────────────────

  /** If output is off-square by one, trim or duplicate one row/column. */
  function fixSquareImage(img) {
    var w = img.width;
    var h = img.height;
    if (Math.abs(w - h) !== 1) { return img; }
    var out;
    var y;
    var row;
    if (w > h) {
      if (w % 2 === 1) {
        // remove last column
        out = makeImage(w - 1, h);
        for (y = 0; y < h; y++) {
          out.data.set(img.data.subarray(y * w * 4, (y * w + w - 1) * 4), y * (w - 1) * 4);
        }
      } else {
        // duplicate first row
        out = makeImage(w, h + 1);
        row = img.data.subarray(0, w * 4);
        out.data.set(row, 0);
        out.data.set(img.data, w * 4);
      }
    } else {
      if (h % 2 === 1) {
        // remove last row
        out = makeImage(w, h - 1);
        out.data.set(img.data.subarray(0, w * (h - 1) * 4), 0);
      } else {
        // duplicate first column
        out = makeImage(w + 1, h);
        for (y = 0; y < h; y++) {
          var srcOff = y * w * 4;
          var dstOff = y * (w + 1) * 4;
          out.data.set(img.data.subarray(srcOff, srcOff + 4), dstOff);
          out.data.set(img.data.subarray(srcOff, srcOff + w * 4), dstOff + 4);
        }
      }
    }
    return out;
  }

  // ── Main entry points ──────────────────────────────────────────

  /**
   * Detect the grid and resample the image to true pixel resolution.
   *
   * @param {Object} img {width, height, data} RGBA
   * @param {Object} opts
   *        - sampleMethod: 'majority' | 'center' | 'median' (default 'majority')
   *        - gridSize: [gridW, gridH] to override auto detection
   *        - refineIntensity: grid line search range as a cell fraction (default 0.25)
   *        - fixSquare: square up off-by-one outputs (default true)
   * @returns {Object|null} {width, height, image} or null when no grid detected
   */
  function getPerfectPixel(img, opts) {
    opts = opts || {};
    var sampleMethod = opts.sampleMethod || 'majority';
    var refineIntensity = opts.refineIntensity === undefined ? 0.25 : opts.refineIntensity;
    var fixSquare = opts.fixSquare === undefined ? true : opts.fixSquare;

    var gridW;
    var gridH;
    if (opts.gridSize) {
      gridW = Math.round(opts.gridSize[0]);
      gridH = Math.round(opts.gridSize[1]);
    } else {
      var detected = detectGridScale(img, opts);
      if (!detected) { return null; }
      gridW = detected.gridW;
      gridH = detected.gridH;
    }
    if (!(gridW > 0) || !(gridH > 0)) { return null; }

    var grids = refineGrids(img, gridW, gridH, refineIntensity);
    if (grids.xCoords.length < 2 || grids.yCoords.length < 2) { return null; }

    var scaled;
    if (sampleMethod === 'center') {
      scaled = sampleCenter(img, grids.xCoords, grids.yCoords);
    } else if (sampleMethod === 'median') {
      scaled = sampleMedian(img, grids.xCoords, grids.yCoords);
    } else {
      scaled = sampleMajority(img, grids.xCoords, grids.yCoords);
    }

    if (fixSquare) {
      scaled = fixSquareImage(scaled);
    }
    return { width: scaled.width, height: scaled.height, image: scaled };
  }

  // ── Browser conveniences ───────────────────────────────────────

  /** HTMLImageElement or canvas -> plain {width, height, data} RGBA object. */
  function toRgba(source) {
    var w = source.naturalWidth || source.width;
    var h = source.naturalHeight || source.height;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    var data = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: data.data };
  }

  /** Detect the grid of an image/canvas. Returns {gridW, gridH, pixelSize} or null. */
  function detect(source, opts) {
    return detectGridScale(toRgba(source), opts);
  }

  /**
   * Snap an image/canvas to its detected (or given) pixel grid.
   * Returns {width, height, canvas} or null.
   */
  function snapToCanvas(source, opts) {
    var result = getPerfectPixel(toRgba(source), opts);
    if (!result) { return null; }
    var canvas = document.createElement('canvas');
    canvas.width = result.width;
    canvas.height = result.height;
    var ctx = canvas.getContext('2d');
    var imageData = ctx.createImageData(result.width, result.height);
    imageData.data.set(result.image.data);
    ctx.putImageData(imageData, 0, 0);
    return { width: result.width, height: result.height, canvas: canvas };
  }

  var PerfectPixel = {
    getPerfectPixel: getPerfectPixel,
    detectGridScale: detectGridScale,
    refineGrids: refineGrids,
    detect: typeof document !== 'undefined' ? detect : null,
    snapToCanvas: typeof document !== 'undefined' ? snapToCanvas : null
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PerfectPixel;
  }
  root.PerfectPixel = PerfectPixel;
})(typeof window !== 'undefined' ? window : this);
