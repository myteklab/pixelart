/**
 * perfect-pixel-import.js — wires PerfectPixel grid snapping into the
 * Piskel import wizard.
 *
 * Adds a "Snap to pixel grid" card to the image import step:
 *   - detects the pixel grid in the background when an image loads and shows
 *     the detected size in the card
 *   - when enabled, the resize fields are filled with the true resolution,
 *     a live snapped preview replaces the import preview, and a dropdown
 *     picks how each pixel's color is chosen (most common / center / median)
 *   - images with no hidden grid (photos, drawings) can still be converted:
 *     the typed size becomes a uniform pixelation grid
 *   - import goes through PerfectPixel instead of a plain resize, reusing
 *     the previewed result when possible
 *
 * Loaded from platform.html after perfect-pixel.js. Polls for the Piskel
 * engine like the platform adapter does. Skipped for animated GIFs, and the
 * stock import path is untouched while the option is off or in spritesheet
 * mode.
 */
(function () {
  'use strict';

  var POLL_INTERVAL = 100;
  var MAX_POLLS = 200;
  var pollCount = 0;

  var EXPLAINER_TEXT = 'Some images look like pixel art but are really fuzzy or uneven up close. ' +
    'This finds the hidden grid and rebuilds the picture with clean, true-size pixels. ' +
    'No grid? Type a size above to pixelate any photo or drawing.';

  var SAMPLE_METHODS = [
    { value: 'majority', label: 'Most common color' },
    { value: 'center', label: 'Center of each cell' },
    { value: 'median', label: 'Median (softens noise)' }
  ];

  var COLOR_LIMITS = [
    { value: '0', label: 'All colors' },
    { value: '8', label: '8' },
    { value: '16', label: '16' },
    { value: '32', label: '32' },
    { value: '64', label: '64' }
  ];

  function waitForPiskel() {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      console.error('[PerfectPixel] Piskel engine not found, grid snapping disabled');
      return;
    }
    var ready = window.PerfectPixel && window.pskl && window.pskl.controller &&
      pskl.controller.dialogs && pskl.controller.dialogs.importwizard &&
      pskl.controller.dialogs.importwizard.steps &&
      pskl.controller.dialogs.importwizard.steps.ImageImport &&
      pskl.utils && pskl.utils.FrameUtils && pskl.model && pskl.model.Piskel;
    if (ready) {
      injectStyles();
      patchImportStep();
    } else {
      setTimeout(waitForPiskel, POLL_INTERVAL);
    }
  }

  function injectStyles() {
    if (document.getElementById('pp-snap-styles')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'pp-snap-styles';
    style.textContent = [
      // The stock import dialog (500x350) has no room for the snap card;
      // give the whole wizard a taller box.
      '#dialog-container.import { height: 540px; margin-top: -270px; }',
      '.import-image-container { overflow-y: auto; }',
      // Full-width feature card below the stock fields.
      '.pp-snap-card { margin: 14px 0 40px 0; padding: 10px 12px; clear: both;',
      '  background: rgba(255, 255, 255, 0.06); border: 1px solid #555; border-radius: 4px; }',
      '.pp-snap-title-row { display: flex; align-items: center; justify-content: space-between; }',
      '.pp-snap-title-row label { display: flex; align-items: center; cursor: pointer; }',
      '.pp-snap-title { font-weight: bold; margin-left: 7px; }',
      '.pp-snap-status { font-size: 12px; color: gold; margin-left: 10px; text-align: right; }',
      '.pp-snap-explainer { font-size: 12px; opacity: 0.7; line-height: 1.5; margin: 6px 0 0 0; }',
      '.pp-snap-method-row { margin-top: 8px; font-size: 12px; display: flex;',
      '  align-items: center; flex-wrap: wrap; gap: 4px 18px; }',
      '.pp-snap-method-row select { font-size: 12px; margin-left: 6px; }',
      '.pp-snap-option { display: flex; align-items: center; }',
      // Piskel styles ".import-section-preview canvas" as absolute (its grid
      // overlay); ours must stay in the flex flow to center in the box.
      '.import-section-preview canvas.pp-snap-preview-canvas { position: static;',
      '  image-rendering: pixelated; max-width: 100%; max-height: 100%; }',
      '.pp-snap-preview-caption { position: absolute; bottom: 2px; left: 0; right: 0;',
      '  text-align: center; font-size: 10px; opacity: 0.8;',
      '  text-shadow: 0 0 3px #000, 0 0 3px #000; pointer-events: none; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function patchImportStep() {
    var ImageImport = pskl.controller.dialogs.importwizard.steps.ImageImport;
    var originalInit = ImageImport.prototype.init;
    var originalOnImageLoaded = ImageImport.prototype.onImageLoaded_;
    var originalCreatePiskel = ImageImport.prototype.createPiskelFromImage;

    ImageImport.prototype.init = function (file) {
      originalInit.call(this, file);
      this.pixelSnapDetected_ = null;
      this.pixelSnapSavedFields_ = null;
      this.pixelSnapCache_ = {};
      this.pixelSnapJob_ = null;
      this.pixelSnapDebounce_ = null;
      injectSnapUi(this);
    };

    ImageImport.prototype.onImageLoaded_ = function (image) {
      originalOnImageLoaded.call(this, image);
      if (!this.pixelSnapCheckbox_) {
        return;
      }
      // Animated GIFs keep their frames, grid snapping does not apply.
      if (this.file_ && this.file_.type === 'image/gif') {
        this.pixelSnapSection_.style.display = 'none';
        return;
      }
      var w = image.naturalWidth || image.width;
      var h = image.naturalHeight || image.height;
      if (w * h > 4096 * 4096) {
        this.setPixelSnapStatus_('image too large');
        this.pixelSnapCheckbox_.disabled = true;
        return;
      }
      this.setPixelSnapStatus_('analyzing…');
      var self = this;
      // Detection takes up to a couple of seconds on large images, keep the
      // dialog responsive by deferring it off the current event.
      setTimeout(function () {
        var detected = null;
        try {
          detected = window.PerfectPixel.detect(image);
        } catch (e) {
          console.error('[PerfectPixel] detection failed', e);
        }
        // The dialog may have been closed or a new image chosen meanwhile.
        if (self.importedImage_ !== image || !self.pixelSnapStatus_) {
          return;
        }
        self.pixelSnapDetected_ = detected;
        if (detected) {
          self.setPixelSnapStatus_('detected ' + detected.gridW + '×' + detected.gridH);
          if (self.pixelSnapCheckbox_.checked) {
            self.applyDetectedSize_();
            self.updateSnapPreview_();
          }
        } else {
          self.setPixelSnapStatus_('no grid found');
          if (self.pixelSnapCheckbox_.checked) {
            self.updateSnapPreview_();
          }
        }
      }, 20);
    };

    ImageImport.prototype.setPixelSnapStatus_ = function (text) {
      if (this.pixelSnapStatus_) {
        this.pixelSnapStatus_.textContent = text;
      }
    };

    ImageImport.prototype.applyDetectedSize_ = function () {
      if (this.pixelSnapDetected_) {
        this.resizeWidth.value = this.pixelSnapDetected_.gridW;
        this.resizeHeight.value = this.pixelSnapDetected_.gridH;
      }
    };

    ImageImport.prototype.getSnapMethod_ = function () {
      return (this.pixelSnapMethod_ && this.pixelSnapMethod_.value) || 'majority';
    };

    ImageImport.prototype.getSnapMaxColors_ = function () {
      return parseInt((this.pixelSnapColors_ && this.pixelSnapColors_.value) || '0', 10) || 0;
    };

    /** Grid size from the resize fields, or null when they cover the image 1:1. */
    ImageImport.prototype.getSnapGrid_ = function () {
      var gridW = parseInt(this.resizeWidth.value, 10);
      var gridH = parseInt(this.resizeHeight.value, 10);
      if (!(gridW > 0) || !(gridH > 0)) {
        return null;
      }
      var image = this.importedImage_;
      if (image && gridW >= (image.naturalWidth || image.width) &&
          gridH >= (image.naturalHeight || image.height)) {
        return null;
      }
      return [gridW, gridH];
    };

    /**
     * Snap options for the current state. Grid line refinement and the square
     * fixup only run while the fields still hold the detected size; a size the
     * user typed themselves (or any grid-less image) gets an exact uniform
     * grid, so the number they type is the size they get.
     */
    ImageImport.prototype.getSnapOptions_ = function (grid) {
      var opts = { sampleMethod: this.getSnapMethod_() };
      var maxColors = this.getSnapMaxColors_();
      if (maxColors > 0) {
        opts.maxColors = maxColors;
      }
      if (grid) {
        opts.gridSize = grid;
      }
      var detected = this.pixelSnapDetected_;
      var isDetectedSize = detected && grid &&
        grid[0] === detected.gridW && grid[1] === detected.gridH;
      if (!isDetectedSize) {
        opts.refineIntensity = 0;
        opts.fixSquare = false;
      }
      return opts;
    };

    ImageImport.prototype.onPixelSnapChange_ = function () {
      if (this.pixelSnapCheckbox_.checked) {
        this.pixelSnapSavedFields_ = {
          width: this.resizeWidth.value,
          height: this.resizeHeight.value,
          smooth: this.smoothResize.checked
        };
        this.singleImportType.checked = true;
        this.smoothResize.checked = false;
        this.smoothResize.disabled = true;
        this.pixelSnapMethodRow_.style.display = '';
        this.applyDetectedSize_();
        this.updateSnapPreview_();
      } else {
        this.smoothResize.disabled = false;
        this.pixelSnapMethodRow_.style.display = 'none';
        if (this.pixelSnapSavedFields_) {
          this.resizeWidth.value = this.pixelSnapSavedFields_.width;
          this.resizeHeight.value = this.pixelSnapSavedFields_.height;
          this.smoothResize.checked = this.pixelSnapSavedFields_.smooth;
        }
        this.pixelSnapJob_ = null;
        this.restoreOriginalPreview_();
        if (this.pixelSnapDetected_) {
          this.setPixelSnapStatus_('detected ' + this.pixelSnapDetected_.gridW + '×' + this.pixelSnapDetected_.gridH);
        } else {
          this.setPixelSnapStatus_('no grid found');
        }
      }
    };

    /** Turn snapping off programmatically (e.g. when spritesheet mode is used). */
    ImageImport.prototype.pixelSnapOff_ = function () {
      if (this.pixelSnapCheckbox_ && this.pixelSnapCheckbox_.checked) {
        this.pixelSnapCheckbox_.checked = false;
        this.onPixelSnapChange_();
      }
    };

    ImageImport.prototype.scheduleSnapPreview_ = function () {
      if (!this.pixelSnapCheckbox_ || !this.pixelSnapCheckbox_.checked) {
        return;
      }
      window.clearTimeout(this.pixelSnapDebounce_);
      this.pixelSnapDebounce_ = window.setTimeout(this.updateSnapPreview_.bind(this), 600);
    };

    ImageImport.prototype.updateSnapPreview_ = function () {
      var image = this.importedImage_;
      if (!image || !this.pixelSnapCheckbox_ || !this.pixelSnapCheckbox_.checked) {
        return;
      }
      var grid = this.getSnapGrid_();
      if (!grid && !this.pixelSnapDetected_) {
        this.restoreOriginalPreview_();
        this.setPixelSnapStatus_('type a size above to make pixel art');
        return;
      }
      var method = this.getSnapMethod_();
      var key = method + ':' + this.getSnapMaxColors_() + ':' + (grid ? grid[0] + 'x' + grid[1] : 'auto');
      this.pixelSnapJob_ = key;
      var cached = this.pixelSnapCache_[key];
      if (cached) {
        this.showSnappedPreview_(cached);
        return;
      }
      this.setPixelSnapStatus_('working…');
      var self = this;
      setTimeout(function () {
        if (self.pixelSnapJob_ !== key || self.importedImage_ !== image) {
          return;
        }
        var snapped = null;
        var opts = self.getSnapOptions_(grid);
        try {
          snapped = window.PerfectPixel.snapToCanvas(image, opts);
        } catch (e) {
          console.error('[PerfectPixel] preview snap failed', e);
        }
        if (self.pixelSnapJob_ !== key || self.importedImage_ !== image) {
          return;
        }
        if (!snapped) {
          self.setPixelSnapStatus_('type a size above to make pixel art');
          return;
        }
        snapped.refined = opts.refineIntensity === undefined;
        self.pixelSnapCache_[key] = snapped;
        self.showSnappedPreview_(snapped);
      }, 20);
    };

    ImageImport.prototype.showSnappedPreview_ = function (snapped) {
      if (!this.importPreview || !this.pixelSnapCheckbox_ || !this.pixelSnapCheckbox_.checked) {
        return;
      }
      this.restoreOriginalPreview_();
      var img = this.importPreview.querySelector('img');
      if (img) {
        img.style.display = 'none';
      }
      var canvas = snapped.canvas;
      canvas.className = 'pp-snap-preview-canvas';
      // Integer upscale keeps the preview crisp inside the 220px box.
      var scale = Math.max(1, Math.floor(214 / Math.max(snapped.width, snapped.height)));
      canvas.style.width = (snapped.width * scale) + 'px';
      canvas.style.height = (snapped.height * scale) + 'px';
      var wrap = document.createElement('div');
      wrap.className = 'pp-snap-preview-wrap';
      wrap.appendChild(canvas);
      var caption = document.createElement('div');
      caption.className = 'pp-snap-preview-caption';
      var maxColors = this.getSnapMaxColors_();
      caption.textContent = snapped.width + '×' + snapped.height + ' pixels' +
        (maxColors > 0 ? ', ' + maxColors + ' colors' : '');
      this.importPreview.appendChild(wrap);
      this.importPreview.appendChild(caption);
      var verb = snapped.refined ? 'snapped to ' : 'pixel art at ';
      this.setPixelSnapStatus_(verb + snapped.width + '×' + snapped.height);
    };

    ImageImport.prototype.restoreOriginalPreview_ = function () {
      if (!this.importPreview) {
        return;
      }
      var wrap = this.importPreview.querySelector('.pp-snap-preview-wrap');
      if (wrap) {
        wrap.parentNode.removeChild(wrap);
      }
      var caption = this.importPreview.querySelector('.pp-snap-preview-caption');
      if (caption) {
        caption.parentNode.removeChild(caption);
      }
      var img = this.importPreview.querySelector('img');
      if (img) {
        img.style.display = '';
      }
    };

    ImageImport.prototype.createPiskelFromImage = function () {
      var snapEnabled = this.pixelSnapCheckbox_ && this.pixelSnapCheckbox_.checked &&
        this.getImportType_() === 'single';
      var grid = snapEnabled ? this.getSnapGrid_() : null;
      // Fields covering the image 1:1 with nothing detected means there is
      // nothing to snap; keep the stock path.
      if (!snapEnabled || (!grid && !this.pixelSnapDetected_)) {
        return originalCreatePiskel.call(this);
      }

      var name = this.extractFileNameFromPath_(this.file_.name);
      name = name.replace(/\.[a-zA-Z]+$/, '');

      var image = this.importedImage_;
      var method = this.getSnapMethod_();
      var key = method + ':' + this.getSnapMaxColors_() + ':' + (grid ? grid[0] + 'x' + grid[1] : 'auto');
      var cached = this.pixelSnapCache_[key];
      var opts = this.getSnapOptions_(grid);
      var self = this;
      var deferred = Q.defer();

      // Defer so the wizard's loading state can paint before the heavy work.
      setTimeout(function () {
        var snapped = cached || null;
        if (!snapped) {
          try {
            snapped = window.PerfectPixel.snapToCanvas(image, opts);
          } catch (e) {
            console.error('[PerfectPixel] snapping failed, falling back to plain import', e);
          }
        }
        if (!snapped) {
          originalCreatePiskel.call(self).then(deferred.resolve, deferred.reject);
          return;
        }
        var frame = pskl.utils.FrameUtils.createFromImage(snapped.canvas);
        var layer = pskl.model.Layer.fromFrames('Layer 1', [frame]);
        var descriptor = new pskl.model.piskel.Descriptor(name, '');
        deferred.resolve(pskl.model.Piskel.fromLayers([layer], Constants.DEFAULT.FPS, descriptor));
      }, 20);
      return deferred.promise;
    };

    console.log('[PerfectPixel] import wizard grid snapping enabled');
  }

  function injectSnapUi(step) {
    var form = step.container.querySelector('form[name=import-image-form]');
    if (!form) {
      return;
    }

    var section = document.createElement('div');
    section.className = 'import-section pp-snap-card';

    var titleRow = document.createElement('div');
    titleRow.className = 'pp-snap-title-row';
    var label = document.createElement('label');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'checkbox-fix';
    checkbox.name = 'pixel-snap-checkbox';
    checkbox.value = '1';
    var title = document.createElement('span');
    title.className = 'pp-snap-title';
    title.textContent = 'Snap to pixel grid';
    label.appendChild(checkbox);
    label.appendChild(title);
    var status = document.createElement('span');
    status.className = 'pp-snap-status';
    titleRow.appendChild(label);
    titleRow.appendChild(status);

    var explainer = document.createElement('div');
    explainer.className = 'pp-snap-explainer';
    explainer.textContent = EXPLAINER_TEXT;

    function buildOption(labelText, selectName, choices) {
      var holder = document.createElement('span');
      holder.className = 'pp-snap-option';
      var text = document.createElement('span');
      text.textContent = labelText;
      var select = document.createElement('select');
      select.name = selectName;
      choices.forEach(function (c) {
        var option = document.createElement('option');
        option.value = c.value;
        option.textContent = c.label;
        select.appendChild(option);
      });
      holder.appendChild(text);
      holder.appendChild(select);
      return { holder: holder, select: select };
    }

    var methodRow = document.createElement('div');
    methodRow.className = 'pp-snap-method-row';
    methodRow.style.display = 'none';
    var methodOption = buildOption('Pick colors by', 'pixel-snap-method', SAMPLE_METHODS);
    var colorsOption = buildOption('Limit colors', 'pixel-snap-colors', COLOR_LIMITS);
    var methodSelect = methodOption.select;
    methodRow.appendChild(methodOption.holder);
    methodRow.appendChild(colorsOption.holder);

    section.appendChild(titleRow);
    section.appendChild(explainer);
    section.appendChild(methodRow);
    form.appendChild(section);

    step.pixelSnapSection_ = section;
    step.pixelSnapCheckbox_ = checkbox;
    step.pixelSnapStatus_ = status;
    step.pixelSnapMethod_ = methodSelect;
    step.pixelSnapColors_ = colorsOption.select;
    step.pixelSnapMethodRow_ = methodRow;

    step.addEventListener(checkbox, 'change', step.onPixelSnapChange_);
    step.addEventListener(methodSelect, 'change', step.updateSnapPreview_);
    step.addEventListener(colorsOption.select, 'change', step.updateSnapPreview_);
    // Editing the size fields while snapping re-previews with that grid.
    step.addEventListener(step.resizeWidth, 'keyup', step.scheduleSnapPreview_);
    step.addEventListener(step.resizeHeight, 'keyup', step.scheduleSnapPreview_);
    // Spritesheet mode and snapping are mutually exclusive.
    step.addEventListener(step.sheetImportType, 'change', step.pixelSnapOff_);
    [step.frameSizeX, step.frameSizeY, step.frameOffsetX, step.frameOffsetY].forEach(function (el) {
      step.addEventListener(el, 'keyup', step.pixelSnapOff_);
    });
  }

  waitForPiskel();
})();
