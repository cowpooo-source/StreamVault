import { useState, useEffect, useMemo, memo, forwardRef } from "react";
import { imgSrc } from "../utils.js";
import { epgLookup, PX_PER_MIN, TOTAL_HOURS, TOTAL_MS, TOTAL_PX, CH_COL_W, ROW_H, msToPx, fmtT } from "../epg.js";

const TimelineGrid = memo(forwardRef(function TimelineGrid({ channels, epgData, onPlay, onPlayCatchup, hasMore, onLoadMore, loadText }, outerRef) {
  const [nowMs, setNowMs] = useState(() => Date.now());
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
  
  // Calculate total height needed. If hasMore, add 1 extra row for the button.
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
              <div key={ch.id||i} className="epg-ch-cell" onClick={()=>onPlay(ch)} title={ch.name}>
                {ch.logo && <img className="epg-ch-logo" loading="lazy" src={imgSrc(ch.logo)} alt="" onError={e=>{e.target.style.display="none";}} />}
                <span className="epg-ch-name">{ch.name}</span>
              </div>
            ))}
            {hasMore && (
              <div className="epg-ch-cell" style={{justifyContent: 'center', cursor: 'pointer', background: 'var(--s1)'}} onClick={onLoadMore}>
                <button className="c-btn" style={{padding: '.2rem .5rem', fontSize: '.7rem', pointerEvents: 'none'}}>{loadText || "Load More"}</button>
              </div>
            )}
          </div>

          {/* Programs area (absolutely positioned blocks) */}
          <div className="epg-prog-area" style={{width:TOTAL_PX,position:"relative"}}>
            {channels.map((ch,rowIdx) => {
              const epgCh = epgLookup(epgData, ch);
              const progs = epgCh ? epgCh.filter(p => p.start < windowEnd && p.stop > windowStart) : [];
              return (
                <div key={ch.id||rowIdx} className="epg-prog-row">
                  {progs.map((p,pi) => {
                    const clampStart = Math.max(p.start, windowStart);
                    const clampEnd = Math.min(p.stop, windowEnd);
                    const leftPx = msToPx(clampStart, windowStart);
                    const widthPx = ((clampEnd - clampStart) / 60000) * PX_PER_MIN;
                    if (widthPx < 2) return null;
                    const isNow = p.start <= nowMs && p.stop > nowMs;
                    const isPast = p.stop <= nowMs;
                    const cls = `epg-prog-block${isNow?" now":""}${isPast?" past":""}`;
                    return (
                      <div key={pi} className={cls}
                        style={{left:leftPx,width:widthPx}}
                        onClick={()=> isPast && onPlayCatchup ? onPlayCatchup(ch, p) : onPlay(ch)}
                        title={`${p.title}\n${fmtT(p.start)} \u2013 ${fmtT(p.stop)}${isPast ? "\nClick to play catchup" : ""}`}>
                        {widthPx > 50 && <div className="epg-prog-t">{isPast && <span className="epg-catchup-icon">↩️</span>}{p.title}</div>}
                        {widthPx > 90 && <div className="epg-prog-s">{fmtT(p.start)} \u2013 {fmtT(p.stop)}</div>}
                        </div>
                    );
                  })}
                </div>
              );
            })}
            {hasMore && (
              <div className="epg-prog-row" style={{borderBottom: 'none'}}></div>
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
