import React, { useRef, useEffect, useState, useLayoutEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const CARD_MIN_WIDTH = 132;
const GAP = 12;

export default function VirtualGrid({ 
  items, 
  section, 
  isFav, 
  historyMap, 
  playItem, 
  toggleFav, 
  setExpandedItem,
  imgSrc,
  header,
  onEndReached,
  canLoadMore = false,
}) {
  const scrollRef = useRef(null);
  const [gridMetrics, setGridMetrics] = useState({ columns: 1, rowHeight: 285 });
  const [loadingMore, setLoadingMore] = useState(false);

  // The parent remounts this grid when the category/search scope changes.
  // Do not reset on every appended page or pagination will jump to the top.
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, []);

  // Measure scroll container width to calculate exact columns and row height dynamically
  useEffect(() => {
    if (!scrollRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const width = entry.contentRect.width;
        if (width <= 0) continue;
        
        const cols = Math.max(1, Math.floor((width + GAP) / (CARD_MIN_WIDTH + GAP)));
        const cardWidth = (width - ((cols - 1) * GAP)) / cols;
        const rHeight = (cardWidth * 1.5) + 60 + GAP;

        setGridMetrics(prev => prev.columns === cols && prev.rowHeight === rHeight ? prev : { columns: cols, rowHeight: rHeight });
      }
    });
    observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(items.length / gridMetrics.columns);

  const rowHeightRef = useRef(gridMetrics.rowHeight);
  useEffect(() => { rowHeightRef.current = gridMetrics.rowHeight; });

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: useCallback(() => rowHeightRef.current, []),
    overscan: 3,
  });

  const loadMore = async () => {
    if (loadingMore || !canLoadMore || !onEndReached) return;
    setLoadingMore(true);
    try { await onEndReached(); } finally { setLoadingMore(false); }
  };

  return (
    <div 
      ref={scrollRef} 
      style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', width: '100%' }}
      className="virtual-scroll-container"
    >
      {header && <div style={{ flexShrink: 0 }}>{header}</div>}
      
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * gridMetrics.columns;
          const rowItems = items.slice(startIndex, startIndex + gridMetrics.columns);

          return (
            <div
              key={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${gridMetrics.columns}, 1fr)`,
                gap: `${GAP}px`,
                paddingBottom: `${GAP}px`,
                boxSizing: 'border-box'
              }}
            >
              {rowItems.map((item, i) => {
                const faved = isFav(item);
                const hist = historyMap.get(item.id || item.url);
                const pct = hist?.position && hist?.duration ? Math.min(100, (hist.position/hist.duration)*100) : 0;
                
                return (
                  <div key={item.id||i} className="vod-card" onClick={() => playItem(item)} title={item.name}>
                    {item.logo
                      ? <img className="vod-poster" loading="lazy" src={imgSrc(item.logo)} alt="" onError={e=>e.target.style.display="none"} />
                      : <div className="vod-ph">{section==="series"?"📽":"🎬"}</div>}
                    {pct > 2 && (
                      <div className="resume-bar"><div className="resume-fill" style={{width:`${pct}%`}} /></div>
                    )}
                    <div className="vod-info">
                      <div className="vod-title">{item.name}</div>
                      <div className="vod-meta">
                        {[item.year, item.rating && `★${parseFloat(item.rating||0).toFixed(1)}`].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <button className={`vod-fav ${faved?"on":""}`}
                      onClick={e=>{e.stopPropagation();toggleFav(item);}}>
                      {faved?"♥":"♡"}
                    </button>
                    {(item.type==="vod"||item.type==="series") && (
                      <button className="vod-info-btn" onClick={e=>{e.stopPropagation();setExpandedItem(item);}} title="Details">ⓘ</button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {canLoadMore && onEndReached && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0.75rem 0', flexShrink: 0 }}>
          <button className="c-btn" type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
