import React, { useState, useEffect, useCallback, memo } from 'react';
import { imgSrc, API } from '../utils.js';
import { safeJsonFetch } from '../app-runtime.js';

// DISCOVER (TMDB)
// ══════════════════════════════════════════════════════════════════
const TMDB_IMG = "https://image.tmdb.org/t/p/";

function normalizeTitle(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

const DiscoverView = memo(function DiscoverView({ tmdbKey, setTmdbKey, vod, series, onPlay }) {
  const [keyInput, setKeyInput]           = useState(tmdbKey);
  const [trending, setTrending]           = useState([]);
  const [popularMovies, setPopularMovies] = useState([]);
  const [popularTV, setPopularTV]         = useState([]);
  const [loading, setLoading]             = useState(false);
  const [err, setErr]                     = useState("");
  const [picker, setPicker]               = useState(null); // { tmdbItem, matches[] }

  useEffect(() => { if (tmdbKey) loadAll(tmdbKey); }, [tmdbKey]);

  async function loadAll(key) {
    setLoading(true); setErr("");
    try {
      const u = (path) => key === "server"
        ? `${API}/api/tmdb/${path}?language=en-US`
        : `https://api.themoviedb.org/3/${path}?api_key=${key}&language=en-US`;
      const [t, pm, ptv] = await Promise.all([
        fetch(u("trending/all/week")).then(safeJsonFetch),
        fetch(u("movie/popular")).then(safeJsonFetch),
        fetch(u("tv/popular")).then(safeJsonFetch),
      ]);
      if (t.success === false) throw new Error(t.status_message || "Invalid API key");
      setTrending(t.results || []);
      setPopularMovies(pm.results || []);
      setPopularTV(ptv.results || []);
    } catch(e) {
      setErr(e.message);
      localStorage.removeItem("sv-tmdb-key");
      setTmdbKey("");
    } finally { setLoading(false); }
  }

  function saveKey() {
    const k = keyInput.trim();
    if (!k) return;
    localStorage.setItem("sv-tmdb-key", k);
    setTmdbKey(k);
  }

  // Return ALL library items that match the TMDB title
  const findAllInLibrary = useCallback((tmdbItem) => {
    const title = normalizeTitle(tmdbItem.title || tmdbItem.name);
    if (!title || title.length < 2) return [];
    return [...vod, ...series].filter(item => {
      const n = normalizeTitle(item.name);
      if (!n) return false;
      if (n === title) return true;
      // partial match only if both names are long enough to avoid false positives
      const minLen = Math.min(n.length, title.length);
      if (minLen >= 6 && (n.includes(title) || title.includes(n))) return true;
      return false;
    });
  }, [vod, series]);

  function handleCardClick(tmdbItem) {
    const matches = findAllInLibrary(tmdbItem);
    if (matches.length === 1) {
      onPlay(matches[0]);
    } else {
      // 0 matches → show "not found"; 2+ matches → show picker
      setPicker({ tmdbItem, matches });
    }
  }

  if (!tmdbKey) {
    return (
      <div className="disc-key-prompt">
        <div style={{fontSize:"2.5rem"}}>✨</div>
        <div style={{fontSize:"1rem",fontWeight:600}}>Discover Trending Content</div>
        <div style={{fontSize:".82rem",color:"var(--t2)",maxWidth:"360px",lineHeight:1.6}}>
          See what's trending on TMDB and find matches in your library.{" "}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer"
            style={{color:"var(--accent)"}}>Get a free API key →</a>
        </div>
        {err && <div className="err" style={{maxWidth:"360px"}}>{err}</div>}
        <div style={{display:"flex",gap:".5rem",width:"100%",maxWidth:"380px"}}>
          <input className="fi" placeholder="Paste TMDB v3 API key…" value={keyInput}
            onChange={e=>setKeyInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&saveKey()} />
          <button className="btn-go" style={{padding:".62rem .9rem",fontSize:".84rem"}} onClick={saveKey}>Go</button>
        </div>
      </div>
    );
  }

  if (loading) return <div className="loading"><div className="spinner" /><span>Loading trending…</span></div>;

  const hero = trending[0];

  function renderTMDBCard(item, i) {
    const matches = findAllInLibrary(item);
    const inLib   = matches.length > 0;
    const poster  = item.poster_path ? `${TMDB_IMG}w185${item.poster_path}` : null;
    const year    = (item.release_date || item.first_air_date || "").slice(0, 4);
    const rating  = item.vote_average ? item.vote_average.toFixed(1) : null;
    const title   = item.title || item.name || "Unknown";
    return (
      <div key={item.id || i} className="disc-card" onClick={() => handleCardClick(item)} title={title}>
        {poster
          ? <img className="disc-poster" src={poster} alt={title} />
          : <div className="disc-poster-ph">{item.media_type === "tv" ? "📺" : "🎬"}</div>}
        {rating && <div className="disc-rating">★{rating}</div>}
        {inLib && <div className="disc-in-lib" title={`${matches.length} match${matches.length>1?"es":""} in library`}>
          {matches.length > 1 ? matches.length : "▶"}
        </div>}
        <div className="disc-card-title">{title}</div>
        <div className="disc-card-meta">{[year, item.media_type === "tv" ? "TV" : "Film"].filter(Boolean).join(" · ")}</div>
      </div>
    );
  }

  return (
    <div className="discover-body">
      {/* Hero */}
      {hero && (() => {
        const heroMatches = findAllInLibrary(hero);
        return (
          <div className="disc-hero" onClick={() => handleCardClick(hero)}>
            {hero.backdrop_path && (
              <img className="disc-hero-bg" src={`${TMDB_IMG}w1280${hero.backdrop_path}`} alt="" />
            )}
            <div className="disc-hero-info">
              <div className="disc-hero-title">{hero.title || hero.name}</div>
              <div className="disc-hero-meta">
                {[(hero.release_date||hero.first_air_date||"").slice(0,4),
                  hero.vote_average && `★ ${hero.vote_average.toFixed(1)}`,
                  hero.media_type === "tv" ? "TV Series" : "Movie"
                ].filter(Boolean).join(" · ")}
              </div>
              {hero.overview && <div className="disc-hero-overview">{hero.overview}</div>}
              {heroMatches.length > 0 && (
                <div className="disc-hero-avail">
                  {heroMatches.length === 1 ? "▶ In your library — click to play" : `▶ ${heroMatches.length} matches in your library — click to choose`}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Trending This Week */}
      <div className="disc-section">
        <div className="section-label">Trending This Week</div>
        <div className="disc-row">
          {trending.map((item, i) => renderTMDBCard(item, i))}
        </div>
      </div>

      {/* Popular Movies */}
      <div className="disc-section">
        <div className="section-label">Popular Movies</div>
        <div className="disc-row">
          {popularMovies.map((item, i) => renderTMDBCard({...item, media_type:"movie"}, i))}
        </div>
      </div>

      {/* Popular TV */}
      <div className="disc-section">
        <div className="section-label">Popular TV Shows</div>
        <div className="disc-row">
          {popularTV.map((item, i) => renderTMDBCard({...item, media_type:"tv"}, i))}
        </div>
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",paddingTop:".4rem"}}>
        <button className="btn-sm" style={{width:"auto"}}
          onClick={() => { localStorage.removeItem("sv-tmdb-key"); setTmdbKey(""); setKeyInput(""); }}>
          Change API Key
        </button>
      </div>

      {/* Picker / Not-found modal */}
      {picker && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.82)",zIndex:600,
          display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}
          onClick={() => setPicker(null)}>
          <div style={{background:"var(--s1)",border:"1px solid var(--b2)",borderRadius:"14px",
            padding:"1.5rem",width:"100%",maxWidth:"420px",maxHeight:"72vh",overflow:"auto"}}
            onClick={e => e.stopPropagation()}>

            {/* TMDB title + meta */}
            <div style={{display:"flex",gap:"1rem",marginBottom:"1.2rem",alignItems:"flex-start"}}>
              {picker.tmdbItem.poster_path && (
                <img src={`${TMDB_IMG}w92${picker.tmdbItem.poster_path}`}
                  style={{width:54,borderRadius:7,flexShrink:0,border:"1px solid var(--b2)"}} alt="" />
              )}
              <div>
                <div style={{fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"1.15rem",lineHeight:1.2}}>
                  {picker.tmdbItem.title || picker.tmdbItem.name}
                </div>
                <div style={{fontSize:".72rem",color:"var(--t2)",marginTop:".25rem"}}>
                  {[(picker.tmdbItem.release_date||picker.tmdbItem.first_air_date||"").slice(0,4),
                    picker.tmdbItem.media_type==="tv" ? "TV Series" : "Movie"
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
            </div>

            {picker.matches.length === 0 ? (
              <div style={{textAlign:"center",padding:"1.4rem 0"}}>
                <div style={{fontSize:"2rem",marginBottom:".5rem"}}>🔍</div>
                <div style={{fontSize:".9rem",fontWeight:600}}>Not in your library</div>
                <div style={{fontSize:".78rem",color:"var(--t2)",marginTop:".4rem",lineHeight:1.55}}>
                  Load your Movies or Series first — connect via Xtream, M3U, or Stalker, then switch to the Movies/Series tab.
                </div>
              </div>
            ) : (
              <>
                <div style={{fontSize:".68rem",color:"var(--t3)",textTransform:"uppercase",
                  letterSpacing:".1em",fontWeight:700,marginBottom:".6rem"}}>
                  {picker.matches.length} match{picker.matches.length > 1 ? "es" : ""} in your library
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:".4rem"}}>
                  {picker.matches.map((item, i) => (
                    <div key={item.id || i}
                      style={{display:"flex",alignItems:"center",gap:".75rem",padding:".6rem .8rem",
                        background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:"9px",
                        cursor:"pointer",transition:"border-color .15s"}}
                      onClick={() => { onPlay(item); setPicker(null); }}
                      onMouseEnter={e => e.currentTarget.style.borderColor="var(--accent)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor="var(--b2)"}>
                      {item.logo
                        ? <img loading="lazy" src={imgSrc(item.logo)} style={{width:38,height:38,objectFit:"contain",
                            borderRadius:5,background:"var(--s3)",flexShrink:0}} alt="" />
                        : <div style={{width:38,height:38,background:"var(--s3)",borderRadius:5,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            flexShrink:0,fontSize:".9rem"}}>
                            {item.type === "series" ? "📽" : "🎬"}
                          </div>}
                      <div style={{flex:1,overflow:"hidden"}}>
                        <div style={{fontSize:".82rem",fontWeight:500,overflow:"hidden",
                          textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                        <div style={{fontSize:".65rem",color:"var(--t3)",marginTop:".15rem"}}>
                          {item.group}{item.year ? ` · ${item.year}` : ""}
                        </div>
                      </div>
                      <div style={{fontSize:".8rem",color:"var(--accent)",flexShrink:0}}>▶</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{marginTop:"1.1rem",textAlign:"right"}}>
              <button className="btn-cancel" onClick={() => setPicker(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
});

export default DiscoverView;