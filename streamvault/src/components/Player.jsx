import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import { imgSrc, pingUrls, streamProxy, VAST_URL, API, ENABLE_VAST, trackAnalytics } from "../utils.js";
import { fetchVastAd } from "../vast.js";
import { getEPGNow } from "../epg.js";
import { classifyStreamUrl } from "../stream-classifier.js";
import { shouldProxyStreamUrl, xtreamHlsCandidate } from "../stream-routing.js";

function Player({ item, channelList, epgData, onClose, onFav, isFav, onPlayCatchup, onProgress, onRefreshStream, onRequestRelay, t: pt, isAdEligible, connType }) {
  const t = pt || ((k) => k);
  const videoRef   = useRef(null);
  const hlsRef     = useRef(null);
  const mpegtsRef  = useRef(null);
  const adPlayedRef = useRef(false);
  const adSessionRef = useRef(0);
  const adFinishRef = useRef(null);
  const playbackPhaseRef = useRef("idle");
  const resumeRetryRef = useRef(false);
  const osdTimer   = useRef(null);
  const resumeAppliedRef = useRef(null);
  const reportedDirectGenerationRef = useRef(null);
  const preferredAudioRef = useRef(null);
  const preferredSubtitleRef = useRef(null);
  const [osd, setOsd]         = useState(true);
  const [showQCH, setShowQCH] = useState(false);
  const qchTimer = useRef(null);
  
  // ── Reactive Time State for OSD ──
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!osd) return;
    setNowMs(Date.now()); // Update immediately when OSD opens
    const interval = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(interval);
  }, [osd]);

  const [chIdx, setChIdx]     = useState(() => {
    if (!channelList) return -1;
    return channelList.findIndex(c => c.id === item.id || c.url === item.url);
  });
  const [current, setCurrent] = useState(item);
  const [adState, setAdState] = useState(null);
  const [audioTracks, setAudioTracks] = useState([]);
  const [activeAudio, setActiveAudio] = useState(-1);
  const [subTracks, setSubTracks] = useState([]);
  const [activeSub, setActiveSub] = useState(-1);
  const [showTracksMenu, setShowTracksMenu] = useState(false);
  const [showCatchupMenu, setShowCatchupMenu] = useState(false);

  const contentIdentity = `${current.type || "unknown"}:${current.id || current.url || current.epgId || ""}`;

  function reportStalkerAudit(event) {
    if (!current?._stalkerCmd || !current?._stalkerRefreshUrl) return;
    try {
      const parsed = new URL(current._stalkerRefreshUrl, location.origin);
      const contentToken = parsed.searchParams.get("contentToken");
      if (!contentToken) return;
      fetch(`${API}/stalker/audit-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, contentToken }),
      }).catch(() => {});
    } catch { /* Best-effort telemetry or browser capability probe. */ }
  }

  useEffect(() => {
    resumeAppliedRef.current = null;
    resumeRetryRef.current = false;
    preferredAudioRef.current = null;
    preferredSubtitleRef.current = null;
  }, [contentIdentity]);

  const audioTrackLabel = (track, index) =>
    track?.name || track?.lang || track?.language || `Audio ${index + 1}`;
  const subtitleTrackLabel = (track, index) =>
    track?.name || track?.lang || track?.language || `Subtitle ${index + 1}`;

  function selectAudioTrack(id) {
    if (hlsRef.current) {
      hlsRef.current.audioTrack = id;
      setActiveAudio(id);
      preferredAudioRef.current = hlsRef.current.audioTracks?.[id] || { id };
    }
  }

  function selectSubtitleTrack(id) {
    if (hlsRef.current) {
      hlsRef.current.subtitleTrack = id;
      setActiveSub(id);
      preferredSubtitleRef.current = id < 0 ? { id: -1 } : hlsRef.current.subtitleTracks?.[id] || { id };
    }
  }

  function resetTrackState() {
    setAudioTracks([]);
    setActiveAudio(-1);
    setSubTracks([]);
    setActiveSub(-1);
    setShowTracksMenu(false);
  }

  function clampResumePosition(video, resumePosition) {
    let target = Math.max(0, Number(resumePosition) || 0);
    const duration = Number.isFinite(video?.duration) ? Number(video.duration) : 0;
    if (duration > 0) {
      target = Math.min(target, Math.max(0, duration - 1));
    }
    const seekable = video?.seekable;
    if (seekable && seekable.length > 0) {
      try {
        const start = seekable.start(0);
        const end = seekable.end(seekable.length - 1);
        if (Number.isFinite(start)) target = Math.max(target, start);
        if (Number.isFinite(end)) target = Math.min(target, Math.max(start, end - 0.25));
      } catch { /* Best-effort telemetry or browser capability probe. */ }
    }
    return Math.max(0, target);
  }

  const showOSD = useCallback(() => {
    setOsd(true);
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), 3500);
  }, []);

  function destroyPlayers() {
    clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = null;
    if (hlsRef.current)    { hlsRef.current.destroy();  hlsRef.current = null; }
    if (mpegtsRef.current) { mpegtsRef.current.destroy(); mpegtsRef.current = null; }
    resetTrackState();
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  async function playVastPreroll(video, ad, isCancelled) {
    return new Promise((resolve) => {
      if (!video || !ad?.mediaUrl || isCancelled()) {
        resolve(false);
        return;
      }

      let done = false;
      let skipTimer = null;
      let startTimeout = null;
      let maxDurationTimeout = null;
      let impressionSent = false;
      const wasMuted = video.muted;
      const wasControls = video.controls;
      playbackPhaseRef.current = "ad";

      const cleanup = () => {
        video.removeEventListener("ended", onEnded);
        video.removeEventListener("error", onError);
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("click", onClick);
        if (skipTimer) clearInterval(skipTimer);
        if (startTimeout) clearTimeout(startTimeout);
        if (maxDurationTimeout) clearTimeout(maxDurationTimeout);
        video.muted = wasMuted;
        video.controls = wasControls;
        adFinishRef.current = null;
      };

      const finish = (result, eventName = null) => {
        if (done) return;
        done = true;
        if (eventName) pingUrls(ad.trackers?.[eventName]);
        cleanup();
        setAdState(null);
        resolve(result);
      };

      // Ensure ad doesn't hang player forever if blocked/stalled
      startTimeout = setTimeout(() => {
        if (!impressionSent) finish(false);
      }, 10000);
      maxDurationTimeout = setTimeout(() => {
        finish(false, "error");
      }, Math.min(Math.max((ad.duration || 0) * 1000 + 5000, 15000), 45000));

      const updateOverlay = () => {
        if (isCancelled()) {
          finish(false);
          return;
        }
        const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const skipEnabled = ad.skipOffset !== null;
        const canSkip = !skipEnabled || ad.skipOffset <= 0 || currentTime >= ad.skipOffset;
        const remaining = skipEnabled && !canSkip ? Math.max(0, Math.ceil(ad.skipOffset - currentTime)) : 0;
        setAdState({
          active: true,
          title: ad.title,
          clickThrough: ad.clickThrough,
          skipEnabled,
          canSkip,
          skipRemaining: remaining,
          mediaType: ad.mediaType,
        });
      };

      const onEnded = () => finish(true, "complete");
      const onError = () => finish(false);
      const onPlaying = () => {
        if (impressionSent) return;
        impressionSent = true;
        pingUrls(ad.trackers?.impression);
      };
      const onClick = () => {
        if (!ad.clickThrough) return;
        window.open(ad.clickThrough, "_blank", "noopener,noreferrer");
      };
      const onTimeUpdate = () => updateOverlay();

      adFinishRef.current = (eventName = "complete") => finish(true, eventName);

      video.pause();
      video.removeAttribute("src");
      video.src = location.protocol === "https:" && ad.mediaUrl.startsWith("http://")
        ? streamProxy(ad.mediaUrl)
        : ad.mediaUrl;
      video.controls = true;
      video.playsInline = true;
      video.muted = true;
      video.load();

      video.addEventListener("ended", onEnded);
      video.addEventListener("error", onError);
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("playing", onPlaying, { once: true });
      video.addEventListener("click", onClick);

      if (ad.skipOffset !== null && ad.skipOffset > 0) {
        skipTimer = setInterval(updateOverlay, 250);
      }

      updateOverlay();
      const playPromise = video.play();
      if (playPromise?.catch) {
        playPromise.catch(() => finish(false));
      }
    });
  }

  const [streamErr, setStreamErr] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const loadingTimerRef = useRef(null);

  function showStreamError(error) {
    setIsLoading(false);
    setStreamErr(error);
  }
  const [relayLoading, setRelayLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [streamRevision, setStreamRevision] = useState(0);
  const autoRecoveryRef = useRef({ key: null, hls: 0, ts: 0 });
  const playbackGenerationRef = useRef(0);
  const stallRecoveryRef = useRef(null);
  const recoveryPositionRef = useRef(null);

  useEffect(() => {
    playbackGenerationRef.current += 1;
  }, [contentIdentity, retryKey, streamRevision]);

  useEffect(() => {
    resumeAppliedRef.current = null;
    resumeRetryRef.current = false;
  }, [retryKey, streamRevision]);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState({});
  const statsInterval = useRef(null);

  useEffect(() => {
    if (!showStats) { clearInterval(statsInterval.current); return; }
    function collect() {
      const v = videoRef.current;
      if (!v) return;
      const s = {};
      s.resolution = v.videoWidth && v.videoHeight ? `${v.videoWidth}×${v.videoHeight}` : "—";
      s.currentTime = v.currentTime?.toFixed(1) || "0";
      s.duration = v.duration && isFinite(v.duration) ? v.duration.toFixed(1) : "Live";
      s.readyState = ["NOTHING","METADATA","CURRENT","FUTURE","ENOUGH"][v.readyState] || v.readyState;
      s.networkState = ["EMPTY","IDLE","LOADING","NO_SRC"][v.networkState] || v.networkState;
      s.paused = v.paused ? "Yes" : "No";
      s.volume = `${Math.round(v.volume * 100)}%${v.muted ? " (muted)" : ""}`;
      // Buffer info
      if (v.buffered.length > 0) {
        const end = v.buffered.end(v.buffered.length - 1);
        s.buffer = `${(end - v.currentTime).toFixed(1)}s ahead`;
      } else { s.buffer = "0s"; }
      // Dropped frames (Chrome/Edge)
      const q = v.getVideoPlaybackQuality?.();
      if (q) {
        s.droppedFrames = `${q.droppedVideoFrames}/${q.totalVideoFrames}`;
        s.fps = q.totalVideoFrames > 0 && v.currentTime > 1
          ? (q.totalVideoFrames / v.currentTime).toFixed(1) : "—";
      }
      // HLS.js stats
      const hls = hlsRef.current;
      if (hls?.levels?.[hls.currentLevel]) {
        const lvl = hls.levels[hls.currentLevel];
        s.bitrate = lvl.bitrate ? `${(lvl.bitrate / 1000).toFixed(0)} kbps` : "—";
        s.codec = [lvl.videoCodec, lvl.audioCodec].filter(Boolean).join(", ") || "—";
        s.hlsLevel = `${hls.currentLevel + 1}/${hls.levels.length}`;
      }
      s.url = current.url?.slice(0, 80) + (current.url?.length > 80 ? "…" : "");
      setStats(s);
    }
    collect();
    statsInterval.current = setInterval(collect, 1000);
    return () => clearInterval(statsInterval.current);
  }, [showStats, current.url]);

  // Xtream and M3U streams play directly from the browser (no proxy, no byte relay).
  // Generic non-Stalker playback may use the proxy for CORS; Stalker never relays automatically.
  const origin = API || location.origin;
  const pageProtocol = location.protocol;
  const needsProxy = (u, kind = "unknown") => {
    if (current?._stalkerCmd || ["xtream", "m3u", "hls"].includes(connType)) return false;
    return shouldProxyStreamUrl(u, {
      origin,
      pageProtocol,
      direct: !!current?._direct,
      kind,
    });
  };
  function initPlayer(url) {
    const video = videoRef.current;
    if (!video || !url) return;
    setStreamErr(null);
    setIsLoading(true);
    clearTimeout(loadingTimerRef.current);
    if (autoRecoveryRef.current.key !== `${current.id || current.url || ""}:${retryKey}`) {
      autoRecoveryRef.current = { key: `${current.id || current.url || ""}:${retryKey}`, hls: 0, ts: 0, stall: 0, recoveryInFlight: false, stalkerRefreshInFlight: false, stalkerRefreshTimes: [] };
    }
    destroyPlayers();
    video.removeAttribute("src");

    const loadStartTime = Date.now();
    const initialStreamKind = current.streamKind || classifyStreamUrl(url, current.type);
    const isNativeStalkerInitialLoad = current._stalkerCmd
      && (initialStreamKind === "file" || initialStreamKind === "unknown");
    const loadGeneration = playbackGenerationRef.current;
    const isCurrentLoad = () => loadGeneration === playbackGenerationRef.current
      && video === videoRef.current;
    const failInitialLoad = () => {
      if (!isCurrentLoad() || video.readyState >= 3) return;
      showStreamError({ icon: "!", title: "Playback Timeout", body: "The stream did not provide playable media. Try again or choose another stream." });
      destroyPlayers();
    };
    loadingTimerRef.current = window.setTimeout(async () => {
      if (!isCurrentLoad() || video.readyState >= 3) return;

      if (!isNativeStalkerInitialLoad) {
        failInitialLoad();
        return;
      }

      if (video.readyState === 0) {
        if (current.type !== "live" && Number.isFinite(video.currentTime) && video.currentTime > 0.1) {
          recoveryPositionRef.current = video.currentTime;
        }
        // Abort Chrome's internal retries before resolving one fresh direct URL.
        destroyPlayers();
        const refreshed = await requestStalkerRefresh("initial_load_timeout");
        if (!isCurrentLoad() || refreshed) return;
        failInitialLoad();
        return;
      }

      // Metadata or media data arrived, so allow the normal 20-second budget.
      loadingTimerRef.current = window.setTimeout(failInitialLoad, 12_000);
    }, isNativeStalkerInitialLoad ? 8_000 : 20_000);


    const xtreamHlsUrl = connType === "xtream" && current.type === "live" && !current._xtreamHlsFailed
      ? xtreamHlsCandidate(url)
      : null;

    function tryXtreamTsFallback(reason) {
      if (!xtreamHlsUrl || current._xtreamHlsFailed) return false;
      trackAnalytics("xtream_hls_ts_fallback", {
        content_id: String(current.id || ""),
        reason,
      });
      destroyPlayers();
      setStreamErr(null);
      setIsLoading(true);
      setCurrent(prev => ({ ...prev, _xtreamHlsFailed: true, streamKind: "ts" }));
      setStreamRevision(value => value + 1);
      return true;
    }

    async function requestStalkerRefresh(reason) {
      const recovery = autoRecoveryRef.current;
      if (!current._direct || recovery.stalkerRefreshInFlight || typeof onRefreshStream !== "function") return false;
      const now = Date.now();
      const recentRefreshes = (recovery.stalkerRefreshTimes || []).filter(time => time > now - 60_000);
      if (recentRefreshes.length >= 3) return false;
      recentRefreshes.push(now);
      recovery.stalkerRefreshTimes = recentRefreshes;
      recovery.stalkerRefreshInFlight = true;
      const generation = playbackGenerationRef.current;
      try {
        if (current.type !== "live" && Number.isFinite(video.currentTime) && video.currentTime > 0.1) {
          recoveryPositionRef.current = video.currentTime;
        }
        const refreshed = await onRefreshStream(current, reason);
        if (!refreshed?.url || generation !== playbackGenerationRef.current) return false;
        destroyPlayers();
        setStreamErr(null);
        setIsLoading(true);
        setCurrent(prev => ({ ...prev, ...refreshed }));
        // A provider may issue the same URL again; force media-engine reinitialization.
        setStreamRevision(value => value + 1);
        return true;
      } catch (error) {
        console.warn("Stalker stream refresh failed:", error?.message || error);
        return false;
      } finally {
        recovery.stalkerRefreshInFlight = false;
      }
    }

    stallRecoveryRef.current = async (reason = "playback_stalled") => {
      const recovery = autoRecoveryRef.current;
      if (recovery.recoveryInFlight || video.ended || video.paused || playbackPhaseRef.current !== "content") return false;
      if ((recovery.stall || 0) >= 3) {
        showStreamError({ icon: "!", title: "Playback Stalled", body: "The stream stopped responding after several reconnect attempts. Try again or choose another stream." });
        return false;
      }
      recovery.recoveryInFlight = true;
      recovery.stall = (recovery.stall || 0) + 1;
      trackAnalytics("playback_stall_recovery", { content_id: String(current.id || ""), content_type: current.type || "live", attempt: recovery.stall, reason });
      try {
        if (recovery.stall === 1 && hlsRef.current) { hlsRef.current.startLoad(-1); video.play().catch(() => {}); return true; }
        if (recovery.stall === 1 && mpegtsRef.current) { mpegtsRef.current.unload(); mpegtsRef.current.load(); mpegtsRef.current.play().catch(() => {}); return true; }
        // Native video has no engine-level reload API. Refresh a direct Stalker URL
        // first; otherwise rebuild the native element while retaining VOD position.
        if (!hlsRef.current && !mpegtsRef.current) {
          const savedPosition = Number.isFinite(video.currentTime) ? video.currentTime : 0;
          if (current._direct && await requestStalkerRefresh(reason)) return true;
          if (current.type !== "live" && savedPosition > 0.1) {
            recoveryPositionRef.current = savedPosition;
          }
          setStreamRevision(value => value + 1);
          return true;
        }
        if (current._direct && await requestStalkerRefresh(reason)) return true;

        if (hlsRef.current) { hlsRef.current.startLoad(-1); video.play().catch(() => {}); return true; }
        if (mpegtsRef.current) { mpegtsRef.current.unload(); mpegtsRef.current.load(); mpegtsRef.current.play().catch(() => {}); return true; }
        if (current.type !== "live" && Number.isFinite(video.currentTime) && video.currentTime > 0.1) {
          recoveryPositionRef.current = video.currentTime;
        }
        setStreamRevision(value => value + 1);
        return true;
      } catch (error) {
        console.warn("Playback stall recovery failed:", error?.message || error);
        return false;
      } finally {
        window.setTimeout(() => { if (autoRecoveryRef.current === recovery) recovery.recoveryInFlight = false; }, 3000);
      }
    };
    // Native <video> error handler (for direct src= playback)
    video.onerror = async () => {
      // Skip if HLS.js or mpegts.js is handling (they have their own error handlers)
      if (hlsRef.current || mpegtsRef.current) return;
      // Save position before refresh attempt for VOD/series recovery
      if (current.type !== "live" && Number.isFinite(video.currentTime) && video.currentTime > 0.1) {
        recoveryPositionRef.current = video.currentTime;
      }
      // For Stalker direct streams, try refresh
      if (current._direct && await requestStalkerRefresh("native_error")) return;

      const e = video.error;
      const msgs = { 1: "Playback aborted", 2: "Network error - could not load stream", 3: "Decode error - stream format not supported", 4: "Source not supported - the stream format or URL is invalid" };
      const errorPayload = current._stalkerCmd
        ? { icon: "!", title: "Direct Playback Incompatible", body: "The provider blocked browser-direct playback after bounded retries. VPS media relay remains disabled." }
        : { icon: "!", title: "Playback Error", body: msgs[e?.code] || "Unknown video error" };
      showStreamError(errorPayload);
      if (current._stalkerCmd) reportStalkerAudit("direct_incompatible");
      trackAnalytics("playback_error", {
        error_type: "native_video_error",
        error_code: String(e?.code || "unknown"),
        content_id: String(current.id || ""),
        content_type: current.type || "live",
        provider_type: current.type || "unknown",
        latency_ms: Date.now() - loadStartTime,
      });
    };

    function startHls(u) {
      if (window.Hls?.isSupported()) {
        const opts = {
          enableWorker: false,
          fragLoadingMaxRetry: 2,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          maxBufferLength: 30,
          backBufferLength: 30,
        };
        // On HTTPS pages, proxy HTTP streams through proxy
        // The proxy rewrites HLS manifests so segments also go through proxy (same IP)
        if (needsProxy(u, "hls")) {
          u = streamProxy(u);
        }
        // Bust stale live playlists while preserving provider segment URLs.
        if (current.type === "live" && current._direct) {
          try {
            const playlistUrl = new URL(u, location.href);
            playlistUrl.searchParams.set("_sv_live", String(Date.now()));
            u = playlistUrl.toString();
          } catch { /* Keep non-standard provider URLs unchanged. */ }
        }
        const hls = new window.Hls(opts);
        hlsRef.current = hls;
        hls.loadSource(u);
        hls.attachMedia(video);
        const syncHlsTracks = () => {
          setAudioTracks(hls.audioTracks || []);
          setActiveAudio(hls.audioTrack);
          setSubTracks(hls.subtitleTracks || []);
          setActiveSub(hls.subtitleTrack);
          const preferredAudio = preferredAudioRef.current;
          if (preferredAudio) {
            const index = (hls.audioTracks || []).findIndex(track => track.id === preferredAudio.id || (track.lang && track.lang === preferredAudio.lang) || (track.name && track.name === preferredAudio.name));
            if (index >= 0) hls.audioTrack = index;
          }
          const preferredSubtitle = preferredSubtitleRef.current;
          if (preferredSubtitle?.id === -1) hls.subtitleTrack = -1;
          else if (preferredSubtitle) {
            const index = (hls.subtitleTracks || []).findIndex(track => track.id === preferredSubtitle.id || (track.lang && track.lang === preferredSubtitle.lang) || (track.name && track.name === preferredSubtitle.name));
            if (index >= 0) hls.subtitleTrack = index;
          }
        };
        let manifestParsed = false;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          manifestParsed = true;
          video.play().catch(()=>{});
          syncHlsTracks();
        });
        if (window.Hls.Events.FRAG_LOADED) {
          hls.on(window.Hls.Events.FRAG_LOADED, () => {
            if (hlsRef.current === hls) autoRecoveryRef.current.hls = 0;
          });
        }

        hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, syncHlsTracks);
        hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, syncHlsTracks);
        // Listen for track changes triggered by the stream itself
        hls.on(window.Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
          setActiveAudio(data.id);
        });
        hls.on(window.Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
          setActiveSub(data.id);
        });
        hls.on(window.Hls.Events.ERROR, async (_, data) => {
          if (!data.fatal) return;
          const recovery = autoRecoveryRef.current;
          const code = data.response?.code;

          // Many Xtream providers expose HLS beside the advertised TS URL. If that
          // capability probe fails, fall back once to direct TS without using the VPS.
          if (!manifestParsed && tryXtreamTsFallback("hls_" + (data.details || data.type || "manifest_error"))) return;

          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && recovery.hls < 2) {
            recovery.hls += 1;
            const delay = 500 * (2 ** (recovery.hls - 1));
            window.setTimeout(() => {
              if (hlsRef.current !== hls) return;
              hls.startLoad(-1);
            }, delay);
            return;
          }
          if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && recovery.hls < 2) {
            recovery.hls += 1;
            hls.recoverMediaError();
            return;
          }
          if (current._direct && await requestStalkerRefresh(`hls_${data.type || data.details || "error"}`)) return;

          let title = "Playback Error";
          let body;
          if (code === 404) {
            title = "Stream Not Found (404)";
            body = "The stream URL returned 404. The channel may be offline, or its URL may have changed. Try reconnecting to refresh the channel list.";
          } else if (code === 401 || code === 403) {
            title = `Access Denied (${code})`;
            body = "The stream server rejected the request. Your IP may be blocked or your credentials lack access.";
          } else if (code === 429) {
            title = "Rate Limited (429)";
            body = "Too many requests to the provider. Please wait a minute before trying again.";
          } else if (code === 456) {
            title = "Account Blocked (456)";
            body = "The provider rejected the stream (HTTP 456). Your account may be expired, in use elsewhere, or your IP is blocked by the provider's firewall.";
          } else if (code === 459 || code === 462) {
            title = `Token Expired (${code})`;
            body = "The stream token has expired or was rejected. Click play again to get a fresh token.";
          } else if (code >= 400 && code < 500) {
            title = `Client Error (${code})`;
            body = `The stream request was rejected with HTTP ${code}.`;
          } else if (code >= 500) {
            title = `Server Error (${code})`;
            body = "The stream server returned an error. It may be overloaded or temporarily down.";
          } else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            title = "Network Error";
            body = "Could not reach the stream server. Check your connection or try again.";
          } else {
            body = `HLS error: ${data.details}${code ? ` (HTTP ${code})` : ""}`;
          }
          if (current._stalkerCmd) {
            title = "Direct Playback Incompatible";
            body = "The provider or browser rejected direct playback after bounded retries. VPS media relay remains disabled.";
            reportStalkerAudit("direct_incompatible");
          }
          showStreamError({ icon: "!", title, body });
          trackAnalytics("playback_error", {
            error_type: `hls_${data.type}`,
            error_code: String(code || data.details || "unknown"),
            content_id: String(current.id || ""),
            provider_type: current.type || "live"
          });
          destroyPlayers();
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = needsProxy(u, "hls") ? streamProxy(u) : u; video.play().catch(()=>{});
      }
    }

    function startMpegts(u) {
      // Proxy HTTP streams through Cloudflare Worker when on HTTPS
      if (needsProxy(u, "ts")) u = streamProxy(u);
      if (!window.mpegts?.isSupported()) {
        video.src = u; video.play().catch(()=>{}); return;
      }
      const player = window.mpegts.createPlayer({ type: "mpegts", isLive: true, url: u }, {
        enableWorker: false,
        lazyLoad: false,
        seekType: "range",
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 60,
        autoCleanupMinBackwardDuration: 30,
      });
      mpegtsRef.current = player;
      player.on(window.mpegts.Events.ERROR, async (errType, errDetail, errInfo) => {
        const recovery = autoRecoveryRef.current;
        if (recovery.ts < 2 && (errType === "NetworkError" || errDetail?.toLowerCase?.().includes("network"))) {
          recovery.ts += 1;
          const delay = 500 * (2 ** (recovery.ts - 1));
          window.setTimeout(() => {
            if (mpegtsRef.current !== player) return;
            try { player.unload(); player.load(); player.play().catch(() => {}); } catch { /* Recovery is best effort. */ }
          }, delay);
          return;
        }
        if (current._direct && await requestStalkerRefresh(`mpegts_${errType || errDetail || "error"}`)) return;
        const code = errInfo?.code;
        let title = "Playback Error";
        let body;
        if (code === 404) {
          title = "Stream Not Found (404)";
          body = "The stream URL returned 404. The channel may be offline or the URL has changed.";
        } else if (code === 401 || code === 403) {
          title = `Access Denied (${code})`;
          body = "The stream server rejected the request. Your IP may be blocked or your credentials lack access.";
        } else if (code === 429) {
          title = "Rate Limited (429)";
          body = "Too many requests to the provider. Please wait a minute before trying again.";
        } else if (code === 456) {
          title = "Account Blocked (456)";
          body = "The provider rejected the stream (HTTP 456). Your account may be expired, in use elsewhere, or your IP is blocked by the provider's firewall.";
        } else if (code === 459 || code === 462) {
          title = `Token Expired (${code})`;
          body = "The stream token has expired or was rejected. Click play again to get a fresh token.";
        } else if (code >= 400 && code < 500) {
          title = `Client Error (${code})`;
          body = `The stream request was rejected with HTTP ${code}.`;
        } else if (code >= 500) {
          title = `Server Error (${code})`;
          body = "The stream server returned an error. It may be overloaded or temporarily down.";
        } else if (errType === "NetworkError") {
          title = "Network Error";
          body = `Could not load the stream. ${errInfo?.msg || "Check your connection or try again."}`;
        } else if (errDetail?.includes("Unsupported media type")) {
          // Fallback to native video if mpegts.js can't handle it
          console.warn("mpegts.js: Unsupported media type, falling back to native <video>");
          destroyPlayers();
          video.src = u;
          video.play().catch(()=>{});
          return;
        } else {
          body = `${errType}: ${errDetail || "Unknown error"}${code ? ` (HTTP ${code})` : ""}`;
        }
        if (current._stalkerCmd) {
          title = "Direct Playback Incompatible";
          body = "The provider or browser rejected direct playback after bounded retries. VPS media relay remains disabled.";
          reportStalkerAudit("direct_incompatible");
        }
        showStreamError({ icon: "!", title, body });
        destroyPlayers();
      });
      player.attachMediaElement(video);
      player.load();
      player.play().catch(()=>{});
    }

    const SRI_HASHES = {
      "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js": "sha384-miJUhTuRucSoqFe3/VSB2sRghSMoev6wpPoEyj5fhF0PARehD+naPBsAkl5NqwPO",
      "https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js": "sha384-Z2H/TjKWDNZA/2luGOnjLx9pcva7cK4VSWC+hZn78Kr5uG8YbMpxdz+wWXBMO6N/",
    };
    function loadScript(src, cb) {
      if (document.querySelector(`script[src="${src}"]`)) { cb(); return; }
      const s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      if (SRI_HASHES[src]) s.integrity = SRI_HASHES[src];
      s.onload = cb;
      document.head.appendChild(s);
    }

    // Direct video files (MP4, MKV, AVI, etc.) — play natively, not via mpegts/HLS
    const streamKind = xtreamHlsUrl ? "hls" : (current.streamKind || classifyStreamUrl(url, current.type));
    if (streamKind === "file") {
      video.src = needsProxy(url, "file") ? streamProxy(url) : url; video.play().catch(()=>{});
      return;
    }

    // Stalker VOD/series items are direct video files served by the portal.
    const isStalkerVod = (current.type === "vod" || current.type === "series")
      && (url.includes("/play/movie.php") || url.includes("/play/live.php") || url.includes("play_token="));
    if (isStalkerVod) {
      const vodStreamKind = classifyStreamUrl(url, "vod");
      if (url.includes(".m3u8") || vodStreamKind === "hls") {
        if (window.Hls) startHls(url);
        else loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js",
                          () => startHls(url));
      } else {
        video.src = needsProxy(url, "file") ? streamProxy(url) : url; video.play().catch(()=>{});
      }
      return;
    }

    const playbackUrl = xtreamHlsUrl || url;
    const needTs = streamKind === "ts";
    const needHls = streamKind === "hls";

    // For Xtream live streams on HTTPS, proxy raw TS through stream proxy
    // (HLS .m3u8 has IP-bound segment tokens that break with proxied manifests)
    if (needTs && needsProxy(url, "ts")) {
      const proxied = streamProxy(url);
      if (window.mpegts) startMpegts(proxied);
      else loadScript("https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js",
                        () => startMpegts(proxied));
      return;
    }

    if (needTs) {
      if (window.mpegts) startMpegts(url);
      else loadScript("https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js",
                        () => startMpegts(url));
    } else if (needHls) {
      if (window.Hls) startHls(playbackUrl);
      else loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js",
                        () => startHls(playbackUrl));
    } else {
      video.src = needsProxy(url, "file") ? streamProxy(url) : url; video.play().catch(()=>{});
    }
  }

  useEffect(() => {
    let cancelled = false;
    const sessionId = ++adSessionRef.current;
    const video = videoRef.current;
    if (!video || !current.url) return;

    // Playback Telemetry Heartbeat
    const playbackSessionId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let heartbeatTimer = null;
    let debounceTimer = null;
    let isTracking = false;
    let lastHeartbeatTime = 0;
    let lastProgressTime = 0;

    const reportProgress = (completed = false, reason = 'interval') => {
      if (!onProgress || current.type === "live" || playbackPhaseRef.current !== "content") return;
      const position = Math.floor(video.currentTime || 0);
      const duration = Math.floor(video.duration || 0);
      onProgress(current, { position, duration, completed, reason });
    };

    const handleLoadedMetadata = () => {
      if (playbackPhaseRef.current !== "content" || current.type === "live") return false;
      if (Number.isFinite(recoveryPositionRef.current) && recoveryPositionRef.current > 0) {
        const target = clampResumePosition(video, recoveryPositionRef.current);
        recoveryPositionRef.current = null;
        try { video.currentTime = target; return true; } catch { recoveryPositionRef.current = target; }
      }
      const resumeKey = contentIdentity;
      const resumePosition = Number(current.position || 0);
      if (resumePosition <= 5) return false;
      if (resumeAppliedRef.current === resumeKey) return true;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (duration > 0 && resumePosition >= duration - 30) {
        resumeAppliedRef.current = resumeKey;
        return true;
      }
      const target = clampResumePosition(video, resumePosition);
      try {
        video.currentTime = target;
        resumeAppliedRef.current = resumeKey;
        resumeRetryRef.current = false;
        return true;
      } catch {
        resumeRetryRef.current = true;
        return false;
      }
    };

    let lastMediaTime = video.currentTime || 0;
    let lastMediaProgressAt = Date.now();
    const handleTimeUpdate = () => {
      lastMediaTime = video.currentTime;
      lastMediaProgressAt = Date.now();
      autoRecoveryRef.current.hls = 0;
      autoRecoveryRef.current.ts = 0;
      autoRecoveryRef.current.stall = 0;
      if (Date.now() - lastProgressTime < 5000) return;
      lastProgressTime = Date.now();
      reportProgress(false, 'interval');
    };

    const sendHeartbeat = (completed = false, useBeacon = false) => {
      if (!isTracking && !useBeacon && !completed) return;
      if (!video) return;
      
      lastHeartbeatTime = Date.now();
      const payload = {
        session_id: playbackSessionId,
        guest_id: localStorage.getItem("sv-guest-id"),
        connection_id: current.connId || null,
        item_id: current.id || current.epgId || null,
        item_type: current.type || "live",
        item_name: current.name || current.title || "Unknown",
        group_name: current.group || null,
        position: Math.floor(video.currentTime || 0),
        media_duration: Math.floor(video.duration || 0),
        completed: completed
      };
      
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(`${API}/api/playback/heartbeat`, JSON.stringify(payload));
      } else {
        fetch(`${API}/api/playback/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(() => {});
      }
    };

    const handleReady = () => {
      setIsLoading(false);
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    };

    const handlePlay = () => {
      handleReady();
      if (current._stalkerCmd && reportedDirectGenerationRef.current !== current.streamGeneration) {
        reportedDirectGenerationRef.current = current.streamGeneration || current.url;
        reportStalkerAudit("direct_success");
      }
      lastMediaTime = video.currentTime;
      lastMediaProgressAt = Date.now();
      autoRecoveryRef.current.hls = 0;
      autoRecoveryRef.current.ts = 0;
      autoRecoveryRef.current.stall = 0;
      clearTimeout(debounceTimer);
      if (!isTracking) {
        isTracking = true;
        // Only send immediate ping if it's been more than 5 seconds since the last one
        if (Date.now() - lastHeartbeatTime > 5000) {
          sendHeartbeat();
        }
        heartbeatTimer = setInterval(() => sendHeartbeat(), 60000);
      }
    };

    const stallCheckTimer = window.setInterval(() => {
      if (cancelled || playbackPhaseRef.current !== "content" || video.paused || video.ended || document.hidden) return;
      if (video.currentTime > lastMediaTime + 0.05) {
        lastMediaTime = video.currentTime;
        lastMediaProgressAt = Date.now();
        if (autoRecoveryRef.current) autoRecoveryRef.current.stall = 0;
        return;
      }
      if (Date.now() - lastMediaProgressAt < 15_000) return;
      const bufferedAhead = video.buffered.length
        ? video.buffered.end(video.buffered.length - 1) - video.currentTime
        : 0;
      if (bufferedAhead > 2) return;
      lastMediaProgressAt = Date.now();
      stallRecoveryRef.current?.("playback_progress_timeout");
    }, 5000);
    const handleStalled = () => {
      if (!video.paused && !video.ended && video.currentTime > 0.05) {
        lastMediaProgressAt = Math.min(lastMediaProgressAt, Date.now() - 10_000);
      }
    };
    const handlePauseOrWait = () => {
      clearTimeout(debounceTimer);
      // Wait 1.5 seconds to confirm they actually paused and aren't just scrubbing/seeking
      debounceTimer = setTimeout(() => {
        if (isTracking) {
          isTracking = false;
          clearInterval(heartbeatTimer);
          sendHeartbeat();
          reportProgress(false, 'pause');
        }
      }, 1500);
    };

    const handleEnd = () => {
      clearTimeout(debounceTimer);
      isTracking = false;
      clearInterval(heartbeatTimer);
      if (current.type === "live" && playbackPhaseRef.current === "content") {
        sendHeartbeat(false);
        showStreamError({
          icon: "!",
          title: "Stream Ended",
          body: "The provider closed the direct stream. Select Try Again to reconnect.",
        });
        return;
      }
      sendHeartbeat(true);
      reportProgress(true, 'ended');
    };

    const handleUnload = () => {
      if (isTracking) {
        sendHeartbeat(false, true);
        reportProgress(false, 'close');
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden && isTracking) {
        reportProgress(false, 'hidden');
      }
    };

    const handleResumeRetry = () => {
      if (!resumeRetryRef.current) return;
      if (handleLoadedMetadata()) {
        resumeRetryRef.current = false;
      }
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("loadeddata", handleReady);
    video.addEventListener("canplay", handleResumeRetry);
    video.addEventListener("durationchange", handleResumeRetry);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("playing", handlePlay);
    video.addEventListener("pause", handlePauseOrWait);
    video.addEventListener("ended", handleEnd);
    video.addEventListener("waiting", handleStalled);
    video.addEventListener("stalled", handleStalled);
    window.addEventListener("beforeunload", handleUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    async function start() {
      setStreamErr(null);
      setAdState(null);
      destroyPlayers();

      if (ENABLE_VAST && VAST_URL && isAdEligible && !adPlayedRef.current) {
        adPlayedRef.current = true;
        try {
          playbackPhaseRef.current = "ad";
          const ad = await fetchVastAd(VAST_URL, video);
          if (cancelled || sessionId !== adSessionRef.current) return;
          if (ad?.mediaUrl) {
            await playVastPreroll(video, ad, () => cancelled || sessionId !== adSessionRef.current);
            if (cancelled || sessionId !== adSessionRef.current) return;
          }
        } catch {
          // Ad failures must not block the requested stream.
        } finally {
          setAdState(null);
        }
      }

      if (cancelled || sessionId !== adSessionRef.current) return;
      playbackPhaseRef.current = "content";
      initPlayer(current.url);
      showOSD();
    }

    start();
    return () => {
      cancelled = true;
      adSessionRef.current += 1;
      adFinishRef.current = null;
      setAdState(null);
      reportProgress(false, 'close');
      resumeRetryRef.current = false;
      playbackPhaseRef.current = "idle";
      destroyPlayers();
      clearTimeout(osdTimer.current);
      clearTimeout(qchTimer.current);
      
      // Cleanup heartbeat timers and listeners
      clearTimeout(debounceTimer);
      clearInterval(heartbeatTimer);
      clearInterval(stallCheckTimer);
      stallRecoveryRef.current = null;
      if (video) {
        video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        video.removeEventListener("loadeddata", handleReady);
        video.removeEventListener("canplay", handleResumeRetry);
        video.removeEventListener("durationchange", handleResumeRetry);
        video.removeEventListener("timeupdate", handleTimeUpdate);
        video.removeEventListener("playing", handlePlay);
        video.removeEventListener("pause", handlePauseOrWait);
        video.removeEventListener("ended", handleEnd);
        video.removeEventListener("waiting", handleStalled);
        video.removeEventListener("stalled", handleStalled);
      }
      window.removeEventListener("beforeunload", handleUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [current.url, contentIdentity, retryKey, streamRevision]);

  // Keyboard shortcuts (TiviMate + SFVIP style)
  useEffect(() => {
    function onKey(e) {
      const v = videoRef.current;
      if (!v) return;
      if (e.target.tagName === "INPUT") return;
      switch(e.key) {
        case " ":
        case "k":
          e.preventDefault();
          v.paused ? v.play() : v.pause();
          showOSD(); break;
        case "f":
        case "F":
          document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.();
          break;
        case "m":
        case "M":
          v.muted = !v.muted; showOSD(); break;
        case "ArrowLeft":
          e.preventDefault();
          if (current.type === "live") prevChannel();
          else { v.currentTime = Math.max(0, v.currentTime - 10); showOSD(); }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (current.type === "live") nextChannel();
          else { v.currentTime = Math.min(v.duration||0, v.currentTime + 10); showOSD(); }
          break;
        case "ArrowUp":
          e.preventDefault();
          if (current.type === "live") prevChannel();
          else { v.volume = Math.min(1, v.volume + 0.1); showOSD(); }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (current.type === "live") nextChannel();
          else { v.volume = Math.max(0, v.volume - 0.1); showOSD(); }
          break;
        case "Escape":
          onClose(); break;
        case "p":
        case "P":
          pip(); break;
        case "s":
        case "S":
          e.preventDefault();
          setShowStats(prev => !prev); break;
        default: break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, chIdx]);

  function prevChannel() {
    if (!channelList || channelList.length === 0) return;
    const i = Math.max(0, (chIdx < 0 ? 0 : chIdx) - 1);
    setChIdx(i); setCurrent(channelList[i]);
    setShowQCH(true);
    clearTimeout(qchTimer.current);
    qchTimer.current = setTimeout(() => setShowQCH(false), 2500);
    showOSD();
  }

  function nextChannel() {
    if (!channelList || channelList.length === 0) return;
    const max = channelList.length - 1;
    const i = Math.min(max, (chIdx < 0 ? 0 : chIdx) + 1);
    setChIdx(i); setCurrent(channelList[i]);
    setShowQCH(true);
    clearTimeout(qchTimer.current);
    qchTimer.current = setTimeout(() => setShowQCH(false), 2500);
    showOSD();
  }

  // Preserve VOD position when the user explicitly retries native playback.
  function retryNativeStream() {
    if (recoveryPositionRef.current == null && videoRef.current?.currentTime > 0.1) {
      recoveryPositionRef.current = videoRef.current.currentTime;
    }
    setRetryKey(key => key + 1);
  }

  async function activateCompatibilityRelay() {
    if (typeof onRequestRelay !== "function" || relayLoading) return;
    if (!window.confirm("Use compatibility relay? Media will temporarily pass through the VPS and may be subject to limits.")) return;
    setRelayLoading(true);
    try {
      const relayed = await onRequestRelay(current);
      if (!relayed?.url) throw new Error("Compatibility relay did not return a playable URL");
      destroyPlayers();
      setStreamErr(null);
      setIsLoading(true);
      setCurrent(relayed);
      setStreamRevision(value => value + 1);
    } catch (error) {
      showStreamError({ icon: "!", title: "Compatibility Relay Unavailable", body: error?.message || "The relay request failed." });
    } finally {
      setRelayLoading(false);
    }
  }

  async function pip() {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await v.requestPictureInPicture?.();
    } catch (e) { console.warn("Picture-in-Picture request failed:", e.message); }
  }

  const epgNow = epgData ? getEPGNow(epgData, current.epgId, nowMs) : null;
  const qchChannels = channelList && chIdx >= 0
    ? channelList.slice(Math.max(0, chIdx-2), Math.min(channelList.length, chIdx+3))
    : [];

  return (
    <div className="player-ov" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="player-wrap">
        <div style={{ position:"relative" }}>
          <video ref={videoRef} className="player-video" controls playsInline />
          {isLoading && !streamErr && (
            <div data-testid="player-loading" style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,.35)",pointerEvents:"none"}}>
              <div className="spinner" aria-label="Loading stream" />
            </div>
          )}
          {current._stalkerRelayActive && (
            <div style={{position:"absolute",top:10,left:10,zIndex:4,padding:".35rem .6rem",borderRadius:6,background:"#9a3412",color:"white",fontSize:".72rem",fontWeight:700}}>
              Compatibility relay active
            </div>
          )}
          {adState?.active && (
            <div className="player-ad">
              <div className="player-ad-badge">Sponsored Ad</div>
              <div className="player-ad-title">{adState.title}</div>
              <div className="player-ad-meta">{adState.mediaType || "VAST preroll"}</div>
              <div className="player-ad-actions">
                {adState.clickThrough && (
                  <button className="player-ad-link" onClick={() => window.open(adState.clickThrough, "_blank", "noopener,noreferrer")}>
                    Learn More
                  </button>
                )}
                {adState.skipEnabled && (adState.canSkip ? (
                  <button className="player-ad-skip" onClick={() => adFinishRef.current?.("skip")}>
                    Skip Ad
                  </button>
                ) : (
                  <div className="player-ad-countdown">Skip in {adState.skipRemaining}s</div>
                ))}
              </div>
            </div>
          )}
          {streamErr && (
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
                background:"rgba(0,0,0,.88)",padding:"2rem",textAlign:"center"}}>
              <div style={{maxWidth:"400px"}}>
                <div style={{width:"2.2rem",height:"2.2rem",margin:"0 auto .75rem",border:"2px solid currentColor",borderRadius:"50%",display:"grid",placeItems:"center",fontSize:"1.35rem",fontWeight:800}}>{streamErr.icon}</div>
                <div style={{fontSize:".9rem",color:"var(--t1)",fontWeight:600,marginBottom:".5rem"}}>{streamErr.title}</div>
                <div style={{fontSize:".78rem",color:"var(--t2)",lineHeight:1.6}}>{streamErr.body}</div>
                <button className="btn-primary" style={{marginTop:"1rem"}} onClick={retryNativeStream}>Try Again</button>
                {current._stalkerRelayAvailable && !current._stalkerRelayActive && typeof onRequestRelay === "function" && (
                  <button className="btn-secondary" style={{marginTop:".65rem",marginLeft:".5rem"}} disabled={relayLoading} onClick={activateCompatibilityRelay}>
                    {relayLoading ? "Starting Relay..." : "Use Compatibility Relay"}
                  </button>
                )}
              </div>
            </div>
          )}
          {/* OSD */}
          {osd && (
            <div className="osd" onClick={showOSD}>
              {current.logo
                ? <img className="osd-logo" src={imgSrc(current.logo)} alt="" onError={e => e.target.style.display="none"} />
                : <div className="osd-logo-ph">{current.type==="live"?"📺":"🎬"}</div>}
              <div>
                {current.num && <div className="osd-num">CH {current.num}</div>}
                <div className="osd-name">{current.name}</div>
                {epgNow && (
                  <div className="osd-epg">
                    ▶ {epgNow.title}
                    {epgNow.stop && (
                      <span className="osd-epg-left">
                        {Math.max(0, Math.ceil((epgNow.stop - nowMs)/60000))}m left
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {/* Stream stats overlay */}
          {showStats && (
            <div style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,.82)",color:"#0f0",
                fontFamily:"monospace",fontSize:".68rem",padding:".6rem .8rem",borderRadius:6,lineHeight:1.7,
                zIndex:20,maxWidth:"320px",pointerEvents:"none"}}>
              <div style={{color:"#fff",fontWeight:700,marginBottom:4,fontSize:".72rem"}}>Stream Stats</div>
              {Object.entries(stats).map(([k, v]) => (
                <div key={k}><span style={{color:"#aaa"}}>{k}: </span>{v}</div>
              ))}
            </div>
          )}
          {/* Quick channel switcher */}
          {showQCH && channelList && (
            <div className="qch">
              {qchChannels.map((ch, i) => {
                const isActive = ch.id === current.id || ch.url === current.url;
                return (
                  <div key={ch.id||i} className={`qch-item ${isActive?"active":""}`}>
                    {ch.logo
                      ? <img className="qch-thumb" src={imgSrc(ch.logo)} alt="" onError={e => e.target.style.display="none"} />
                      : <div className="qch-thumb-ph">📺</div>}
                    <div className="qch-n">{ch.name}</div>
                    {ch.num && <div className="qch-num">{ch.num}</div>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Catch-up Menu */}
          {showCatchupMenu && current.type === "live" && epgData?.[current.epgId] && (() => {
            const now = Date.now();
            const pastPrograms = epgData[current.epgId].filter(p => new Date(p.stop).getTime() < now).reverse(); // Most recent first

            return (
              <div style={{position:"absolute",bottom:"60px",right:"80px",background:"rgba(0,0,0,.9)",color:"#fff",
                padding:"1rem",borderRadius:8,zIndex:20,width:"300px",maxHeight:"400px",overflowY:"auto", border:"1px solid var(--border)"}}

                onClick={e => e.stopPropagation()}>
                <div style={{fontWeight:700,marginBottom:".8rem",color:"var(--accent)",fontSize:".9rem",textTransform:"uppercase"}}>Catch-up TV Schedule</div>
                {pastPrograms.length === 0 ? (
                   <div style={{fontSize:".85rem", color:"var(--t2)"}}>No past programs available.</div>
                ) : (
                  pastPrograms.map((p, idx) => (
                    <div key={idx}
                         onClick={() => {
                           if (onPlayCatchup) {
                             onPlayCatchup(current, p);
                             setShowCatchupMenu(false);
                           }
                         }}
                         style={{padding:".6rem",cursor:"pointer",borderRadius:4,fontSize:".85rem",borderBottom:"1px solid var(--border)",
                         background: "transparent", color: "var(--t1)", display:"flex", flexDirection:"column", gap:".2rem"}}
                         onMouseEnter={e => e.currentTarget.style.background = "var(--hover-bg)"}
                         onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <div style={{fontWeight:600}}>{p.title}</div>
                      <div style={{fontSize:".75rem", color:"var(--t3)"}}>{new Date(p.start).toLocaleTimeString()} - {new Date(p.stop).toLocaleTimeString()}</div>
                    </div>
                  ))
                )}
              </div>
            );
          })()}
        </div>
        <div className="player-bar">
          <div style={{flex:1,overflow:"hidden"}}>
            <div className="player-title">
              {current.name}
              {current.group && <span className="badge">{current.group}</span>}
            </div>
            {epgNow && <div className="player-epg">▶ {epgNow.title}</div>}
          </div>
          {channelList && current.type === "live" && (
            <>
              <button className="player-ctrl" onClick={prevChannel}>◀ {t("prev")}</button>
              <button className="player-ctrl" onClick={nextChannel}>{t("next")} ▶</button>
            </>
          )}
          <button className="player-ctrl" onClick={pip} title="Picture in Picture">⧉ {t("pip")}</button>
          <button className={`player-ctrl${showStats?" on":""}`} onClick={() => setShowStats(s=>!s)} title="Stream Stats">📊</button>
          {(audioTracks.length > 1 || subTracks.length > 0) && (
            <button className={`player-ctrl${showTracksMenu?" on":""}`} onClick={() => { setShowTracksMenu(s=>!s); setShowCatchupMenu(false); }} title="Audio & Subtitles">
              💬
            </button>
          )}
          {connType === "stalker" && current.type === "live" && epgData?.[current.epgId] && (
            <button className={`player-ctrl${showCatchupMenu?" on":""}`} onClick={() => { setShowCatchupMenu(s=>!s); setShowTracksMenu(false); }} title="Catch-up TV">
              ↩️
            </button>
          )}
          <button className="player-ctrl" onClick={() => { onFav?.(current); showOSD(); }} title={t("fav")}>
            {isFav?.(current) ? `♥ ${t("fav")}` : `♡ ${t("fav")}`}
          </button>
          <button className="player-close" onClick={onClose}>✕ {t("close")}</button>
        </div>
        {showTracksMenu && (
          <div className="player-track-menu" onClick={e => e.stopPropagation()}>
            {audioTracks.length > 1 && (
              <div className="player-track-section">
                <div className="player-track-heading">Audio</div>
                {audioTracks.map((track, index) => (
                  <button
                    key={`audio-${track.id ?? index}`}
                    className={`player-track-item${activeAudio === index ? " on" : ""}`}
                    onClick={() => selectAudioTrack(index)}
                  >
                    <span>{audioTrackLabel(track, index)}</span>
                    {activeAudio === index && <span className="player-track-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
            {subTracks.length > 0 && (
              <div className="player-track-section">
                <div className="player-track-heading">Subtitles</div>
                <button
                  className={`player-track-item${activeSub === -1 ? " on" : ""}`}
                  onClick={() => selectSubtitleTrack(-1)}
                >
                  <span>Off</span>
                  {activeSub === -1 && <span className="player-track-check">✓</span>}
                </button>
                {subTracks.map((track, index) => (
                  <button
                    key={`sub-${track.id ?? index}`}
                    className={`player-track-item${activeSub === index ? " on" : ""}`}
                    onClick={() => selectSubtitleTrack(index)}
                  >
                    <span>{subtitleTrackLabel(track, index)}</span>
                    {activeSub === index && <span className="player-track-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="kbd-hint">
          <span><span className="kbd">Space</span>{t("playPause")}</span>
          <span><span className="kbd">F</span>{t("fullscreen")}</span>
          <span><span className="kbd">M</span>{t("mute")}</span>
          <span><span className="kbd">←→</span>{current.type==="live"?t("channels"):"±10s"}</span>
          <span><span className="kbd">↑↓</span>{current.type==="live"?t("channels"):t("volume")}</span>
          <span><span className="kbd">P</span>{t("pip")}</span>
          <span><span className="kbd">S</span>Stats</span>
          <span><span className="kbd">Esc</span>Close</span>
        </div>
      </div>
    </div>
  );
}

export default memo(Player);
