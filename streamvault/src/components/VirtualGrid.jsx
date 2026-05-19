import React, { useRef, useEffect, useState, useMemo } from 'react';
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
  imgSrc
}) {
  const parentRef = useRef(null);
  const [columns, setColumns] = useState(1);

  // Measure parent width to calculate columns
  useEffect(() => {
    if (!parentRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const width = entry.contentRect.width;
        // Calculate how many columns fit: (width + gap) / (minWidth + gap)
        const cols = Math.floor((width + GAP) / (CARD_MIN_WIDTH + GAP));
        setColumns(Math.max(1, cols));
      }
    });
    observer.observe(parentRef.current);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(items.length / columns);
  
  // Approximate row height: Card width (1fr) is typically roughly equal to min-width on average.
  // Aspect ratio is 2:3 for poster, plus ~60px for info.
  // Assuming average width is 150px: poster height = 225px. Total height ~ 285px.
  const estimateRowHeight = () => 285;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: estimateRowHeight,
    overscan: 2, // Load 2 rows off-screen
  });

  return (
    <div 
      ref={parentRef} 
      style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}
      className="virtual-scroll-container"
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const rowItems = items.slice(startIndex, startIndex + columns);

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
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
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