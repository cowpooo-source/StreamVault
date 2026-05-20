import React, { useRef, useEffect, useState } from 'react';
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
  scrollRef // Added prop for global scroll context
}) {
  const containerRef = useRef(null);
  const [gridMetrics, setGridMetrics] = useState({ columns: 1, rowHeight: 285 });

  // Measure parent width to calculate exact columns and row height dynamically
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const width = entry.contentRect.width;
        if (width === 0) continue;
        
        // Calculate columns based on CSS grid logic
        const columns = Math.max(1, Math.floor((width + GAP) / (CARD_MIN_WIDTH + GAP)));
        
        // Calculate exact width of a single card
        const cardWidth = (width - ((columns - 1) * GAP)) / columns;
        
        // Poster aspect ratio is ~2:3 (1.5x width). Add ~60px for text info + gap
        const rowHeight = (cardWidth * 1.5) + 60 + GAP;

        setGridMetrics({ columns, rowHeight });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(items.length / gridMetrics.columns);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef?.current || null,
    estimateSize: () => gridMetrics.rowHeight,
    overscan: 3, // Load a few extra rows to prevent flickering during fast scroll
  });

  return (
    <div ref={containerRef} style={{ width: '100%', position: 'relative' }}>
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
                paddingBottom: `${GAP}px`, // act as row gap
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
    </div>
  );
}