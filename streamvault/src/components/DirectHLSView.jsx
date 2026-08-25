import React, { useState, memo } from 'react';
import Player from './Player.jsx';

const DirectHLSView = memo(function DirectHLSView() {
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState(null);
  const EXAMPLES = [
    ["HLS — Tears of Steel (Adaptive)", "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8"],
    ["HLS — Apple Advanced (fMP4)", "https://devstreaming-cdn.apple.com/videos/streaming/examples/adv_dv_atmos/main.m3u8"],
    ["MP4 — Big Buck Bunny", "https://www3.cde.ca.gov/download/rod/big_buck_bunny.mp4"],
    ["MP4 — Sintel (Open Movie)", "https://media.w3.org/2010/05/sintel/trailer.mp4"],
    ["MP4 — Cosmos Laundromat", "https://media.w3.org/2010/05/bunny/trailer.mp4"],
    ["Live — Bloomberg TV", "https://www.bloomberg.com/media-manifest/streams/us.m3u8"],
  ];
  return (
    <div className="hls-body">
      <div style={{fontSize:".84rem",color:"var(--t2)",lineHeight:1.6}}>
        Enter any HLS (.m3u8), DASH, or direct media URL. Great for testing your own streams.
      </div>
      <div className="hls-row">
        <input className="fi" placeholder="https://your-stream.com/live/stream.m3u8"
          value={url} onChange={e=>setUrl(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&url&&setPlaying({name:url.split("/").pop()||"Stream",url,type:"live",group:"Direct",_direct:true})} />
        <button className="btn-go" onClick={()=>url&&setPlaying({name:url.split("/").pop()||"Stream",url,type:"live",group:"Direct",_direct:true})}>▶ Play</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:".35rem"}}>
        <div style={{fontSize:".7rem",color:"var(--t3)",textTransform:"uppercase",letterSpacing:".08em",fontWeight:600}}>Public test streams</div>
        {EXAMPLES.map(([label,href]) => (
          <div key={label} style={{fontSize:".75rem",color:"var(--accent)",cursor:"pointer",textDecoration:"underline"}}
            onClick={()=>{setUrl(href);setPlaying({name:label,url:href,type:"live",group:"Test",_direct:true});}}>
            {label}
          </div>
        ))}
      </div>
      {playing && <Player item={playing} onClose={()=>setPlaying(null)} />}
    </div>
  );
});

export default DirectHLSView;