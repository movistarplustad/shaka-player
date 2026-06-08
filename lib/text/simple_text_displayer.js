/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview
 */

goog.provide('shaka.text.SimpleTextDisplayer');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.text.Cue');
goog.require('shaka.text.Utils');
goog.require('shaka.util.Timer');


/**
 * A text displayer plugin using the browser's native VTTCue interface.
 *
 * @implements {shaka.extern.TextDisplayer}
 * @export
 */
shaka.text.SimpleTextDisplayer = class {
  /**
   * @param {HTMLMediaElement} video
   * @param {string} label
   */
  constructor(video, label) {
    /** @private {TextTrack} */
    this.textTrack_ = null;

    /**
     * Monotonic counter to invalidate in-flight chunked appends when the track
     * is switched/cleared/destroyed. See appendCuesChunked_.
     * @private {number}
     */
    this.appendGeneration_ = 0;

    /**
     * The intended visibility, the source of truth for showing/hiding. The
     * native track mode may be temporarily forced to 'hidden' while a chunked
     * append is in progress (see appendCuesChunked_), so we cannot rely on it.
     * @private {boolean}
     */
    this.textVisible_ = false;

    // TODO: Test that in all cases, the built-in CC controls in the video
    // element are toggling our TextTrack.

    // If the video element has TextTracks, disable them.  If we see one that
    // was created by a previous instance of Shaka Player, reuse it.
    for (const track of Array.from(video.textTracks)) {
      // NOTE: There is no API available to remove a TextTrack from a video
      // element.
      track.mode = 'disabled';

      if (track.label == label) {
        this.textTrack_ = track;
      }
    }

    if (!this.textTrack_) {
      // As far as I can tell, there is no observable difference between setting
      // kind to 'subtitles' or 'captions' when creating the TextTrack object.
      // The individual text tracks from the manifest will still have their own
      // kinds which can be displayed in the app's UI.
      this.textTrack_ = video.addTextTrack('subtitles', label);
    }
    this.textTrack_.mode = 'hidden';
  }

  /**
   * @override
   * @export
   */
  remove(start, end) {
    // Check that the displayer hasn't been destroyed.
    if (!this.textTrack_) {
      return false;
    }

    // Invalidate any in-flight chunked append (e.g. on a track switch).
    this.appendGeneration_++;

    const removeInRange = (cue) => {
      const inside = cue.startTime < end && cue.endTime > start;
      return inside;
    };

    shaka.text.SimpleTextDisplayer.removeWhere_(this.textTrack_, removeInRange);

    return true;
  }

  /**
   * @param {!Array.<!shaka.text.Cue>} cues
   * @param {boolean=} keepVisible if true, do NOT hide the track while doing a
   *   chunked append. Used for the window-first phase 2 (background load of the
   *   rest of the cues) so the already-shown window subtitle stays visible.
   * @override
   * @export
   */
  append(cues, keepVisible) {
    const SimpleTextDisplayer = shaka.text.SimpleTextDisplayer;

    // A new append (and remove()/destroy()) invalidates any chunked append
    // still in flight from a previous call (e.g. after a track switch).
    const generation = ++this.appendGeneration_;

    // PERF: a single-file TTML for a whole program flattens to thousands of
    // cues. Adding them all to the native TextTrack at once blocks the main
    // thread long enough to starve the media buffer and freeze the video on
    // weak devices (e.g. webOS 2016). For large sets, add them in batches that
    // yield to the event loop, so the media buffering loop keeps running and
    // the video does not freeze. Normal VTT/text segments (small sets) keep
    // the original synchronous path, unchanged.
    if (SimpleTextDisplayer.countLeafCues_(cues) >
        SimpleTextDisplayer.LARGE_CUE_SET_) {
      this.appendCuesChunked_(cues, generation, !!keepVisible);
      return;
    }

    // Small set (e.g. the window-first batch): synchronous add. This path adds
    // while showing without flipping the mode, so the cues appear immediately
    // and nothing blinks.
    this.addFlattenedCues_(shaka.text.Utils.getCuesToFlatten(cues));
  }

  /**
   * Original synchronous conversion + de-dup + sort + addCue of already
   * flattened cues. Used for normal (small) cue sets.
   *
   * @param {!Array.<!shaka.text.Cue>} flattenedCues
   * @private
   */
  addFlattenedCues_(flattenedCues) {
    // Convert cues.
    const textTrackCues = [];
    const cuesInTextTrack = this.textTrack_.cues ?
                            Array.from(this.textTrack_.cues) : [];

    for (const inCue of flattenedCues) {
      // When a VTT cue spans a segment boundary, the cue will be duplicated
      // into two segments.
      // To avoid displaying duplicate cues, if the current textTrack cues
      // list already contains the cue, skip it.
      const containsCue = cuesInTextTrack.some((cueInTextTrack) => {
        if (cueInTextTrack.startTime == inCue.startTime &&
            cueInTextTrack.endTime == inCue.endTime &&
            cueInTextTrack.text == inCue.payload) {
          return true;
        }
        return false;
      });

      if (!containsCue) {
        const cue =
            shaka.text.SimpleTextDisplayer.convertToTextTrackCue_(inCue);
        if (cue) {
          textTrackCues.push(cue);
        }
      }
    }

    // Sort the cues based on start/end times.  Make a copy of the array so
    // we can get the index in the original ordering.  Out of order cues are
    // rejected by Edge.  See https://bit.ly/2K9VX3s
    const sortedCues = textTrackCues.slice().sort((a, b) => {
      if (a.startTime != b.startTime) {
        return a.startTime - b.startTime;
      } else if (a.endTime != b.endTime) {
        return a.endTime - b.startTime;
      } else {
        // The browser will display cues with identical time ranges from the
        // bottom up.  Reversing the order of equal cues means the first one
        // parsed will be at the top, as you would expect.
        // See https://github.com/shaka-project/shaka-player/issues/848 for
        // more info.
        // However, this ordering behavior is part of VTTCue's "line" field.
        // Some platforms don't have a real VTTCue and use a polyfill instead.
        // When VTTCue is polyfilled or does not support "line", we should _not_
        // reverse the order.  This occurs on legacy Edge.
        // eslint-disable-next-line no-restricted-syntax
        if ('line' in VTTCue.prototype) {
          // Native VTTCue
          return textTrackCues.indexOf(b) - textTrackCues.indexOf(a);
        } else {
          // Polyfilled VTTCue
          return textTrackCues.indexOf(a) - textTrackCues.indexOf(b);
        }
      }
    });

    for (const cue of sortedCues) {
      this.textTrack_.addCue(cue);
    }
  }

  /**
   * Non-blocking variant for very large cue sets (e.g. whole-program
   * single-file TTML). Adds the cues to the native TextTrack in time order, in
   * batches separated by real sleeps, so the media buffering loop keeps running
   * and the video does not freeze. Aborts if a track switch / removal /
   * destroy happens meanwhile (tracked via |generation|).
   *
   * @param {!Array.<!shaka.text.Cue>} cues
   * @param {number} generation
   * @param {boolean} keepVisible if true, the track is NOT hidden during the
   *   append (window-first phase 2: keep the already-shown window visible).
   * @private
   */
  async appendCuesChunked_(cues, generation, keepVisible) {
    // NOTE: do not alias shaka.text.SimpleTextDisplayer / shaka.text.Utils to a
    // local const here. In an async function the compiler cannot inline the
    // alias, and aliasing a constructor triggers JSC_UNSAFE_CTOR_ALIASING. Use
    // the full names.

    // Collect the leaf (content) cues with their parent container (needed for
    // color/style inheritance when flattening), then add them in time order.
    const pairs = [];
    shaka.text.SimpleTextDisplayer.collectLeafCues_(cues, null, pairs);
    pairs.sort((a, b) => (a.cue.startTime - b.cue.startTime) ||
        (a.cue.endTime - b.cue.endTime));
    // BACKGROUND_KEEP_VISIBLE_ is the on-device escape hatch: if measurement
    // shows adding-while-showing is too costly on a given device, flip it to
    // false to fall back to the old "hide during the whole append" behavior.
    const keepVisibleEffective = keepVisible &&
        shaka.text.SimpleTextDisplayer.BACKGROUND_KEEP_VISIBLE_;
    console.warn('[TTML diag] chunked append start, leaves=' + pairs.length +
        ', keepVisible=' + keepVisibleEffective +
        (keepVisibleEffective ? ' (RESTO en background)' : ''));
    const __t0 = Date.now();
    let __added = 0;

    // Snapshot the existing native cues once for de-duplication, as a Set of
    // "start|end|text" keys for O(1) lookup (phase 2 dedups against the window
    // cues already present, and across segment-boundary duplicates).
    const existingKeys = new Set();
    if (this.textTrack_.cues) {
      for (const c of Array.from(this.textTrack_.cues)) {
        existingKeys.add(c.startTime + '|' + c.endTime + '|' + c.text);
      }
    }

    // PERF: while a track is "showing", every addCue() makes the browser
    // re-render/re-evaluate the active cues, which is what freezes the video on
    // webOS. By default we add the cues with the track temporarily "hidden" (no
    // render), then restore the intended visibility once at the end. But for
    // window-first phase 2 (keepVisible) we must NOT hide, so the window
    // subtitle stays on screen; the bounded batches + sleeps keep each
    // add-while-showing burst small enough not to freeze the video.
    const hideDuringAppend = this.textVisible_ && !keepVisibleEffective;
    if (hideDuringAppend) {
      this.textTrack_.mode = 'hidden';
    }

    let batchStart = Date.now();
    for (const pair of pairs) {
      // A track switch / removal / destroy invalidates this in-flight job.
      if (!this.textTrack_ || this.appendGeneration_ != generation) {
        console.warn('[TTML diag] chunked append ABORTED after ' +
            (Date.now() - __t0) + 'ms, added=' + __added);
        return;
      }

      for (const inCue of shaka.text.Utils.getCuesToFlatten(
          [pair.cue], pair.parent)) {
        const key = inCue.startTime + '|' + inCue.endTime + '|' + inCue.payload;
        if (existingKeys.has(key)) {
          continue;
        }
        const vttCue =
            shaka.text.SimpleTextDisplayer.convertToTextTrackCue_(inCue);
        if (vttCue) {
          this.textTrack_.addCue(vttCue);
          existingKeys.add(key);
          __added++;
        }
      }

      if (Date.now() - batchStart >=
          shaka.text.SimpleTextDisplayer.CHUNK_BUDGET_MS_) {
        // eslint-disable-next-line no-await-in-loop
        await shaka.text.SimpleTextDisplayer.yieldToEventLoop_();
        batchStart = Date.now();
      }
    }

    // Restore the intended visibility now that all cues are in place (only if
    // we hid it). If a newer append/remove took over (generation changed), it
    // owns the mode now. When keepVisible, we never touched the mode.
    if (hideDuringAppend && this.textTrack_ &&
        this.appendGeneration_ == generation) {
      this.textTrack_.mode = this.textVisible_ ? 'showing' : 'hidden';
    }
    console.warn('[TTML diag] <<< RESTO cargado: chunked append DONE en ' +
        (Date.now() - __t0) + 'ms, added=' + __added +
        ', visible=' + this.textVisible_ + ', keptVisible=' +
        keepVisibleEffective);
  }

  /**
   * Counts the leaf (non-container) cues in a (possibly nested) cue list,
   * without doing the expensive flatten. Used to decide whether to use the
   * chunked append path.
   *
   * @param {!Array.<!shaka.text.Cue>} cues
   * @return {number}
   * @private
   */
  static countLeafCues_(cues) {
    let count = 0;
    for (const cue of cues) {
      if (cue.isContainer) {
        count += shaka.text.SimpleTextDisplayer.countLeafCues_(cue.nestedCues);
      } else {
        count++;
      }
    }
    return count;
  }

  /**
   * Collects the leaf (content) cues together with their parent container into
   * |out| as {cue, parent} pairs, mirroring how getCuesToFlatten() recurses
   * (it only flattens starting at non-container elements).
   *
   * @param {!Array.<!shaka.text.Cue>} cues
   * @param {?shaka.text.Cue} parent
   * @param {!Array.<{cue: !shaka.text.Cue, parent: ?shaka.text.Cue}>} out
   * @private
   */
  static collectLeafCues_(cues, parent, out) {
    for (const cue of cues) {
      if (cue.isContainer) {
        shaka.text.SimpleTextDisplayer.collectLeafCues_(
            cue.nestedCues, cue, out);
      } else {
        out.push({cue: cue, parent: parent});
      }
    }
  }

  /**
   * Yields to the event loop, sleeping a real amount so the media buffering /
   * decode pipeline gets a contiguous window between batches.
   *
   * @return {!Promise}
   * @private
   */
  static yieldToEventLoop_() {
    return new Promise((resolve) => {
      (new shaka.util.Timer(resolve)).tickAfter(
          shaka.text.SimpleTextDisplayer.CHUNK_SLEEP_MS_ / 1000);
    });
  }

  /**
   * @override
   * @export
   */
  destroy() {
    if (this.textTrack_) {
      const removeIt = (cue) => true;
      shaka.text.SimpleTextDisplayer.removeWhere_(this.textTrack_, removeIt);

      // NOTE: There is no API available to remove a TextTrack from a video
      // element.
      this.textTrack_.mode = 'disabled';
    }

    this.textTrack_ = null;
    return Promise.resolve();
  }

  /**
   * @override
   * @export
   */
  isTextVisible() {
    return this.textVisible_;
  }

  /**
   * @override
   * @export
   */
  setTextVisibility(on) {
    this.textVisible_ = on;
    this.textTrack_.mode = on ? 'showing' : 'hidden';
  }

  /**
   * @param {!shaka.text.Cue} shakaCue
   * @return {TextTrackCue}
   * @private
   */
  static convertToTextTrackCue_(shakaCue) {
    if (shakaCue.startTime >= shakaCue.endTime) {
      // Edge will throw in this case.
      // See issue #501
      shaka.log.warning('Invalid cue times: ' + shakaCue.startTime +
                        ' - ' + shakaCue.endTime);
      return null;
    }

    const Cue = shaka.text.Cue;
    /** @type {VTTCue} */
    const vttCue = new VTTCue(
        shakaCue.startTime,
        shakaCue.endTime,
        shakaCue.payload);

    // NOTE: positionAlign and lineAlign settings are not supported by Chrome
    // at the moment, so setting them will have no effect.
    // The bug on chromium to implement them:
    // https://bugs.chromium.org/p/chromium/issues/detail?id=633690

    vttCue.lineAlign = shakaCue.lineAlign;
    vttCue.positionAlign = shakaCue.positionAlign;
    if (shakaCue.size) {
      vttCue.size = shakaCue.size;
    }

    try {
      // Safari 10 seems to throw on align='center'.
      vttCue.align = shakaCue.textAlign;
    } catch (exception) {}

    if (shakaCue.textAlign == 'center' && vttCue.align != 'center') {
      // We want vttCue.position = 'auto'. By default, |position| is set to
      // "auto". If we set it to "auto" safari will throw an exception, so we
      // must rely on the default value.
      vttCue.align = 'middle';
    }

    if (shakaCue.writingMode ==
            Cue.writingMode.VERTICAL_LEFT_TO_RIGHT) {
      vttCue.vertical = 'lr';
    } else if (shakaCue.writingMode ==
             Cue.writingMode.VERTICAL_RIGHT_TO_LEFT) {
      vttCue.vertical = 'rl';
    }

    // snapToLines flag is true by default
    if (shakaCue.lineInterpretation == Cue.lineInterpretation.PERCENTAGE) {
      vttCue.snapToLines = false;
    }

    if (shakaCue.line != null) {
      vttCue.line = shakaCue.line;
    }

    if (shakaCue.position != null) {
      vttCue.position = shakaCue.position;
    }

    return vttCue;
  }

  /**
   * Iterate over all the cues in a text track and remove all those for which
   * |predicate(cue)| returns true.
   *
   * @param {!TextTrack} track
   * @param {function(!TextTrackCue):boolean} predicate
   * @private
   */
  static removeWhere_(track, predicate) {
    // Since |track.cues| can be null if |track.mode| is "disabled", force it to
    // something other than "disabled".
    //
    // If the track is already showing, then we should keep it as showing. But
    // if it something else, we will use hidden so that we don't "flash" cues on
    // the screen.
    const oldState = track.mode;
    const tempState = oldState == 'showing' ? 'showing' : 'hidden';

    track.mode = tempState;

    goog.asserts.assert(
        track.cues,
        'Cues should be accessible when mode is set to "' + tempState + '".');

    // Create a copy of the list to avoid errors while iterating.
    for (const cue of Array.from(track.cues)) {
      if (cue && predicate(cue)) {
        track.removeCue(cue);
      }
    }

    track.mode = oldState;
  }
};


/**
 * PERF: above this many leaf cues in a single append(), use the non-blocking
 * chunked path. Below it, the original synchronous path is used (normal VTT and
 * small text segments are unaffected).
 *
 * @const {number}
 * @private
 */
shaka.text.SimpleTextDisplayer.LARGE_CUE_SET_ = 200;

/**
 * PERF: budget (ms) of synchronous addCue work between yields in the chunked
 * append path.
 *
 * @const {number}
 * @private
 */
shaka.text.SimpleTextDisplayer.CHUNK_BUDGET_MS_ = 15;

/**
 * PERF: real sleep (ms) on each yield of the chunked append path, so the media
 * buffering/decode pipeline gets a contiguous window and the video does not
 * freeze.
 *
 * @const {number}
 * @private
 */
shaka.text.SimpleTextDisplayer.CHUNK_SLEEP_MS_ = 30;

/**
 * PERF (window-first): if true, the phase-2 background append (keepVisible)
 * keeps the track "showing" so the already-shown window subtitle does not blink
 * off. On-device escape hatch: set to false to fall back to hiding the track
 * during the whole append (the original behavior) if a device proves too slow
 * at add-while-showing.
 *
 * @const {boolean}
 * @private
 */
shaka.text.SimpleTextDisplayer.BACKGROUND_KEEP_VISIBLE_ = true;
