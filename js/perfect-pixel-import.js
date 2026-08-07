/**
 * perfect-pixel-import.js — wires PerfectPixel grid snapping into the
 * Piskel import wizard.
 *
 * Adds a "Snap to pixel grid" option to the image import step. When an image
 * loads, the pixel grid is detected in the background and shown next to the
 * option. When enabled, the resize fields are filled with the detected true
 * resolution and import goes through PerfectPixel instead of a plain resize,
 * producing crisp pixel art from fuzzy AI generated images.
 *
 * Loaded from platform.html after perfect-pixel.js. Polls for the Piskel
 * engine like the platform adapter does. Skipped for animated GIFs.
 */
(function () {
  'use strict';

  var POLL_INTERVAL = 100;
  var MAX_POLLS = 200;
  var pollCount = 0;

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
      patchImportStep();
    } else {
      setTimeout(waitForPiskel, POLL_INTERVAL);
    }
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
          }
        } else {
          self.setPixelSnapStatus_('no grid detected');
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
        this.applyDetectedSize_();
      } else {
        this.smoothResize.disabled = false;
        if (this.pixelSnapSavedFields_) {
          this.resizeWidth.value = this.pixelSnapSavedFields_.width;
          this.resizeHeight.value = this.pixelSnapSavedFields_.height;
          this.smoothResize.checked = this.pixelSnapSavedFields_.smooth;
        }
      }
    };

    ImageImport.prototype.createPiskelFromImage = function () {
      var snapEnabled = this.pixelSnapCheckbox_ && this.pixelSnapCheckbox_.checked &&
        this.getImportType_() === 'single';
      if (!snapEnabled) {
        return originalCreatePiskel.call(this);
      }

      var name = this.extractFileNameFromPath_(this.file_.name);
      name = name.replace(/\.[a-zA-Z]+$/, '');

      var image = this.importedImage_;
      var gridW = parseInt(this.resizeWidth.value, 10);
      var gridH = parseInt(this.resizeHeight.value, 10);
      var self = this;
      var deferred = Q.defer();

      // Defer so the wizard's loading state can paint before the heavy work.
      setTimeout(function () {
        var snapped = null;
        try {
          var opts = { sampleMethod: 'majority' };
          if (gridW > 0 && gridH > 0) {
            opts.gridSize = [gridW, gridH];
          }
          snapped = window.PerfectPixel.snapToCanvas(image, opts);
        } catch (e) {
          console.error('[PerfectPixel] snapping failed, falling back to plain import', e);
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
    var smoothCheckbox = step.container.querySelector('[name=smooth-resize-checkbox]');
    if (!smoothCheckbox) {
      return;
    }
    var smoothSection = smoothCheckbox.closest('.import-section');
    if (!smoothSection) {
      return;
    }

    var section = document.createElement('div');
    section.className = 'import-section import-subsection';
    var title = document.createElement('span');
    title.className = 'import-section-title';
    title.textContent = 'Snap to pixel grid';
    title.title = 'Fixes fuzzy AI pixel art: finds the real pixel grid and imports at true resolution';
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'checkbox-fix';
    checkbox.name = 'pixel-snap-checkbox';
    checkbox.value = '1';
    var status = document.createElement('span');
    status.style.marginLeft = '8px';
    status.style.fontSize = '11px';
    status.style.opacity = '0.7';
    section.appendChild(title);
    section.appendChild(checkbox);
    section.appendChild(status);
    smoothSection.parentNode.insertBefore(section, smoothSection.nextSibling);

    step.pixelSnapSection_ = section;
    step.pixelSnapCheckbox_ = checkbox;
    step.pixelSnapStatus_ = status;
    step.addEventListener(checkbox, 'change', step.onPixelSnapChange_);
  }

  waitForPiskel();
})();
