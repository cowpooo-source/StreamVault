/**
 * Browser media engine stubs for Playwright E2E tests.
 *
 * These stubs replace window.Hls and window.mpegts so tests can verify
 * engine selection and state transitions without real codecs or network.
 *
 * Usage:
 *   await stubHls(page);
 *   await stubMpegts(page);
 *   await stubNativeMedia(page);
 *   await page.goto("/app");
 *
 * Then read window.__e2eMedia to inspect calls.
 */

const E2E_MEDIA_INIT = `
  window.__e2eMedia = window.__e2eMedia || {
    nativePlayCalls: [],
    hlsLoadCalls: [],
    hlsStartLoadCalls: [],
    hlsInstances: [],
    hlsEvents: {},
    mpegtsLoadCalls: [],
    mpegtsAttachCalls: [],
    mpegtsDestroyCalls: [],
    mpegtsInstances: [],
    mpegtsEvents: {},
  };
`;

/**
 * Stub HTMLMediaElement.prototype.play to record calls and resolve immediately.
 */
export async function stubNativeMedia(page) {
  await page.addInitScript(`
    ${E2E_MEDIA_INIT}
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      window.__e2eMedia.nativePlayCalls.push(this.currentSrc || this.src || "");
      return Promise.resolve();
    };
  `);
}

/**
 * Stub window.Hls with a minimal mock that records loadSource/attachMedia
 * and supports triggering fatal errors.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{autoManifest?: boolean}} options
 */
export async function stubHls(page, { autoManifest = true } = {}) {
  await page.addInitScript(`
    ${E2E_MEDIA_INIT}

    class MockHls {
      static isSupported() { return true; }
      static Events = {
        MANIFEST_PARSED: "hlsManifestParsed",
        FRAG_LOADED: "hlsFragLoaded",
        ERROR: "hlsError",
        AUDIO_TRACKS_UPDATED: "hlsAudioTracksUpdated",
        SUBTITLE_TRACKS_UPDATED: "hlsSubtitleTracksUpdated",
        AUDIO_TRACK_SWITCHED: "hlsAudioTrackSwitched",
        SUBTITLE_TRACK_SWITCHED: "hlsSubtitleTrackSwitched",
      };
      static ErrorTypes = {
        NETWORK_ERROR: "networkError",
        MEDIA_ERROR: "mediaError",
      };

      constructor(opts) {
        this._opts = opts;
        this._listeners = {};
        this._source = null;
        this._media = null;
        this.audioTracks = [];
        this.audioTrack = -1;
        this.subtitleTracks = [];
        this.subtitleTrack = -1;
        window.__e2eMedia.hlsInstances.push(this);
      }

      on(event, handler) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(handler);
      }

      off(event, handler) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(h => h !== handler);
      }

      emit(event, data) {
        (this._listeners[event] || []).forEach(h => h(event, data));
      }

      loadSource(url) {
        this._source = url;
        window.__e2eMedia.hlsLoadCalls.push(url);
      }

      attachMedia(video) {
        this._media = video;
        if (${JSON.stringify(autoManifest)}) {
          // Auto-trigger manifest parsed after a tick.
          setTimeout(() => {
            this.emit(MockHls.Events.MANIFEST_PARSED, {});
          }, 10);
        }
      }

      startLoad(pos) {
        window.__e2eMedia.hlsStartLoadCalls.push(pos);
      }

      recoverMediaError() {}

      destroy() {
        this._listeners = {};
      }

      _triggerFatalError(type, details, code) {
        this.emit(MockHls.Events.ERROR, {
          fatal: true,
          type: type || MockHls.ErrorTypes.NETWORK_ERROR,
          details: details || "manifestLoadError",
          response: code ? { code } : undefined,
        });
      }
    }

    window.Hls = MockHls;
    window.__e2eHls = MockHls;
  `);
}

/**
 * Stub window.mpegts with a minimal mock.
 */
export async function stubMpegts(page) {
  await page.addInitScript(`
    ${E2E_MEDIA_INIT}

    class MockMpegtsPlayer {
      static isSupported() { return true; }
      static Events = { ERROR: "error" };
      static createPlayer(mediaData) { return new MockMpegtsPlayer(mediaData); }

      constructor(mediaData = {}) {
        this._listeners = {};
        this._media = null;
        this._url = mediaData.url || null;
        window.__e2eMedia.mpegtsInstances.push(this);
      }

      on(event, handler) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(handler);
      }

      off(event, handler) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(h => h !== handler);
      }

      emit(event, ...args) {
        (this._listeners[event] || []).forEach(h => h(...args));
      }

      attachMediaElement(video) {
        this._media = video;
        window.__e2eMedia.mpegtsAttachCalls.push(video.currentSrc || "");
      }

      load() {
        window.__e2eMedia.mpegtsLoadCalls.push(this._url || "");
      }

      play() {
        return Promise.resolve();
      }

      unload() {}

      destroy() {
        window.__e2eMedia.mpegtsDestroyCalls.push(this._url || "");
        this._listeners = {};
      }

      _triggerError(code = 500) {
        this.emit(MockMpegtsPlayer.Events.ERROR, "NetworkError", "network error", {
          code,
          msg: "mock network error",
        });
      }

      _triggerEnded() {
        this.emit("ended", {});
      }
    }

    window.mpegts = MockMpegtsPlayer;
    window.__e2eMpegts = MockMpegtsPlayer;
  `);
}

/**
 * Trigger a media event on the native <video> element.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} eventName - e.g. "loadedmetadata", "canplay", "playing", "waiting", "stalled", "error", "ended"
 */
export async function triggerVideoEvent(page, eventName) {
  await page.evaluate((name) => {
    const video = document.querySelector("video");
    if (video) video.dispatchEvent(new Event(name));
  }, eventName);
}

/**
 * Get the E2E media call log from the browser.
 */
export async function getMediaLog(page) {
  return page.evaluate(() => window.__e2eMedia || {});
}
