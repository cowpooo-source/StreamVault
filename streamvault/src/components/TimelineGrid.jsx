import { useState, useEffect, useMemo, useRef, useCallback, memo, forwardRef } from "react";
import { imgSrc } from "../utils.js";
import { epgLookup, PX_PER_MIN, TOTAL_HOURS, TOTAL_MS, TOTAL_PX, CH_COL_W, ROW_H, msToPx, fmtT } from "../epg.js";

// Helper: format start and stop times once
function fmtProgTimes(start, stop) {
  return { startLabel: fmtT(start), stopLabel: fmtT(stop) };
}

// Single delegated click handler — avoids per-block arrow function allocation
// Uses data attributes set on each program block
function buildProgClickHandler(progs, channels, onPlay, onPlayCatchup) {
  return (e) => {
    const block = e.target.closest("[data-prog-idx]");
    if (!block) return;
    const chIdx = parseInt(block.dataset.chIdx, 10);
    const progIdx = parseInt(block.dataset.progIdx, 10);
    const isPast = block.dataset.isPast === "1";
    const ch = channels[chIdx];
    const p = progs[chIdx]?.[progIdx];
    if (!ch || !p) return;
    if (isPast && onPlayCatchup) {
      onPlayCatchup(ch, p);
    } else {
      onPlay(ch);
    }
  };
}

const TimelineGrid = memo(forwardRef(function TimelineGrid({ channels, epgData, onPlay, onPlayCatchup, hasMore, onLoadMore, loadText, showCatchup }, outerRef) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const nowMsRef = useRef(nowMs);
  nowMsRef.current = nowMs;

  // Update nowMs every 60s — grid only re-renders when channels/epgData/window changes
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const windowStart = useMemo(() => nowMs - 3600000, [nowMs]);
  const windowEnd = useMemo(() => windowStart + TOTAL_MS, [windowStart]);

  const timeLabels = useMemo(() => {
    const labels = [];
    const snapStart = new Date(windowStart);
    snapStart.setMinutes(snapStart.getMinutes() < 30 ? 0 : 30, 0, 0);
    let t = snapStart.getTime();
    if (t < windowStart) t += 1800000;
    while (t < windowEnd) {
      const offsetPx = msToPx(t, windowStart);
      const d = new Date(t);
      labels.push({ ms: t, px: offsetPx, label: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
      t += 1800000;
    }
    return labels;
  }, [windowStart, windowEnd]);

  const nowLinePx = msToPx(nowMs, windowStart);

  // Pre-compute channel→programs lookup map once
  const chProgMap = useMemo(() => {
    const map = new Map();
    channels.forEach((ch, i) => {
      const epgCh = epgLookup(epgData, ch);
      if (!epgCh) { map.set(i, []); return; }
      // Filter to visible window
      const visible = epgCh.filter(p => p.start < windowEnd && p.stop > windowStart);
      // Attach formatted times once per program
      const withTimes = visible.map(p => {
        const { startLabel, stopLabel } = fmtProgTimes(p.start, p.stop);
        const isNow = p.start <= nowMs && p.stop > nowMs;
        const isPast = p.stop <= nowMs;
        return { ...p, startLabel, stopLabel, isNow, isPast };
      });
      map.set(i, withTimes);
    });
    return map;
  }, [channels, epgData, windowStart, windowEnd, nowMs]);

  // Single delegated click handler — allocated once per render, not per block
  const handleProgClick = useCallback((e) => {
    const block = e.target.closest("[data-prog-idx]");
    if (!block) return;
    const chIdx = parseInt(block.dataset.chIdx, 10);
    const progIdx = parseInt(block.dataset.progIdx, 10);
    const isPast = block.dataset.isPast === "1";
    const ch = channels[chIdx];
    const chProgs = chProgMap.get(chIdx);
    const p = chProgs?.[progIdx];
    if (!ch || !p) return;
    if (isPast && onPlayCatchup) {
      onPlayCatchup(ch, p);
    } else {
      onPlay(ch);
    }
  }, [channels, chProgMap, onPlay, onPlayCatchup]);

  const rowCount = channels.length + (hasMore ? 1 : 0);

  return (
    <div className="epg-outer" ref={outerRef}>
      <div className="epg-grid-wrap" style={{width:CH_COL_W+TOTAL_PX,minHeight:rowCount*ROW_H+32}}>
        {/* Sticky time header */}
        <div className="epg-time-header">
          <div className="epg-time-header-pad" />
          <div className="epg-time-header-track" style={{width:TOTAL_PX,position:"relative"}}>
            {timeLabels.map(tl => (
              <div key={tl.ms} className="epg-time-label" style={{left:tl.px}}>{tl.label}</div>
            ))}
          </div>
        </div>

        {/* Channel rows + program area */}
        <div className="epg-body">
          {/* Sticky channel column */}
          <div className="epg-ch-col">
            {channels.map((ch,i) => (
              <div key={ch.id||i} className="epg-ch-cell" onClick={() => onPlay(ch)} title={ch.name}>
                {ch.logo && <img className="epg-ch-logo" loading="lazy" src={imgSrc(ch.logo)} alt="" onError={e => { e.target.style.display = "none"; }} />}
                <span className="epg-ch-name">{ch.name}</span>
              </div>
            ))}
            {hasMore && (
              <div className="epg-ch-cell" style={{justifyContent: "center", cursor: "pointer", background: "var(--s1)"}} onClick={onLoadMore}>
                <button className="c-btn" style={{padding: ".2rem .5rem", fontSize: ".7rem", pointerEvents: "none"}}>{loadText || "Load More"}</button>
              </div>
            )}
          </div>

          {/* Programs area — single delegated click handler for all blocks */}
          <div
            className="epg-prog-area"
            style={{width:TOTAL_PX,position:"relative"}}
            onClick={handleProgClick}
          >
            {channels.map((ch, rowIdx) => {
              const progs = chProgMap.get(rowIdx) || [];
              return (
                <div key={ch.id||rowIdx} className="epg-prog-row">
                  {progs.map((p, pi) => {
                    const clampStart = Math.max(p.start, windowStart);
                    const clampEnd = Math.min(p.stop, windowEnd);
                    const leftPx = msToPx(clampStart, windowStart);
                    const widthPx = ((clampEnd - clampStart) / 60000) * PX_PER_MIN;
                    if (widthPx < 2) return null;
                    const cls = `epg-prog-block${p.isNow ? " now" : ""}${p.isPast ? " past" : ""}`;
                    return (
                      <div
                        key={pi}
                        className={cls}
                        style={{left: leftPx, width: widthPx}}
                        data-prog-idx={pi}
                        data-ch-idx={rowIdx}
                        data-is-past={p.isPast ? "1" : "0"}
                        title={`${p.title}\n${p.startLabel} – ${p.stopLabel}${p.isPast && showCatchup ? "\nClick to play catchup" : ""}`}
                      >
                        {widthPx > 50 && (
                          <div className="epg-prog-t">
                            {p.isPast && showCatchup && <span className="epg-catchup-icon">↩️</span>}
                            {p.title}
                          </div>
                        )}
                        {widthPx > 90 && (
                          <div className="epg-prog-s">
                            {p.startLabel} – {p.stopLabel}
                            {p.isNow && (
                              <span className="epg-prog-left">
                                {Math.max(0, Math.ceil((p.stop - nowMsRef.current)/60000))}m left
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {hasMore && (
              <div className="epg-prog-row" style={{borderBottom: "none"}}></div>
            )}

            {/* Current time red line */}
            {nowLinePx >= 0 && nowLinePx <= TOTAL_PX && (
              <div className="epg-now-line" style={{left:nowLinePx}} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}));

export default TimelineGrid;