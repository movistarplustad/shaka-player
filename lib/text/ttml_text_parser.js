/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.text.TtmlTextParser');

goog.require('goog.asserts');
goog.require('goog.Uri');
goog.require('shaka.log');
goog.require('shaka.text.Cue');
goog.require('shaka.text.CueRegion');
goog.require('shaka.text.TextEngine');
goog.require('shaka.util.ArrayUtils');
goog.require('shaka.util.Error');
goog.require('shaka.util.StringUtils');
goog.require('shaka.util.Timer');
goog.require('shaka.util.XmlUtils');


/**
 * @implements {shaka.extern.TextParser}
 * @export
 */
shaka.text.TtmlTextParser = class {
  /**
   * @override
   * @export
   */
  parseInit(data) {
    goog.asserts.assert(false, 'TTML does not have init segments');
  }

  /**
   * @override
   * @export
   */
  setSequenceMode(sequenceMode) {
    // Unused.
  }

  /**
   * @override
   * @export
   */
  setManifestType(manifestType) {
    // Unused.
  }

  /**
   * @override
   * @export
   */
  parseMedia(data, time, uri) {
    const TtmlTextParser = shaka.text.TtmlTextParser;

    // NOTE: the parse cache is intentionally NOT used here. Mp4TtmlParser calls
    // this once per <mdat> with the same uri+time, so a uri+time-keyed cache
    // would wrongly return the first mdat's cues for the rest. The standalone
    // TTML path goes through parseMediaChunked (used by TextEngine), which is
    // invoked once per segment and does cache.
    const ctx = TtmlTextParser.setupParse_(data);
    if (!ctx) {
      return [];
    }

    const cue = TtmlTextParser.parseCue_(
        ctx.body, time, ctx.rateInfo, ctx.metadataElements, ctx.styles,
        ctx.regionElements, ctx.cueRegions, ctx.whitespaceTrim,
        ctx.cellResolution, /* parentCueElement= */ null,
        /* isContent= */ false, uri);

    return TtmlTextParser.finalizeCues_(cue, /* cacheKey= */ null);
  }

  /**
   * Non-blocking variant of parseMedia. Parses the TTML cooperatively, yielding
   * to the event loop based on wall-clock time so the UI does NOT freeze on
   * slow devices (e.g. webOS 2016 TVs) while parsing a large single-file TTML.
   * shaka.text.TextEngine uses this when available; the synchronous parseMedia
   * is kept for the TextParser interface and for callers that cannot await
   * (e.g. Mp4TtmlParser, which calls parseMedia inside a synchronous box
   * callback). Returns exactly the same cues as parseMedia: only the <body>
   * and <div> container traversal is async; each <p> content subtree is parsed
   * by the synchronous parseCue_, so the rendered output is identical.
   *
   * @param {BufferSource} data
   * @param {shaka.extern.TextParser.TimeContext} time
   * @param {?(string|undefined)=} uri
   * @param {?number=} currentTime current playback position; when provided the
   *   cues near it are parsed and emitted (via onPartialCues) first, so a
   *   subtitle shows quickly, then the rest is parsed in the background.
   * @param {?function(!Array.<!shaka.text.Cue>)=} onPartialCues called once
   *   with the window cues before the full result resolves. If omitted, this
   *   behaves exactly like before (single full parse).
   * @return {!Promise.<!Array.<!shaka.text.Cue>>}
   * @export
   */
  async parseMediaChunked(data, time, uri, currentTime, onPartialCues) {
    // NOTE: do not alias shaka.text.TtmlTextParser to a local const here. In an
    // async function the compiler cannot inline the alias, and aliasing a
    // constructor triggers JSC_UNSAFE_CTOR_ALIASING. Use the full name.
    console.warn('[TTML diag] parseMediaChunked (ASYNC) called, uri=' + uri +
        ' currentTime=' + currentTime);

    const cacheKey = shaka.text.TtmlTextParser.makeCacheKey_(time, uri);
    if (cacheKey != null) {
      const cached = shaka.text.TtmlTextParser.parseCache_.get(cacheKey);
      if (cached) {
        console.warn('[TTML diag] cache HIT -> instant');
        return cached;
      }
    }

    const __setupT0 = Date.now();
    const ctx = shaka.text.TtmlTextParser.setupParse_(data);
    const __setupMs = Date.now() - __setupT0;
    if (!ctx) {
      return [];
    }

    // Window-first: parse and emit the cues near currentTime before the full
    // parse, so a subtitle appears in ~1-2s instead of after the whole
    // ~2.4h-program TTML is parsed.  The full parse below shares ctx (and thus
    // the per-parse memo caches that this pass warms), so the extra cost is
    // small.  Only the FULL result is cached (see finalizeCues_ below).
    if (onPartialCues && currentTime != null) {
      const __w0 = Date.now();
      const leaves = shaka.text.TtmlTextParser.prescanLeaves_(
          ctx.body, ctx.rateInfo, time.periodStart);
      if (leaves.length >= shaka.text.TtmlTextParser.WINDOW_MIN_LEAVES_) {
        const lo = currentTime - shaka.text.TtmlTextParser.WINDOW_BACK_S_;
        const hi = currentTime + shaka.text.TtmlTextParser.WINDOW_FWD_S_;
        const selected = new Set();
        for (const leaf of leaves) {
          if (leaf.end > lo && leaf.start < hi) {
            selected.add(leaf.element);
          }
        }
        console.warn('[TTML diag] window: totalLeaves=' + leaves.length +
            ' inWindow=' + selected.size + ' range=[' + lo + ',' + hi + ']');
        if (selected.size > 0) {
          const deadlineW = {
            next: Date.now() + shaka.text.TtmlTextParser.CHUNK_BUDGET_MS_,
          };
          const windowRoot =
              await shaka.text.TtmlTextParser.parseSelectedLeaves_(
                  ctx.body, selected, time, ctx.rateInfo, ctx.metadataElements,
                  ctx.styles, ctx.regionElements, ctx.cueRegions,
                  ctx.whitespaceTrim, ctx.cellResolution,
                  /* parentCueElement= */ null, /* isContent= */ false, uri,
                  deadlineW);
          // cacheKey null: the partial window must NOT pollute the full cache.
          const windowCues =
              shaka.text.TtmlTextParser.finalizeCues_(windowRoot, null);
          console.warn('[TTML diag] window parsed in ' + (Date.now() - __w0) +
              'ms, emitting ' + windowCues.length + ' top cue(s)');
          onPartialCues(windowCues);
        }
      } else {
        console.warn('[TTML diag] window skipped (leaves=' + leaves.length +
            ' < min)');
      }
    }

    const deadline = {
      next: Date.now() + shaka.text.TtmlTextParser.CHUNK_BUDGET_MS_,
      startTime: Date.now(),
      count: 0,
      lastYield: Date.now(),
      maxGap: 0,
    };
    const __travT0 = Date.now();
    const cue = await shaka.text.TtmlTextParser.parseCueContainerChunked_(
        ctx.body, time, ctx.rateInfo, ctx.metadataElements, ctx.styles,
        ctx.regionElements, ctx.cueRegions, ctx.whitespaceTrim,
        ctx.cellResolution, /* parentCueElement= */ null,
        /* isContent= */ false, uri, deadline);
    // [DIAG] tailGap = bloque sincrono desde la ultima cesion hasta el final
    // del traversal (finishCue_ de los contenedores, etc.).
    const __tailGap = Date.now() - deadline.lastYield;

    console.warn('[TTML diag] setup(DOMParser)=' + __setupMs + 'ms' +
        ' traversal=' + (Date.now() - __travT0) + 'ms' +
        ' yields=' + deadline.count +
        ' maxGapBetweenYields=' + deadline.maxGap + 'ms' +
        ' tailGap=' + __tailGap + 'ms');
    return shaka.text.TtmlTextParser.finalizeCues_(cue, cacheKey);
  }

  /**
   * Clears the persistent parse cache (parseCache_). TextEngine calls this on
   * destroy so the cached cues do not survive after leaving the player (the
   * cache is static and would otherwise live for the whole page lifetime). Cue
   * caching across track switches still works because a track switch only calls
   * initParser, it does not destroy the TextEngine.
   *
   * @export
   */
  clearParseCache() {
    shaka.text.TtmlTextParser.parseCache_.clear();
    console.warn('[TTML diag] parseCache cleared (player teardown)');
  }

  /**
   * Builds the parse-cache key from the time context and uri, or null if there
   * is no uri to key on.
   *
   * @param {shaka.extern.TextParser.TimeContext} time
   * @param {?(string|undefined)} uri
   * @return {?string}
   * @private
   */
  static makeCacheKey_(time, uri) {
    if (uri == null) {
      return null;
    }
    return uri + '|' + time.periodStart + '|' + time.segmentStart +
        '|' + time.segmentEnd;
  }

  /**
   * Shared synchronous setup for parseMedia / parseMediaChunked: parses the
   * XML, reads document-level attributes, builds styles/regions and validates
   * structure. Resets the per-parse memoization caches. Returns null for empty
   * input or a document with no <body>; throws shaka.util.Error on invalid
   * input.
   *
   * @param {BufferSource} data
   * @return {?shaka.text.TtmlTextParser.ParseContext_}
   * @private
   */
  static setupParse_(data) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const XmlUtils = shaka.util.XmlUtils;
    const ttpNs = TtmlTextParser.parameterNs_;
    const ttsNs = TtmlTextParser.styleNs_;
    const str = shaka.util.StringUtils.fromUTF8(data);

    // dont try to parse empty string as
    // DOMParser will not throw error but return an errored xml
    if (str == '') {
      return null;
    }

    // PERF: reset de los caches de memoizacion por-parseo (colecciones y
    // elementos son nuevos en cada parseo). Ver declaraciones al final.
    // Se asignan por el nombre completo (no por el alias) para no disparar
    // JSC_UNSAFE_CTOR_ALIASING al escribir estaticas del constructor.
    shaka.text.TtmlTextParser.collectionLookups_ = new WeakMap();
    shaka.text.TtmlTextParser.elementCollectionCache_ = new WeakMap();
    shaka.text.TtmlTextParser.regionStyleCache_ = new WeakMap();
    shaka.text.TtmlTextParser.elementStyleCache_ = new WeakMap();
    shaka.text.TtmlTextParser.inheritedStyleCache_ = new WeakMap();
    shaka.text.TtmlTextParser.styleBagCache_ = new WeakMap();
    shaka.text.TtmlTextParser.parseTimeCache_ = new WeakMap();

    const tt = XmlUtils.parseXmlString(str, 'tt');
    if (!tt) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.TEXT,
          shaka.util.Error.Code.INVALID_XML,
          'Failed to parse TTML.');
    }

    const body = tt.getElementsByTagName('body')[0];
    if (!body) {
      return null;
    }

    // Get the framerate, subFrameRate and frameRateMultiplier if applicable.
    const frameRate = XmlUtils.getAttributeNSList(tt, ttpNs, 'frameRate');
    const subFrameRate = XmlUtils.getAttributeNSList(
        tt, ttpNs, 'subFrameRate');
    const frameRateMultiplier =
        XmlUtils.getAttributeNSList(tt, ttpNs, 'frameRateMultiplier');
    const tickRate = XmlUtils.getAttributeNSList(tt, ttpNs, 'tickRate');

    const cellResolution = XmlUtils.getAttributeNSList(
        tt, ttpNs, 'cellResolution');
    const spaceStyle = tt.getAttribute('xml:space') || 'default';
    const extent = XmlUtils.getAttributeNSList(tt, ttsNs, 'extent');

    if (spaceStyle != 'default' && spaceStyle != 'preserve') {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.TEXT,
          shaka.util.Error.Code.INVALID_XML,
          'Invalid xml:space value: ' + spaceStyle);
    }
    const whitespaceTrim = spaceStyle == 'default';

    const rateInfo = new TtmlTextParser.RateInfo_(
        frameRate, subFrameRate, frameRateMultiplier, tickRate);

    const cellResolutionInfo =
      TtmlTextParser.getCellResolution_(cellResolution);

    const metadata = tt.getElementsByTagName('metadata')[0];
    const metadataElements = metadata ? XmlUtils.getChildren(metadata) : [];
    const styles = Array.from(tt.getElementsByTagName('style'));
    const regionElements = Array.from(tt.getElementsByTagName('region'));

    const cueRegions = [];
    for (const region of regionElements) {
      const cueRegion =
          TtmlTextParser.parseCueRegion_(region, styles, extent);
      if (cueRegion) {
        cueRegions.push(cueRegion);
      }
    }

    // A <body> element should only contain <div> elements, not <p> or <span>
    // elements.  We used to allow this, but it is non-compliant, and the
    // loose nature of our previous parser made it difficult to implement TTML
    // nesting more fully.
    if (XmlUtils.findChildren(body, 'p').length) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.TEXT,
          shaka.util.Error.Code.INVALID_TEXT_CUE,
          '<p> can only be inside <div> in TTML');
    }

    for (const div of XmlUtils.findChildren(body, 'div')) {
      // A <div> element should only contain <p>, not <span>.
      if (XmlUtils.findChildren(div, 'span').length) {
        throw new shaka.util.Error(
            shaka.util.Error.Severity.CRITICAL,
            shaka.util.Error.Category.TEXT,
            shaka.util.Error.Code.INVALID_TEXT_CUE,
            '<span> can only be inside <p> in TTML');
      }
    }

    return {
      body: body,
      rateInfo: rateInfo,
      metadataElements: metadataElements,
      styles: styles,
      regionElements: regionElements,
      cueRegions: cueRegions,
      whitespaceTrim: whitespaceTrim,
      cellResolution: cellResolutionInfo,
    };
  }

  /**
   * Wraps the single top-level cue into the returned array (defaulting its
   * background to transparent per the TTML spec) and stores it in the parse
   * cache. Shared by parseMedia / parseMediaChunked.
   *
   * @param {shaka.text.Cue} cue
   * @param {?string} cacheKey
   * @return {!Array.<!shaka.text.Cue>}
   * @private
   */
  static finalizeCues_(cue, cacheKey) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const cues = [];
    if (cue) {
      // According to the TTML spec, backgrounds default to transparent.
      // So default the background of the top-level element to transparent.
      // Nested elements may override that background color already.
      if (!cue.backgroundColor) {
        cue.backgroundColor = 'transparent';
      }
      cues.push(cue);
    }

    // PERF: cache de cues parseados por (uri + ventana temporal). Volver a una
    // pista ya vista se reutiliza sin re-parsear. Los Cue no se mutan aguas
    // abajo, asi que es seguro reutilizar las mismas instancias. Persiste entre
    // parseos; acotado por tamano (LRU simple).
    if (cacheKey != null) {
      const maxEntries = 8;
      if (TtmlTextParser.parseCache_.size >= maxEntries) {
        const oldestKey = TtmlTextParser.parseCache_.keys().next().value;
        TtmlTextParser.parseCache_.delete(oldestKey);
      }
      TtmlTextParser.parseCache_.set(cacheKey, cues);
    }

    return cues;
  }

  /**
   * Yields to the event loop (macrotask) so the UI can update during a long
   * parse, sleeping |sleepMs| so that on weak devices (webOS 2016) the video
   * decode/compositor pipeline gets a contiguous window between parse chunks.
   * A bare setTimeout(0) yields the JS thread but the gaps are too short for
   * the decoder to keep up, so the video appears frozen even though JS yields.
   *
   * @param {number} sleepMs
   * @return {!Promise}
   * @private
   */
  static yieldToEventLoop_(sleepMs) {
    return new Promise((resolve) => {
      // shaka.util.Timer wraps setTimeout (satisfying the no-setTimeout
      // conformance rule).
      (new shaka.util.Timer(resolve)).tickAfter(sleepMs / 1000);
    });
  }

  /**
   * Parses a TTML node into a Cue.
   *
   * @param {!Node} cueNode
   * @param {shaka.extern.TextParser.TimeContext} timeContext
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {!Array.<!Element>} metadataElements
   * @param {!Array.<!Element>} styles
   * @param {!Array.<!Element>} regionElements
   * @param {!Array.<!shaka.text.CueRegion>} cueRegions
   * @param {boolean} whitespaceTrim
   * @param {?{columns: number, rows: number}} cellResolution
   * @param {?Element} parentCueElement
   * @param {boolean} isContent
   * @param {?(string|undefined)} uri
   * @return {shaka.text.Cue}
   * @private
   */
  static parseCue_(
      cueNode, timeContext, rateInfo, metadataElements, styles, regionElements,
      cueRegions, whitespaceTrim, cellResolution, parentCueElement, isContent,
      uri) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const ctx = TtmlTextParser.prepareCue_(
        cueNode, whitespaceTrim, metadataElements, isContent, uri);
    if (!ctx) {
      return null;
    }

    const nestedCues = [];
    if (!ctx.isLeafNode) {
      // Recurse into the children.  Text nodes will convert into anonymous
      // spans, which will then be leaf nodes.
      for (const childNode of ctx.cueElement.childNodes) {
        const nestedCue = TtmlTextParser.parseCue_(
            childNode, timeContext, rateInfo, metadataElements, styles,
            regionElements, cueRegions, ctx.localWhitespaceTrim, cellResolution,
            ctx.cueElement, ctx.isContent, uri);
        // This node may or may not generate a nested cue.
        if (nestedCue) {
          nestedCues.push(nestedCue);
        }
      }
    }

    return TtmlTextParser.finishCue_(
        cueNode, ctx, nestedCues, timeContext, rateInfo, styles,
        regionElements, cueRegions, cellResolution, parentCueElement);
  }

  /**
   * Non-blocking variant of parseCue_ for the container levels (<body> and
   * <div>). It descends asynchronously through <div> elements, yielding to the
   * event loop based on wall-clock time so the UI stays responsive, while each
   * <p> content subtree (and anything else) is parsed by the synchronous
   * parseCue_. Both paths share prepareCue_/finishCue_, so the produced cues
   * are identical to parseMedia.
   *
   * @param {!Node} cueNode
   * @param {shaka.extern.TextParser.TimeContext} timeContext
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {!Array.<!Element>} metadataElements
   * @param {!Array.<!Element>} styles
   * @param {!Array.<!Element>} regionElements
   * @param {!Array.<!shaka.text.CueRegion>} cueRegions
   * @param {boolean} whitespaceTrim
   * @param {?{columns: number, rows: number}} cellResolution
   * @param {?Element} parentCueElement
   * @param {boolean} isContent
   * @param {?(string|undefined)} uri
   * @param {{next: number, startTime: number, count: number,
   *   lastYield: number, maxGap: number}} deadline shared, mutable wall-clock
   *   yield deadline (next), parse start time (for the ramp), yield counter and
   *   diagnostics (lastYield, maxGap)
   * @return {!Promise.<shaka.text.Cue>}
   * @private
   */
  static async parseCueContainerChunked_(
      cueNode, timeContext, rateInfo, metadataElements, styles, regionElements,
      cueRegions, whitespaceTrim, cellResolution, parentCueElement, isContent,
      uri, deadline) {
    // NOTE: do not alias shaka.text.TtmlTextParser to a local const here. In an
    // async function the compiler cannot inline the alias, and aliasing a
    // constructor triggers JSC_UNSAFE_CTOR_ALIASING. Use the full name.
    const ctx = shaka.text.TtmlTextParser.prepareCue_(
        cueNode, whitespaceTrim, metadataElements, isContent, uri);
    if (!ctx) {
      return null;
    }

    const nestedCues = [];
    if (!ctx.isLeafNode) {
      for (const childNode of ctx.cueElement.childNodes) {
        let nestedCue;
        if (childNode.nodeType == Node.ELEMENT_NODE &&
            childNode.nodeName == 'div') {
          // Keep descending asynchronously through container <div> elements so
          // we keep yielding deeper in the tree.  Sequential by design.
          // eslint-disable-next-line no-await-in-loop
          nestedCue = await shaka.text.TtmlTextParser.parseCueContainerChunked_(
              childNode, timeContext, rateInfo, metadataElements, styles,
              regionElements, cueRegions, ctx.localWhitespaceTrim,
              cellResolution, ctx.cueElement, ctx.isContent, uri, deadline);
        } else {
          // Content (<p>) subtrees and everything else are parsed by the
          // synchronous parseCue_ (fast per node, identical output).
          nestedCue = shaka.text.TtmlTextParser.parseCue_(
              childNode, timeContext, rateInfo, metadataElements, styles,
              regionElements, cueRegions, ctx.localWhitespaceTrim,
              cellResolution, ctx.cueElement, ctx.isContent, uri);
        }
        if (nestedCue) {
          nestedCues.push(nestedCue);
        }
        // PERF: yield to the event loop based on wall-clock time so the UI
        // stays responsive regardless of how the cues are distributed across
        // <div> elements (one giant <div> or many small ones).
        if (Date.now() >= deadline.next) {
          const gap = Date.now() - deadline.lastYield;
          if (gap > deadline.maxGap) {
            deadline.maxGap = gap;
          }
          deadline.count++;
          // Ramp: sleep a lot while the video buffer is still filling (cold
          // start), then much less once it should be healthy, so the parse
          // finishes faster without ever starving the buffer.
          const elapsed = Date.now() - deadline.startTime;
          const sleepMs = elapsed < shaka.text.TtmlTextParser.RAMP_MS_ ?
              shaka.text.TtmlTextParser.YIELD_SLEEP_MS_ :
              shaka.text.TtmlTextParser.WARM_SLEEP_MS_;
          // eslint-disable-next-line no-await-in-loop
          await shaka.text.TtmlTextParser.yieldToEventLoop_(sleepMs);
          deadline.lastYield = Date.now();
          deadline.next =
              Date.now() + shaka.text.TtmlTextParser.CHUNK_BUDGET_MS_;
        }
      }
    }

    return shaka.text.TtmlTextParser.finishCue_(
        cueNode, ctx, nestedCues, timeContext, rateInfo, styles,
        regionElements, cueRegions, cellResolution, parentCueElement);
  }

  /**
   * Cheap pre-scan over body > div > p that resolves each content <p>'s
   * presentation [start, end] WITHOUT building cues or resolving styles. Reuses
   * the memoized parseTime_/resolveTime_, so it also warms parseTimeCache_ for
   * the full parse that follows. Used to pick the cues near the playhead for
   * the window-first pass.
   *
   * @param {!Element} body
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {number} periodStart
   * @return {!Array.<{element: !Element, start: number, end: number}>}
   * @private
   */
  static prescanLeaves_(body, rateInfo, periodStart) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const XmlUtils = shaka.util.XmlUtils;
    const leaves = [];
    for (const div of XmlUtils.findChildren(body, 'div')) {
      for (const p of XmlUtils.findChildren(div, 'p')) {
        let {start, end} = TtmlTextParser.parseTime_(p, rateInfo);
        // Resolve relative to ancestors, same walk as finishCue_.
        let parentElement = /** @type {Element} */ (p.parentNode);
        while (parentElement &&
            parentElement.nodeType == Node.ELEMENT_NODE &&
            parentElement.tagName != 'tt') {
          ({start, end} = TtmlTextParser.resolveTime_(
              parentElement, rateInfo, start, end));
          parentElement = /** @type {Element} */ (parentElement.parentNode);
        }
        if (start == null) {
          start = 0;
        }
        start += periodStart;
        if (end == null) {
          end = Infinity;
        } else {
          end += periodStart;
        }
        leaves.push({element: p, start: start, end: end});
      }
    }
    return leaves;
  }

  /**
   * Window-first variant of parseCueContainerChunked_: builds a cue tree with
   * the SAME shape as a full parse (root container -> div containers -> leaf
   * cues) but only for the <p> elements in |selected|. Non-selected <p> are
   * skipped; <div> containers are still descended (and produce empty/no cue if
   * none of their <p> are selected). Reuses prepareCue_/parseCue_/finishCue_ so
   * the produced cues are identical to the full parse. Yields to the event loop
   * via |deadline| (the window is small, so this rarely triggers).
   *
   * @param {!Node} cueNode
   * @param {!Set.<!Element>} selected the <p> elements to parse
   * @param {shaka.extern.TextParser.TimeContext} timeContext
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {!Array.<!Element>} metadataElements
   * @param {!Array.<!Element>} styles
   * @param {!Array.<!Element>} regionElements
   * @param {!Array.<!shaka.text.CueRegion>} cueRegions
   * @param {boolean} whitespaceTrim
   * @param {?{columns: number, rows: number}} cellResolution
   * @param {?Element} parentCueElement
   * @param {boolean} isContent
   * @param {?(string|undefined)} uri
   * @param {{next: number}} deadline shared, mutable wall-clock yield deadline
   * @return {!Promise.<shaka.text.Cue>}
   * @private
   */
  static async parseSelectedLeaves_(
      cueNode, selected, timeContext, rateInfo, metadataElements, styles,
      regionElements, cueRegions, whitespaceTrim, cellResolution,
      parentCueElement, isContent, uri, deadline) {
    // Use full names (no const alias) to avoid JSC_UNSAFE_CTOR_ALIASING.
    const ctx = shaka.text.TtmlTextParser.prepareCue_(
        cueNode, whitespaceTrim, metadataElements, isContent, uri);
    if (!ctx) {
      return null;
    }

    const nestedCues = [];
    if (!ctx.isLeafNode) {
      for (const childNode of ctx.cueElement.childNodes) {
        // Containers (body/div) only carry <div>/<p> element children; ignore
        // text/comments here (parseCue_ would return null for them anyway).
        if (childNode.nodeType != Node.ELEMENT_NODE) {
          continue;
        }
        let nestedCue = null;
        if (childNode.nodeName == 'div') {
          // eslint-disable-next-line no-await-in-loop
          nestedCue = await shaka.text.TtmlTextParser.parseSelectedLeaves_(
              childNode, selected, timeContext, rateInfo, metadataElements,
              styles, regionElements, cueRegions, ctx.localWhitespaceTrim,
              cellResolution, ctx.cueElement, ctx.isContent, uri, deadline);
        } else if (selected.has(/** @type {!Element} */ (childNode))) {
          // A selected <p>: parse its whole subtree with the synchronous path,
          // identical to the full parse.
          nestedCue = shaka.text.TtmlTextParser.parseCue_(
              childNode, timeContext, rateInfo, metadataElements, styles,
              regionElements, cueRegions, ctx.localWhitespaceTrim,
              cellResolution, ctx.cueElement, ctx.isContent, uri);
          if (Date.now() >= deadline.next) {
            // eslint-disable-next-line no-await-in-loop
            await shaka.text.TtmlTextParser.yieldToEventLoop_(
                shaka.text.TtmlTextParser.WARM_SLEEP_MS_);
            deadline.next =
                Date.now() + shaka.text.TtmlTextParser.CHUNK_BUDGET_MS_;
          }
        } else {
          // Not selected; skip (the full parse will pick it up later).
          continue;
        }
        if (nestedCue) {
          nestedCues.push(nestedCue);
        }
      }
    }

    return shaka.text.TtmlTextParser.finishCue_(
        cueNode, ctx, nestedCues, timeContext, rateInfo, styles,
        regionElements, cueRegions, cellResolution, parentCueElement);
  }

  /**
   * First half of parseCue_: resolves the element (converting text nodes into
   * anonymous spans), background image, content flag, whitespace handling and
   * leaf-ness. Returns null for nodes that produce no cue (comments, and text
   * outside content). Shared by the synchronous and chunked parse paths.
   *
   * @param {!Node} cueNode
   * @param {boolean} whitespaceTrim
   * @param {!Array.<!Element>} metadataElements
   * @param {boolean} isContent
   * @param {?(string|undefined)} uri
   * @return {?shaka.text.TtmlTextParser.CueContext_}
   * @private
   */
  static prepareCue_(cueNode, whitespaceTrim, metadataElements, isContent,
      uri) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    /** @type {Element} */
    let cueElement;

    if (cueNode.nodeType == Node.COMMENT_NODE) {
      // The comments do not contain information that interests us here.
      return null;
    }

    if (cueNode.nodeType == Node.TEXT_NODE) {
      if (!isContent) {
        // Ignore text elements outside the content. For example, whitespace
        // on the same lexical level as the <p> elements, in a document with
        // xml:space="preserve", should not be renderer.
        return null;
      }
      // This should generate an "anonymous span" according to the TTML spec.
      // So pretend the element was a <span>.  The original node's parent is
      // used later (via cueNode) to traverse up for timing information.
      const span = document.createElement('span');
      span.textContent = cueNode.textContent;
      cueElement = span;
    } else {
      goog.asserts.assert(cueNode.nodeType == Node.ELEMENT_NODE,
          'nodeType should be ELEMENT_NODE!');
      cueElement = /** @type {!Element} */(cueNode);
    }
    goog.asserts.assert(cueElement, 'cueElement should be non-null!');

    let imageElement = null;
    for (const nameSpace of TtmlTextParser.smpteNsList_) {
      imageElement = TtmlTextParser.getElementsFromCollection_(
          cueElement, 'backgroundImage', metadataElements, '#',
          nameSpace)[0];
      if (imageElement) {
        break;
      }
    }

    let imageUri = null;
    const backgroundImage = shaka.util.XmlUtils.getAttributeNSList(
        cueElement,
        TtmlTextParser.smpteNsList_,
        'backgroundImage');
    if (uri && backgroundImage && !backgroundImage.startsWith('#')) {
      const baseUri = new goog.Uri(uri);
      const relativeUri = new goog.Uri(backgroundImage);
      const newUri = baseUri.resolve(relativeUri).toString();
      if (newUri) {
        imageUri = newUri;
      }
    }

    if (cueNode.nodeName == 'p' || imageElement || imageUri) {
      isContent = true;
    }

    const parentIsContent = isContent;

    const spaceStyle = cueElement.getAttribute('xml:space') ||
        (whitespaceTrim ? 'default' : 'preserve');

    const localWhitespaceTrim = spaceStyle == 'default';

    const isTextNode = (node) => {
      return node.nodeType == Node.TEXT_NODE;
    };
    const isLeafNode = Array.from(cueElement.childNodes).every(isTextNode);

    return {
      cueElement: cueElement,
      imageElement: imageElement,
      imageUri: imageUri,
      isContent: isContent,
      parentIsContent: parentIsContent,
      localWhitespaceTrim: localWhitespaceTrim,
      isLeafNode: isLeafNode,
    };
  }

  /**
   * Second half of parseCue_: given the prepared context and the already-parsed
   * nested cues, resolves timing, builds the Cue, applies region and styles.
   * Shared by the synchronous and chunked parse paths.
   *
   * @param {!Node} cueNode
   * @param {!shaka.text.TtmlTextParser.CueContext_} ctx
   * @param {!Array.<!shaka.text.Cue>} nestedCues
   * @param {shaka.extern.TextParser.TimeContext} timeContext
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {!Array.<!Element>} styles
   * @param {!Array.<!Element>} regionElements
   * @param {!Array.<!shaka.text.CueRegion>} cueRegions
   * @param {?{columns: number, rows: number}} cellResolution
   * @param {?Element} parentCueElement
   * @return {shaka.text.Cue}
   * @private
   */
  static finishCue_(cueNode, ctx, nestedCues, timeContext, rateInfo, styles,
      regionElements, cueRegions, cellResolution, parentCueElement) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const cueElement = ctx.cueElement;
    const localWhitespaceTrim = ctx.localWhitespaceTrim;
    /** @type {Element} */
    let parentElement = /** @type {Element} */ (cueNode.parentNode);

    const isNested = /** @type {boolean} */ (parentCueElement != null);

    const hasTimeAttributes =
        cueElement.hasAttribute('begin') ||
        cueElement.hasAttribute('end') ||
        cueElement.hasAttribute('dur');

    // In this regex, "\S" means "non-whitespace character".  Only evaluate the
    // (expensive, whole-subtree) textContent when there are no nested cues,
    // since that is the only case where the value is used.
    const hasTextContent = nestedCues.length == 0 &&
        /\S/.test(cueElement.textContent);

    if (!hasTimeAttributes && !hasTextContent && cueElement.tagName != 'br' &&
        nestedCues.length == 0) {
      if (!isNested) {
        // Disregards empty <p> elements without time attributes nor content.
        // <p begin="..." smpte:backgroundImage="..." /> will go through,
        // as some information could be held by its attributes.
        // <p /> won't, as it would not be displayed.
        return null;
      } else if (localWhitespaceTrim) {
        // Disregards empty anonymous spans when (local) trim is true.
        return null;
      }
    }

    // Get local time attributes.
    let {start, end} = TtmlTextParser.parseTime_(cueElement, rateInfo);
    // Resolve local time relative to parent elements.  Time elements can appear
    // all the way up to 'body', but not 'tt'.
    while (parentElement && parentElement.nodeType == Node.ELEMENT_NODE &&
        parentElement.tagName != 'tt') {
      ({start, end} = TtmlTextParser.resolveTime_(
          parentElement, rateInfo, start, end));
      parentElement = /** @type {Element} */(parentElement.parentNode);
    }

    if (start == null) {
      start = 0;
    }
    start += timeContext.periodStart;

    // If end is null, that means the duration is effectively infinite.
    if (end == null) {
      end = Infinity;
    } else {
      end += timeContext.periodStart;
    }

    // Clip times to segment boundaries.
    // https://github.com/shaka-project/shaka-player/issues/4631
    start = Math.max(start, timeContext.segmentStart);
    end = Math.min(end, timeContext.segmentEnd);

    if (!hasTimeAttributes && nestedCues.length > 0) {
      // If no time is defined for this cue, base the timing information on
      // the time of the nested cues. In the case of multiple nested cues with
      // different start times, it is the text displayer's responsibility to
      // make sure that only the appropriate nested cue is drawn at any given
      // time.
      start = Infinity;
      end = 0;
      for (const cue of nestedCues) {
        start = Math.min(start, cue.startTime);
        end = Math.max(end, cue.endTime);
      }
    }

    if (cueElement.tagName == 'br') {
      const cue = new shaka.text.Cue(start, end, '');
      cue.lineBreak = true;
      return cue;
    }

    let payload = '';
    if (ctx.isLeafNode) {
      // If the childNodes are all text, this is a leaf node.  Get the payload.
      payload = cueElement.textContent;
      if (localWhitespaceTrim) {
        // Trim leading and trailing whitespace.
        payload = payload.trim();
        // Collapse multiple spaces into one.
        payload = payload.replace(/\s+/g, ' ');
      }
    }

    const cue = new shaka.text.Cue(start, end, payload);
    cue.nestedCues = nestedCues;

    if (!ctx.isContent) {
      // If this is not a <p> element or a <div> with images, and it has no
      // parent that was a <p> element, then it's part of the outer containers
      // (e.g. the <body> or a normal <div> element within it).
      cue.isContainer = true;
    }

    if (cellResolution) {
      cue.cellResolution = cellResolution;
    }

    // Get other properties if available.
    const regionElement = TtmlTextParser.getElementsFromCollection_(
        cueElement, 'region', regionElements, /* prefix= */ '')[0];
    // Do not actually apply that region unless it is non-inherited, though.
    // This makes it so that, if a parent element has a region, the children
    // don't also all independently apply the positioning of that region.
    if (cueElement.hasAttribute('region')) {
      if (regionElement && regionElement.getAttribute('xml:id')) {
        const regionId = regionElement.getAttribute('xml:id');
        cue.region = cueRegions.filter((region) => region.id == regionId)[0];
      }
    }

    let regionElementForStyle = regionElement;
    if (parentCueElement && isNested && !cueElement.getAttribute('region') &&
      !cueElement.getAttribute('style')) {
      regionElementForStyle = TtmlTextParser.getElementsFromCollection_(
          parentCueElement, 'region', regionElements, /* prefix= */ '')[0];
    }

    TtmlTextParser.addStyle_(
        cue,
        cueElement,
        regionElementForStyle,
        ctx.imageElement,
        ctx.imageUri,
        styles,
        // isNested: "nested in a <div>" doesn't count.
        /** isNested= */ ctx.parentIsContent,
        /** isLeaf= */ (nestedCues.length == 0));

    return cue;
  }

  /**
   * Parses an Element into a TextTrackCue or VTTCue.
   *
   * @param {!Element} regionElement
   * @param {!Array.<!Element>} styles Defined in the top of tt  element and
   * used principally for images.
   * @param {?string} globalExtent
   * @return {shaka.text.CueRegion}
   * @private
   */
  static parseCueRegion_(regionElement, styles, globalExtent) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const region = new shaka.text.CueRegion();
    const id = regionElement.getAttribute('xml:id');
    if (!id) {
      shaka.log.warning('TtmlTextParser parser encountered a region with ' +
                        'no id. Region will be ignored.');
      return null;
    }
    region.id = id;

    let globalResults = null;
    if (globalExtent) {
      globalResults = TtmlTextParser.percentValues_.exec(globalExtent) ||
        TtmlTextParser.pixelValues_.exec(globalExtent);
    }
    const globalWidth = globalResults ? Number(globalResults[1]) : null;
    const globalHeight = globalResults ? Number(globalResults[2]) : null;

    let results = null;
    let percentage = null;
    const extent = TtmlTextParser.getStyleAttributeFromRegion_(
        regionElement, styles, 'extent');
    if (extent) {
      percentage = TtmlTextParser.percentValues_.exec(extent);
      results = percentage || TtmlTextParser.pixelValues_.exec(extent);
      if (results != null) {
        region.width = Number(results[1]);
        region.height = Number(results[2]);

        if (!percentage) {
          if (globalWidth != null) {
            region.width = region.width * 100 / globalWidth;
          }
          if (globalHeight != null) {
            region.height = region.height * 100 / globalHeight;
          }
        }

        region.widthUnits = percentage || globalWidth != null ?
                           shaka.text.CueRegion.units.PERCENTAGE :
                           shaka.text.CueRegion.units.PX;

        region.heightUnits = percentage || globalHeight != null ?
                           shaka.text.CueRegion.units.PERCENTAGE :
                           shaka.text.CueRegion.units.PX;
      }
    }

    const origin = TtmlTextParser.getStyleAttributeFromRegion_(
        regionElement, styles, 'origin');
    if (origin) {
      percentage = TtmlTextParser.percentValues_.exec(origin);
      results = percentage || TtmlTextParser.pixelValues_.exec(origin);
      if (results != null) {
        region.viewportAnchorX = Number(results[1]);
        region.viewportAnchorY = Number(results[2]);

        if (!percentage) {
          if (globalHeight != null) {
            region.viewportAnchorY = region.viewportAnchorY * 100 /
              globalHeight;
          }
          if (globalWidth != null) {
            region.viewportAnchorX = region.viewportAnchorX * 100 /
              globalWidth;
          }
        } else if (!extent) {
          region.width = 100 - region.viewportAnchorX;
          region.widthUnits = shaka.text.CueRegion.units.PERCENTAGE;
          region.height = 100 - region.viewportAnchorY;
          region.heightUnits = shaka.text.CueRegion.units.PERCENTAGE;
        }

        region.viewportAnchorUnits = percentage || globalWidth != null ?
                  shaka.text.CueRegion.units.PERCENTAGE :
                  shaka.text.CueRegion.units.PX;
      }
    }

    return region;
  }

  /**
   * Adds applicable style properties to a cue.
   *
   * @param {!shaka.text.Cue} cue
   * @param {!Element} cueElement
   * @param {Element} region
   * @param {Element} imageElement
   * @param {?string} imageUri
   * @param {!Array.<!Element>} styles
   * @param {boolean} isNested
   * @param {boolean} isLeaf
   * @private
   */
  static addStyle_(
      cue, cueElement, region, imageElement, imageUri, styles,
      isNested, isLeaf) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const Cue = shaka.text.Cue;

    // Styles should be inherited from regions, if a style property is not
    // associated with a Content element (or an anonymous span).
    const shouldInheritRegionStyles = isNested || isLeaf;

    const direction = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'direction', shouldInheritRegionStyles);
    if (direction == 'rtl') {
      cue.direction = Cue.direction.HORIZONTAL_RIGHT_TO_LEFT;
    }

    // Direction attribute specifies one-dimentional writing direction
    // (left to right or right to left). Writing mode specifies that
    // plus whether text is vertical or horizontal.
    // They should not contradict each other. If they do, we give
    // preference to writing mode.
    const writingMode = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'writingMode', shouldInheritRegionStyles);
    // Set cue's direction if the text is horizontal, and cue's writingMode if
    // it's vertical.
    if (writingMode == 'tb' || writingMode == 'tblr') {
      cue.writingMode = Cue.writingMode.VERTICAL_LEFT_TO_RIGHT;
    } else if (writingMode == 'tbrl') {
      cue.writingMode = Cue.writingMode.VERTICAL_RIGHT_TO_LEFT;
    } else if (writingMode == 'rltb' || writingMode == 'rl') {
      cue.direction = Cue.direction.HORIZONTAL_RIGHT_TO_LEFT;
    } else if (writingMode) {
      cue.direction = Cue.direction.HORIZONTAL_LEFT_TO_RIGHT;
    }

    const align = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'textAlign', true);
    if (align) {
      cue.positionAlign = TtmlTextParser.textAlignToPositionAlign_[align];
      cue.lineAlign = TtmlTextParser.textAlignToLineAlign_[align];

      goog.asserts.assert(align.toUpperCase() in Cue.textAlign,
          align.toUpperCase() + ' Should be in Cue.textAlign values!');

      cue.textAlign = Cue.textAlign[align.toUpperCase()];
    } else {
      // Default value is START in the TTML spec: https://bit.ly/32OGmvo
      // But to make the subtitle render consitent with other players and the
      // shaka.text.Cue we use CENTER
      cue.textAlign = Cue.textAlign.CENTER;
    }

    const displayAlign = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'displayAlign', true);
    if (displayAlign) {
      goog.asserts.assert(displayAlign.toUpperCase() in Cue.displayAlign,
          displayAlign.toUpperCase() +
                          ' Should be in Cue.displayAlign values!');
      cue.displayAlign = Cue.displayAlign[displayAlign.toUpperCase()];
    }

    const color = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'color', shouldInheritRegionStyles);
    if (color) {
      cue.color = color;
    }

    // Background color should not be set on a container.  If this is a nested
    // cue, you can set the background.  If it's a top-level that happens to
    // also be a leaf, you can set the background.
    // See https://github.com/shaka-project/shaka-player/issues/2623
    // This used to be handled in the displayer, but that is confusing.  The Cue
    // structure should reflect what you want to happen in the displayer, and
    // the displayer shouldn't have to know about TTML.
    const backgroundColor = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'backgroundColor',
        shouldInheritRegionStyles);
    if (backgroundColor) {
      cue.backgroundColor = backgroundColor;
    }

    const border = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'border', shouldInheritRegionStyles);
    if (border) {
      cue.border = border;
    }

    const fontFamily = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'fontFamily', shouldInheritRegionStyles);
    // See https://github.com/sandflow/imscJS/blob/1.1.3/src/main/js/html.js#L1384
    if (fontFamily) {
      switch (fontFamily) {
        case 'monospaceSerif':
          cue.fontFamily = 'Courier New,Liberation Mono,Courier,monospace';
          break;
        case 'proportionalSansSerif':
          cue.fontFamily = 'Arial,Helvetica,Liberation Sans,sans-serif';
          break;
        case 'sansSerif':
          cue.fontFamily = 'sans-serif';
          break;
        case 'monospaceSansSerif':
          cue.fontFamily = 'Consolas,monospace';
          break;
        case 'proportionalSerif':
          cue.fontFamily = 'serif';
          break;
        default:
          cue.fontFamily = fontFamily;
          break;
      }
    }

    const fontWeight = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'fontWeight', shouldInheritRegionStyles);
    if (fontWeight && fontWeight == 'bold') {
      cue.fontWeight = Cue.fontWeight.BOLD;
    }

    const wrapOption = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'wrapOption', shouldInheritRegionStyles);
    if (wrapOption && wrapOption == 'noWrap') {
      cue.wrapLine = false;
    } else {
      cue.wrapLine = true;
    }

    const lineHeight = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'lineHeight', shouldInheritRegionStyles);
    if (lineHeight && lineHeight.match(TtmlTextParser.unitValues_)) {
      cue.lineHeight = lineHeight;
    }

    const fontSize = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'fontSize', shouldInheritRegionStyles);
    if (fontSize) {
      const isValidFontSizeUnit =
          fontSize.match(TtmlTextParser.unitValues_) ||
          fontSize.match(TtmlTextParser.percentValue_);

      if (isValidFontSizeUnit) {
        cue.fontSize = fontSize;
      }
    }

    const fontStyle = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'fontStyle', shouldInheritRegionStyles);
    if (fontStyle) {
      goog.asserts.assert(fontStyle.toUpperCase() in Cue.fontStyle,
          fontStyle.toUpperCase() +
                          ' Should be in Cue.fontStyle values!');
      cue.fontStyle = Cue.fontStyle[fontStyle.toUpperCase()];
    }

    if (imageElement) {
      // According to the spec, we should use imageType (camelCase), but
      // historically we have checked for imagetype (lowercase).
      // This was the case since background image support was first introduced
      // in PR #1859, in April 2019, and first released in v2.5.0.
      // Now we check for both, although only imageType (camelCase) is to spec.
      const backgroundImageType =
          imageElement.getAttribute('imageType') ||
          imageElement.getAttribute('imagetype');
      const backgroundImageEncoding = imageElement.getAttribute('encoding');
      const backgroundImageData = imageElement.textContent.trim();
      if (backgroundImageType == 'PNG' &&
          backgroundImageEncoding == 'Base64' &&
          backgroundImageData) {
        cue.backgroundImage = 'data:image/png;base64,' + backgroundImageData;
      }
    } else if (imageUri) {
      cue.backgroundImage = imageUri;
    }

    const textOutline = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'textOutline', shouldInheritRegionStyles);
    if (textOutline) {
      // tts:textOutline isn't natively supported by browsers, but it can be
      // mostly replicated using the non-standard -webkit-text-stroke-width and
      // -webkit-text-stroke-color properties.
      const split = textOutline.split(' ');
      if (split[0].match(TtmlTextParser.unitValues_)) {
        // There is no defined color, so default to the text color.
        cue.textStrokeColor = cue.color;
      } else {
        cue.textStrokeColor = split[0];
        split.shift();
      }
      if (split[0] && split[0].match(TtmlTextParser.unitValues_)) {
        cue.textStrokeWidth = split[0];
      } else {
        // If there is no width, or the width is not a number, don't draw a
        // border.
        cue.textStrokeColor = '';
      }
      // There is an optional blur radius also, but we have no way of
      // replicating that, so ignore it.
    }

    const letterSpacing = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'letterSpacing', shouldInheritRegionStyles);
    if (letterSpacing && letterSpacing.match(TtmlTextParser.unitValues_)) {
      cue.letterSpacing = letterSpacing;
    }

    const linePadding = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'linePadding', shouldInheritRegionStyles);
    if (linePadding && linePadding.match(TtmlTextParser.unitValues_)) {
      cue.linePadding = linePadding;
    }

    const opacity = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'opacity', shouldInheritRegionStyles);
    if (opacity) {
      cue.opacity = parseFloat(opacity);
    }

    // Text decoration is an array of values which can come both from the
    // element's style or be inherited from elements' parent nodes. All of those
    // values should be applied as long as they don't contradict each other. If
    // they do, elements' own style gets preference.
    const textDecorationRegion = TtmlTextParser.getStyleAttributeFromRegion_(
        region, styles, 'textDecoration');
    if (textDecorationRegion) {
      TtmlTextParser.addTextDecoration_(cue, textDecorationRegion);
    }

    const textDecorationElement = TtmlTextParser.getStyleAttributeFromElement_(
        cueElement, styles, 'textDecoration');
    if (textDecorationElement) {
      TtmlTextParser.addTextDecoration_(cue, textDecorationElement);
    }

    const textCombine = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'textCombine', shouldInheritRegionStyles);
    if (textCombine) {
      cue.textCombineUpright = textCombine;
    }

    const ruby = TtmlTextParser.getStyleAttribute_(
        cueElement, region, styles, 'ruby', shouldInheritRegionStyles);
    switch (ruby) {
      case 'container':
        cue.rubyTag = 'ruby';
        break;
      case 'text':
        cue.rubyTag = 'rt';
        break;
    }
  }

  /**
   * Parses text decoration values and adds/removes them to/from the cue.
   *
   * @param {!shaka.text.Cue} cue
   * @param {string} decoration
   * @private
   */
  static addTextDecoration_(cue, decoration) {
    const Cue = shaka.text.Cue;
    for (const value of decoration.split(' ')) {
      switch (value) {
        case 'underline':
          if (!cue.textDecoration.includes(Cue.textDecoration.UNDERLINE)) {
            cue.textDecoration.push(Cue.textDecoration.UNDERLINE);
          }
          break;
        case 'noUnderline':
          if (cue.textDecoration.includes(Cue.textDecoration.UNDERLINE)) {
            shaka.util.ArrayUtils.remove(cue.textDecoration,
                Cue.textDecoration.UNDERLINE);
          }
          break;
        case 'lineThrough':
          if (!cue.textDecoration.includes(Cue.textDecoration.LINE_THROUGH)) {
            cue.textDecoration.push(Cue.textDecoration.LINE_THROUGH);
          }
          break;
        case 'noLineThrough':
          if (cue.textDecoration.includes(Cue.textDecoration.LINE_THROUGH)) {
            shaka.util.ArrayUtils.remove(cue.textDecoration,
                Cue.textDecoration.LINE_THROUGH);
          }
          break;
        case 'overline':
          if (!cue.textDecoration.includes(Cue.textDecoration.OVERLINE)) {
            cue.textDecoration.push(Cue.textDecoration.OVERLINE);
          }
          break;
        case 'noOverline':
          if (cue.textDecoration.includes(Cue.textDecoration.OVERLINE)) {
            shaka.util.ArrayUtils.remove(cue.textDecoration,
                Cue.textDecoration.OVERLINE);
          }
          break;
      }
    }
  }

  /**
   * Finds a specified attribute on either the original cue element or its
   * associated region and returns the value if the attribute was found.
   *
   * @param {!Element} cueElement
   * @param {Element} region
   * @param {!Array.<!Element>} styles
   * @param {string} attribute
   * @param {boolean=} shouldInheritRegionStyles
   * @return {?string}
   * @private
   */
  static getStyleAttribute_(cueElement, region, styles, attribute,
      shouldInheritRegionStyles=true) {
    // An attribute can be specified on region level or in a styling block
    // associated with the region or original element.
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const attr = TtmlTextParser.getStyleAttributeFromElement_(
        cueElement, styles, attribute);
    if (attr) {
      return attr;
    }

    if (shouldInheritRegionStyles) {
      return TtmlTextParser.getStyleAttributeFromRegion_(
          region, styles, attribute);
    }
    return null;
  }

  /**
   * Finds a specified attribute on the element's associated region
   * and returns the value if the attribute was found.
   *
   * @param {Element} region
   * @param {!Array.<!Element>} styles
   * @param {string} attribute
   * @return {?string}
   * @private
   */
  static getStyleAttributeFromRegion_(region, styles, attribute) {
    const TtmlTextParser = shaka.text.TtmlTextParser;

    if (!region) {
      return null;
    }

    // PERF: el resultado depende solo de (region, attribute) (styles es
    // constante durante el parseo). La misma <region> la consultan miles de
    // cues, asi que memoizar evita repetir las lecturas getAttributeNS.
    let perReg = TtmlTextParser.regionStyleCache_.get(region);
    if (perReg) {
      if (perReg.has(attribute)) {
        return perReg.get(attribute);
      }
    } else {
      perReg = new Map();
      TtmlTextParser.regionStyleCache_.set(region, perReg);
    }

    const attr = TtmlTextParser.getStyleBag_(region).tts.get(attribute);
    const result = attr ? attr : TtmlTextParser.getInheritedStyleAttribute_(
        region, styles, attribute);
    perReg.set(attribute, result);
    return result;
  }

  /**
   * Finds a specified attribute on the cue element and returns the value
   * if the attribute was found.
   *
   * @param {!Element} cueElement
   * @param {!Array.<!Element>} styles
   * @param {string} attribute
   * @return {?string}
   * @private
   */
  static getStyleAttributeFromElement_(cueElement, styles, attribute) {
    const TtmlTextParser = shaka.text.TtmlTextParser;

    // PERF: depende solo de (cueElement, attribute). Para los <style>
    // compartidos (alcanzados por recursion desde muchos cues) memoizar evita
    // releer sus atributos una y otra vez. Comportamiento identico.
    let perEl = TtmlTextParser.elementStyleCache_.get(cueElement);
    if (perEl) {
      if (perEl.has(attribute)) {
        return perEl.get(attribute);
      }
    } else {
      perEl = new Map();
      TtmlTextParser.elementStyleCache_.set(cueElement, perEl);
    }

    // Styling on elements should take precedence
    // over the main styling attributes
    const elementAttribute = TtmlTextParser.getStyleBag_(cueElement).tts.get(
        attribute);

    const result = elementAttribute ? elementAttribute :
        TtmlTextParser.getInheritedStyleAttribute_(
            cueElement, styles, attribute);
    perEl.set(attribute, result);
    return result;
  }

  /**
   * Finds a specified attribute on an element's styles and the styles those
   * styles inherit from.
   *
   * @param {!Element} element
   * @param {!Array.<!Element>} styles
   * @param {string} attribute
   * @return {?string}
   * @private
   */
  static getInheritedStyleAttribute_(element, styles, attribute) {
    const TtmlTextParser = shaka.text.TtmlTextParser;

    // PERF: depende solo de (element, attribute). Memoizar colapsa las miles de
    // re-resoluciones de las <region>/<style> compartidas. Comportamiento
    // identico.
    let perEl = TtmlTextParser.inheritedStyleCache_.get(element);
    if (perEl) {
      if (perEl.has(attribute)) {
        return perEl.get(attribute);
      }
    } else {
      perEl = new Map();
      TtmlTextParser.inheritedStyleCache_.set(element, perEl);
    }

    const inheritedStyles =
        TtmlTextParser.getElementsFromCollection_(
            element, 'style', styles, /* prefix= */ '');

    let styleValue = null;

    // The last value in our styles stack takes the precedence over the others
    for (let i = 0; i < inheritedStyles.length; i++) {
      // Check ebu namespace first, then fall back to tts namespace.  This read
      // is memoized per (style element, attribute): los <style> son compartidos
      // y antes se releian con getAttributeNS una vez por cada cue que los usa.
      let styleAttributeValue = TtmlTextParser.getOwnStyleAttribute_(
          inheritedStyles[i], attribute);

      if (!styleAttributeValue) {
        // Next, check inheritance.
        // Styles can inherit from other styles, so traverse up that chain.
        styleAttributeValue = TtmlTextParser.getStyleAttributeFromElement_(
            inheritedStyles[i], styles, attribute);
      }

      if (styleAttributeValue) {
        styleValue = styleAttributeValue;
      }
    }

    perEl.set(attribute, styleValue);
    return styleValue;
  }


  /**
   * Reads an element's own style attribute, checking the EBU-TT namespace
   * first and falling back to the tts namespace (matching the previous inline
   * logic). Memoized per (element, attribute): the <style> elements are shared
   * and were previously re-read once per cue that referenced them.
   *
   * @param {!Element} element
   * @param {string} attribute
   * @return {?string}
   * @private
   */
  static getOwnStyleAttribute_(element, attribute) {
    const bag = shaka.text.TtmlTextParser.getStyleBag_(element);
    // Check ebu namespace first, then fall back to tts namespace.
    const value = bag.ebutts.get(attribute) || bag.tts.get(attribute);
    return value || null;
  }


  /**
   * Builds (and memoizes) a "property bag" for a single element: one pass over
   * element.attributes dumping its tts: and ebutts: styling attributes into
   * Maps keyed by local name. This replaces the per-attribute getAttributeNS /
   * getAttributeNSList calls (which on old TVs were ~200K hasAttributeNS calls
   * across all cues) with O(1) Map lookups. tts namespace styleNs_[0] wins over
   * styleNs_[1], matching getAttributeNSList's nsList iteration order.
   *
   * @param {!Element} element
   * @return {{tts: !Map.<string, string>, ebutts: !Map.<string, string>}}
   * @private
   */
  static getStyleBag_(element) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    let bag = TtmlTextParser.styleBagCache_.get(element);
    if (bag) {
      return bag;
    }
    const styleNs = TtmlTextParser.styleNs_;
    const ebuttsNs = TtmlTextParser.styleEbuttsNs_;
    const tts = new Map();
    const ebutts = new Map();
    const attributes = element.attributes;
    for (let i = 0; i < attributes.length; i++) {
      const attr = attributes[i];
      const ns = attr.namespaceURI;
      if (ns == styleNs[0]) {
        // styleNs_[0] has priority, so override any styleNs_[1] value.
        tts.set(attr.localName, attr.value);
      } else if (ns == styleNs[1]) {
        if (!tts.has(attr.localName)) {
          tts.set(attr.localName, attr.value);
        }
      } else if (ns == ebuttsNs) {
        ebutts.set(attr.localName, attr.value);
      }
    }
    bag = {tts: tts, ebutts: ebutts};
    TtmlTextParser.styleBagCache_.set(element, bag);
    return bag;
  }


  /**
   * Selects items from |collection| whose id matches |attributeName|
   * from |element|.
   *
   * @param {Element} element
   * @param {string} attributeName
   * @param {!Array.<Element>} collection
   * @param {string} prefixName
   * @param {string=} nsName
   * @return {!Array.<!Element>}
   * @private
   */
  static getElementsFromCollection_(
      element, attributeName, collection, prefixName, nsName) {
    if (!element || collection.length < 1) {
      return [];
    }

    // PERF: este metodo se llamaba ~22 veces por cue (una por atributo de
    // estilo) y por cada id escaneaba linealmente TODA la coleccion de
    // <style>/<region>, repitiendo el mismo trabajo para cada atributo del
    // mismo elemento. En TVs antiguas (webOS 2016) esto suponia ~90% del
    // tiempo de parseo (addStyle). Cacheamos (a) el resultado por
    // elemento+args y (b) un Map id->elemento por coleccion, dejando el
    // lookup en O(1). Comportamiento identico.
    const TtmlTextParser = shaka.text.TtmlTextParser;
    const cacheKey =
        attributeName + ' ' + prefixName + ' ' + (nsName || '');
    let perElement = TtmlTextParser.elementCollectionCache_.get(element);
    if (perElement) {
      const cached = perElement.get(cacheKey);
      if (cached) {
        return cached;
      }
    } else {
      perElement = new Map();
      TtmlTextParser.elementCollectionCache_.set(element, perElement);
    }

    const items = [];
    const attributeValue =
        TtmlTextParser.getInheritedAttribute_(element, attributeName, nsName);

    if (attributeValue) {
      const lookup =
          TtmlTextParser.getCollectionLookup_(collection, prefixName);
      // There could be multiple items in one attribute
      // <span style="style1 style2">A cue</span>
      for (const name of attributeValue.split(' ')) {
        const item = lookup.get(name);
        if (item) {
          items.push(item);
        }
      }
    }

    perElement.set(cacheKey, items);
    return items;
  }


  /**
   * Builds (and caches) a map from |prefixName| + xml:id to the matching
   * element in |collection|, so callers can resolve ids in O(1) instead of
   * scanning the whole collection each time.
   *
   * @param {!Array.<Element>} collection
   * @param {string} prefixName
   * @return {!Map.<string, !Element>}
   * @private
   */
  static getCollectionLookup_(collection, prefixName) {
    const TtmlTextParser = shaka.text.TtmlTextParser;
    let byPrefix = TtmlTextParser.collectionLookups_.get(collection);
    if (!byPrefix) {
      byPrefix = new Map();
      TtmlTextParser.collectionLookups_.set(collection, byPrefix);
    }
    let lookup = byPrefix.get(prefixName);
    if (!lookup) {
      lookup = new Map();
      for (const item of collection) {
        const key = prefixName + item.getAttribute('xml:id');
        // Keep the first match to mirror the previous linear-scan + break.
        if (!lookup.has(key)) {
          lookup.set(key, item);
        }
      }
      byPrefix.set(prefixName, lookup);
    }
    return lookup;
  }


  /**
   * Traverses upwards from a given node until a given attribute is found.
   *
   * @param {!Element} element
   * @param {string} attributeName
   * @param {string=} nsName
   * @return {?string}
   * @private
   */
  static getInheritedAttribute_(element, attributeName, nsName) {
    let ret = null;
    const XmlUtils = shaka.util.XmlUtils;
    while (element) {
      ret = nsName ?
          XmlUtils.getAttributeNS(element, nsName, attributeName) :
          element.getAttribute(attributeName);
      if (ret) {
        break;
      }

      // Element.parentNode can lead to XMLDocument, which is not an Element and
      // has no getAttribute().
      const parentNode = element.parentNode;
      if (parentNode instanceof Element) {
        element = parentNode;
      } else {
        break;
      }
    }
    return ret;
  }

  /**
   * Factor parent/ancestor time attributes into the parsed time of a
   * child/descendent.
   *
   * @param {!Element} parentElement
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {?number} start The child's start time
   * @param {?number} end The child's end time
   * @return {{start: ?number, end: ?number}}
   * @private
   */
  static resolveTime_(parentElement, rateInfo, start, end) {
    const parentTime = shaka.text.TtmlTextParser.parseTime_(
        parentElement, rateInfo);

    if (start == null) {
      // No start time of your own?  Inherit from the parent.
      start = parentTime.start;
    } else {
      // Otherwise, the start time is relative to the parent's start time.
      if (parentTime.start != null) {
        start += parentTime.start;
      }
    }

    if (end == null) {
      // No end time of your own?  Inherit from the parent.
      end = parentTime.end;
    } else {
      // Otherwise, the end time is relative to the parent's _start_ time.
      // This is not a typo.  Both times are relative to the parent's _start_.
      if (parentTime.start != null) {
        end += parentTime.start;
      }
    }

    return {start, end};
  }

  /**
   * Parse TTML time attributes from the given element.
   *
   * @param {!Element} element
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @return {{start: ?number, end: ?number}}
   * @private
   */
  static parseTime_(element, rateInfo) {
    const TtmlTextParser = shaka.text.TtmlTextParser;

    // PERF: resolveTime_ llama parseTime_(parentElement) subiendo por los
    // ancestros, de modo que el tiempo de cada <div>/<p> padre se re-parseaba
    // una vez por cada descendiente. rateInfo es constante durante el parseo,
    // asi que el resultado depende solo del elemento. Memoizar colapsa ese
    // trabajo repetido. El objeto devuelto solo se lee, nunca se muta.
    const cached = TtmlTextParser.parseTimeCache_.get(element);
    if (cached) {
      return cached;
    }

    const start = TtmlTextParser.parseTimeAttribute_(
        element.getAttribute('begin'), rateInfo);
    let end = TtmlTextParser.parseTimeAttribute_(
        element.getAttribute('end'), rateInfo);
    const duration = TtmlTextParser.parseTimeAttribute_(
        element.getAttribute('dur'), rateInfo);
    if (end == null && duration != null) {
      end = start + duration;
    }
    const result = {start, end};
    TtmlTextParser.parseTimeCache_.set(element, result);
    return result;
  }

  /**
   * Parses a TTML time from the given attribute text.
   *
   * @param {string} text
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @return {?number}
   * @private
   */
  static parseTimeAttribute_(text, rateInfo) {
    let ret = null;
    const TtmlTextParser = shaka.text.TtmlTextParser;

    if (TtmlTextParser.timeColonFormatFrames_.test(text)) {
      ret = TtmlTextParser.parseColonTimeWithFrames_(rateInfo, text);
    } else if (TtmlTextParser.timeColonFormat_.test(text)) {
      ret = TtmlTextParser.parseTimeFromRegex_(
          TtmlTextParser.timeColonFormat_, text);
    } else if (TtmlTextParser.timeColonFormatMilliseconds_.test(text)) {
      ret = TtmlTextParser.parseTimeFromRegex_(
          TtmlTextParser.timeColonFormatMilliseconds_, text);
    } else if (TtmlTextParser.timeFramesFormat_.test(text)) {
      ret = TtmlTextParser.parseFramesTime_(rateInfo, text);
    } else if (TtmlTextParser.timeTickFormat_.test(text)) {
      ret = TtmlTextParser.parseTickTime_(rateInfo, text);
    } else if (TtmlTextParser.timeHMSFormat_.test(text)) {
      ret = TtmlTextParser.parseTimeFromRegex_(
          TtmlTextParser.timeHMSFormat_, text);
    } else if (text) {
      // It's not empty or null, but it doesn't match a known format.
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.TEXT,
          shaka.util.Error.Code.INVALID_TEXT_CUE,
          'Could not parse cue time range in TTML');
    }

    return ret;
  }

  /**
   * Parses a TTML time in frame format.
   *
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {string} text
   * @return {?number}
   * @private
   */
  static parseFramesTime_(rateInfo, text) {
    // 75f or 75.5f
    const results = shaka.text.TtmlTextParser.timeFramesFormat_.exec(text);
    const frames = Number(results[1]);

    return frames / rateInfo.frameRate;
  }

  /**
   * Parses a TTML time in tick format.
   *
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {string} text
   * @return {?number}
   * @private
   */
  static parseTickTime_(rateInfo, text) {
    // 50t or 50.5t
    const results = shaka.text.TtmlTextParser.timeTickFormat_.exec(text);
    const ticks = Number(results[1]);

    return ticks / rateInfo.tickRate;
  }

  /**
   * Parses a TTML colon formatted time containing frames.
   *
   * @param {!shaka.text.TtmlTextParser.RateInfo_} rateInfo
   * @param {string} text
   * @return {?number}
   * @private
   */
  static parseColonTimeWithFrames_(rateInfo, text) {
    // 01:02:43:07 ('07' is frames) or 01:02:43:07.1 (subframes)
    const results = shaka.text.TtmlTextParser.timeColonFormatFrames_.exec(text);

    const hours = Number(results[1]);
    const minutes = Number(results[2]);
    let seconds = Number(results[3]);
    let frames = Number(results[4]);
    const subframes = Number(results[5]) || 0;

    frames += subframes / rateInfo.subFrameRate;
    seconds += frames / rateInfo.frameRate;

    return seconds + (minutes * 60) + (hours * 3600);
  }

  /**
   * Parses a TTML time with a given regex. Expects regex to be some
   * sort of a time-matcher to match hours, minutes, seconds and milliseconds
   *
   * @param {!RegExp} regex
   * @param {string} text
   * @return {?number}
   * @private
   */
  static parseTimeFromRegex_(regex, text) {
    const results = regex.exec(text);
    if (results == null || results[0] == '') {
      return null;
    }
    // This capture is optional, but will still be in the array as undefined,
    // in which case it is 0.
    const hours = Number(results[1]) || 0;
    const minutes = Number(results[2]) || 0;
    const seconds = Number(results[3]) || 0;
    const milliseconds = Number(results[4]) || 0;

    return (milliseconds / 1000) + seconds + (minutes * 60) + (hours * 3600);
  }

  /**
   * If ttp:cellResolution provided returns cell resolution info
   * with number of columns and rows into which the Root Container
   * Region area is divided
   *
   * @param {?string} cellResolution
   * @return {?{columns: number, rows: number}}
   * @private
   */
  static getCellResolution_(cellResolution) {
    if (!cellResolution) {
      return null;
    }
    const matches = /^(\d+) (\d+)$/.exec(cellResolution);

    if (!matches) {
      return null;
    }

    const columns = parseInt(matches[1], 10);
    const rows = parseInt(matches[2], 10);

    return {columns, rows};
  }
};

/**
 * @summary
 * Contains information about frame/subframe rate
 * and frame rate multiplier for time in frame format.
 *
 * @example 01:02:03:04(4 frames) or 01:02:03:04.1(4 frames, 1 subframe)
 * @private
 */
shaka.text.TtmlTextParser.RateInfo_ = class {
  /**
   * @param {?string} frameRate
   * @param {?string} subFrameRate
   * @param {?string} frameRateMultiplier
   * @param {?string} tickRate
   */
  constructor(frameRate, subFrameRate, frameRateMultiplier, tickRate) {
    /**
     * @type {number}
     */
    this.frameRate = Number(frameRate) || 30;

    /**
     * @type {number}
     */
    this.subFrameRate = Number(subFrameRate) || 1;

    /**
     * @type {number}
     */
    this.tickRate = Number(tickRate);
    if (this.tickRate == 0) {
      if (frameRate) {
        this.tickRate = this.frameRate * this.subFrameRate;
      } else {
        this.tickRate = 1;
      }
    }

    if (frameRateMultiplier) {
      const multiplierResults = /^(\d+) (\d+)$/g.exec(frameRateMultiplier);
      if (multiplierResults) {
        const numerator = Number(multiplierResults[1]);
        const denominator = Number(multiplierResults[2]);
        const multiplierNum = numerator / denominator;
        this.frameRate *= multiplierNum;
      }
    }
  }
};

/**
 * @const
 * @private {!RegExp}
 * @example 50.17% 10%
 */
shaka.text.TtmlTextParser.percentValues_ =
    /^(\d{1,2}(?:\.\d+)?|100(?:\.0+)?)% (\d{1,2}(?:\.\d+)?|100(?:\.0+)?)%$/;

/**
 * @const
 * @private {!RegExp}
 * @example 0.6% 90%
 */
shaka.text.TtmlTextParser.percentValue_ = /^(\d{1,2}(?:\.\d+)?|100)%$/;

/**
 * @const
 * @private {!RegExp}
 * @example 100px, 8em, 0.80c
 */
shaka.text.TtmlTextParser.unitValues_ = /^(\d+px|\d+em|\d*\.?\d+c)$/;

/**
 * @const
 * @private {!RegExp}
 * @example 100px
 */
shaka.text.TtmlTextParser.pixelValues_ = /^(\d+)px (\d+)px$/;

/**
 * @const
 * @private {!RegExp}
 * @example 00:00:40:07 (7 frames) or 00:00:40:07.1 (7 frames, 1 subframe)
 */
shaka.text.TtmlTextParser.timeColonFormatFrames_ =
    /^(\d{2,}):(\d{2}):(\d{2}):(\d{2})\.?(\d+)?$/;

/**
 * @const
 * @private {!RegExp}
 * @example 00:00:40 or 00:40
 */
shaka.text.TtmlTextParser.timeColonFormat_ = /^(?:(\d{2,}):)?(\d{2}):(\d{2})$/;

/**
 * @const
 * @private {!RegExp}
 * @example 01:02:43.0345555 or 02:43.03
 */
shaka.text.TtmlTextParser.timeColonFormatMilliseconds_ =
    /^(?:(\d{2,}):)?(\d{2}):(\d{2}\.\d{2,})$/;

/**
 * @const
 * @private {!RegExp}
 * @example 75f or 75.5f
 */
shaka.text.TtmlTextParser.timeFramesFormat_ = /^(\d*(?:\.\d*)?)f$/;

/**
 * @const
 * @private {!RegExp}
 * @example 50t or 50.5t
 */
shaka.text.TtmlTextParser.timeTickFormat_ = /^(\d*(?:\.\d*)?)t$/;

/**
 * @const
 * @private {!RegExp}
 * @example 3.45h, 3m or 4.20s
 */
shaka.text.TtmlTextParser.timeHMSFormat_ =
    new RegExp(['^(?:(\\d*(?:\\.\\d*)?)h)?',
      '(?:(\\d*(?:\\.\\d*)?)m)?',
      '(?:(\\d*(?:\\.\\d*)?)s)?',
      '(?:(\\d*(?:\\.\\d*)?)ms)?$'].join(''));

/**
 * @const
 * @private {!Object.<string, shaka.text.Cue.lineAlign>}
 */
shaka.text.TtmlTextParser.textAlignToLineAlign_ = {
  'left': shaka.text.Cue.lineAlign.START,
  'center': shaka.text.Cue.lineAlign.CENTER,
  'right': shaka.text.Cue.lineAlign.END,
  'start': shaka.text.Cue.lineAlign.START,
  'end': shaka.text.Cue.lineAlign.END,
};

/**
 * @const
 * @private {!Object.<string, shaka.text.Cue.positionAlign>}
 */
shaka.text.TtmlTextParser.textAlignToPositionAlign_ = {
  'left': shaka.text.Cue.positionAlign.LEFT,
  'center': shaka.text.Cue.positionAlign.CENTER,
  'right': shaka.text.Cue.positionAlign.RIGHT,
};

/**
 * The namespace URL for TTML parameters.  Can be assigned any name in the TTML
 * document, not just "ttp:", so we use this with getAttributeNS() to ensure
 * that we support arbitrary namespace names.
 *
 * @const {!Array.<string>}
 * @private
 */
shaka.text.TtmlTextParser.parameterNs_ = [
  'http://www.w3.org/ns/ttml#parameter',
  'http://www.w3.org/2006/10/ttaf1#parameter',
];

/**
 * The namespace URL for TTML styles.  Can be assigned any name in the TTML
 * document, not just "tts:", so we use this with getAttributeNS() to ensure
 * that we support arbitrary namespace names.
 *
 * @const {!Array.<string>}
 * @private
 */
shaka.text.TtmlTextParser.styleNs_ = [
  'http://www.w3.org/ns/ttml#styling',
  'http://www.w3.org/2006/10/ttaf1#styling',
];

/**
 * The namespace URL for EBU TTML styles.  Can be assigned any name in the TTML
 * document, not just "ebutts:", so we use this with getAttributeNS() to ensure
 * that we support arbitrary namespace names.
 *
 * @const {string}
 * @private
 */
shaka.text.TtmlTextParser.styleEbuttsNs_ = 'urn:ebu:tt:style';

/**
 * The supported namespace URLs for SMPTE fields.
 * @const {!Array.<string>}
 * @private
 */
shaka.text.TtmlTextParser.smpteNsList_ = [
  'http://www.smpte-ra.org/schemas/2052-1/2010/smpte-tt',
  'http://www.smpte-ra.org/schemas/2052-1/2013/smpte-tt',
];

/**
 * Document-level parse context produced by setupParse_ and consumed by
 * parseMedia / parseMediaChunked.
 *
 * @typedef {{
 *   body: !Element,
 *   rateInfo: !shaka.text.TtmlTextParser.RateInfo_,
 *   metadataElements: !Array.<!Element>,
 *   styles: !Array.<!Element>,
 *   regionElements: !Array.<!Element>,
 *   cueRegions: !Array.<!shaka.text.CueRegion>,
 *   whitespaceTrim: boolean,
 *   cellResolution: ?{columns: number, rows: number}
 * }}
 * @private
 */
shaka.text.TtmlTextParser.ParseContext_;

/**
 * Per-node context produced by prepareCue_ and consumed by finishCue_.
 *
 * @typedef {{
 *   cueElement: !Element,
 *   imageElement: Element,
 *   imageUri: ?string,
 *   isContent: boolean,
 *   parentIsContent: boolean,
 *   localWhitespaceTrim: boolean,
 *   isLeafNode: boolean
 * }}
 * @private
 */
shaka.text.TtmlTextParser.CueContext_;

/**
 * PERF: cache (collection array -> (prefix -> (id -> element))) usado por
 * getElementsFromCollection_/getCollectionLookup_. Se indexa por la coleccion,
 * que es nueva en cada parseMedia (Array.from), asi que las entradas viejas se
 * recogen solas (WeakMap). Se reinicia explicitamente en parseMedia.
 *
 * @private {!WeakMap.<!Array.<Element>, !Map.<string, !Map>>}
 */
shaka.text.TtmlTextParser.collectionLookups_ = new WeakMap();

/**
 * PERF: memoiza el resultado de getElementsFromCollection_ por elemento, ya que
 * addStyle_ lo invoca ~22 veces (una por atributo) con los mismos argumentos.
 *
 * @private {!WeakMap.<!Element, !Map.<string, !Array.<!Element>>>}
 */
shaka.text.TtmlTextParser.elementCollectionCache_ = new WeakMap();

/**
 * PERF: memoiza getStyleAttributeFromRegion_ por (region -> atributo -> valor).
 *
 * @private {!WeakMap.<!Element, !Map.<string, ?string>>}
 */
shaka.text.TtmlTextParser.regionStyleCache_ = new WeakMap();

/**
 * PERF: memoiza getStyleAttributeFromElement_ por (elemento -> atributo).
 *
 * @private {!WeakMap.<!Element, !Map.<string, ?string>>}
 */
shaka.text.TtmlTextParser.elementStyleCache_ = new WeakMap();

/**
 * PERF: memoiza getInheritedStyleAttribute_ por (elemento -> atributo).
 *
 * @private {!WeakMap.<!Element, !Map.<string, ?string>>}
 */
shaka.text.TtmlTextParser.inheritedStyleCache_ = new WeakMap();

/**
 * PERF: cachea el "property bag" (atributos tts:/ebutts:) de cada elemento,
 * construido en una sola pasada por element.attributes. Ver getStyleBag_.
 *
 * @private {!WeakMap.<!Element, {tts: !Map, ebutts: !Map}>}
 */
shaka.text.TtmlTextParser.styleBagCache_ = new WeakMap();

/**
 * PERF: memoiza parseTime_ por elemento. resolveTime_ re-parsea el tiempo de
 * los ancestros una vez por descendiente; cachear lo colapsa.
 *
 * @private {!WeakMap.<!Element, {start: ?number, end: ?number}>}
 */
shaka.text.TtmlTextParser.parseTimeCache_ = new WeakMap();

/**
 * PERF: cache persistente (no por-parseo) de resultados de parseMedia, clave
 * por (uri + ventana temporal). Permite que volver a un subtitulo ya visto sea
 * instantaneo. LRU acotada en parseMedia. Seguro porque los Cue no se mutan.
 *
 * @private {!Map.<string, !Array.<!shaka.text.Cue>>}
 */
shaka.text.TtmlTextParser.parseCache_ = new Map();

/**
 * PERF: presupuesto de tiempo (ms) entre cesiones al event loop en
 * parseCueContainerChunked_. Mayor = menos overhead de yields pero ventanas de
 * bloqueo mas largas; menor = UI mas fluida pero mas overhead.
 *
 * @const {number}
 * @private
 */
shaka.text.TtmlTextParser.CHUNK_BUDGET_MS_ = 15;

/**
 * PERF: tiempo real (ms) que se duerme en cada cesion al event loop. Damos al
 * pipeline de decodificacion de video de TVs lentas (webOS 2016) una ventana
 * contigua para trabajar entre nuestros trozos de parseo, de modo que el video
 * no se congele. Subir = video mas fluido pero parseo mas lento; bajar = al
 * reves. Con CHUNK_BUDGET_MS_=10 y este valor, el ratio trabajo:video es
 * aprox 10:YIELD_SLEEP_MS_.
 *
 * @const {number}
 * @private
 */
shaka.text.TtmlTextParser.YIELD_SLEEP_MS_ = 30;

/**
 * PERF: durante los primeros RAMP_MS_ del parseo (arranque en frio, el buffer
 * de video se esta llenando) se usa el sleep "frio" (YIELD_SLEEP_MS_, suave).
 * Pasado ese tiempo el buffer ya deberia estar sano y se usa WARM_SLEEP_MS_
 * (mas corto) para terminar el parseo mas rapido sin volver a ahogar el video.
 *
 * @const {number}
 * @private
 */
shaka.text.TtmlTextParser.RAMP_MS_ = 4000;

/**
 * PERF: sleep (ms) por cesion una vez superada la rampa (buffer ya sano).
 *
 * @const {number}
 * @private
 */
shaka.text.TtmlTextParser.WARM_SLEEP_MS_ = 8;

/**
 * PERF (window-first): segundos hacia atras respecto a currentTime incluidos en
 * la ventana inicial (para que un subtitulo ya en pantalla se muestre al
 * instante).
 *
 * @const {number}
 * @private
 */
shaka.text.TtmlTextParser.WINDOW_BACK_S_ = 5;

/**
 * PERF (window-first): segundos hacia delante respecto a currentTime incluidos
 * en la ventana inicial que se parsea y muestra primero.
 *
 * @const {number}
 * @private
 */
shaka.text.TtmlTextParser.WINDOW_FWD_S_ = 60;

/**
 * PERF (window-first): solo se activa el parseo "ventana primero" si el TTML
 * tiene al menos este numero de cues <p>. Por debajo, el parseo completo ya es
 * rapido y no merece la pena (VTT/segmentado normal sin cambios).
 *
 * @const {number}
 * @private
 */
shaka.text.TtmlTextParser.WINDOW_MIN_LEAVES_ = 200;

shaka.text.TextEngine.registerParser(
    'application/ttml+xml', () => new shaka.text.TtmlTextParser());
