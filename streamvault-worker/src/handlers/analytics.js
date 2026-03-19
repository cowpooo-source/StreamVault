// GET /api/analytics — admin dashboard data
import { jsonResponse } from "../utils/cors.js";

const FREE_TIER = {
  cf_requests_day: 100000,
  cf_d1_reads_day: 5000000,
  cf_d1_writes_day: 100000,
  cf_d1_storage_gb: 5,
  koyeb_bandwidth_gb: 100,
};

export async function handleAnalytics(request, env, url) {
  const db = env.SV_DB;
  const now = Math.floor(Date.now() / 1000);
  const h1 = now - 3600;
  const h24 = now - 86400;
  const d7 = now - 7 * 86400;
  const d30 = now - 30 * 86400;
  const today = new Date().toISOString().slice(0, 10);

  const [
    totalUsers, activeH1, activeH24, activeD7, activeD30,
    totalConnections, connectionsByType,
    totalContent, contentByType,
    totalFavorites, totalHistory,
    recentUsers, topContent,
    todayApiReqs, todayStreamReqs,
    weeklyUsage, dbSize,
  ] = await Promise.all([
    db.prepare("SELECT COUNT(*) as count FROM users").first(),
    db.prepare("SELECT COUNT(*) as count FROM users WHERE last_active >= ?").bind(h1).first(),
    db.prepare("SELECT COUNT(*) as count FROM users WHERE last_active >= ?").bind(h24).first(),
    db.prepare("SELECT COUNT(*) as count FROM users WHERE last_active >= ?").bind(d7).first(),
    db.prepare("SELECT COUNT(*) as count FROM users WHERE last_active >= ?").bind(d30).first(),
    db.prepare("SELECT COUNT(*) as count FROM connections").first(),
    db.prepare("SELECT type, COUNT(*) as count FROM connections GROUP BY type ORDER BY count DESC").all(),
    db.prepare("SELECT COUNT(*) as count FROM content_items").first(),
    db.prepare("SELECT type, COUNT(*) as count FROM content_items GROUP BY type ORDER BY count DESC").all(),
    db.prepare("SELECT COUNT(*) as count FROM favorites").first(),
    db.prepare("SELECT COUNT(*) as count FROM watch_history").first(),
    db.prepare(`
      SELECT u.id, u.created_at, u.last_active,
        (SELECT COUNT(*) FROM connections WHERE user_id = u.id) as connections,
        (SELECT COUNT(*) FROM favorites WHERE user_id = u.id) as favorites,
        (SELECT COUNT(*) FROM watch_history WHERE user_id = u.id) as history_items
      FROM users u ORDER BY u.last_active DESC LIMIT 20
    `).all(),
    db.prepare(`
      SELECT name, type, COUNT(DISTINCT user_id) as viewers
      FROM watch_history WHERE name IS NOT NULL
      GROUP BY name, type ORDER BY viewers DESC LIMIT 15
    `).all(),
    db.prepare("SELECT COALESCE(value,0) as v FROM usage_log WHERE date=? AND metric='cf_api_requests'").bind(today).first(),
    db.prepare("SELECT COALESCE(value,0) as v FROM usage_log WHERE date=? AND metric='cf_stream_requests'").bind(today).first(),
    db.prepare("SELECT date, metric, value FROM usage_log WHERE date >= ? ORDER BY date DESC").bind(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).all(),
    db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").first().catch(() => null),
  ]);

  const todayTotal = (todayApiReqs?.v || 0) + (todayStreamReqs?.v || 0);

  // Build daily breakdown from weekly usage
  const dailyBreakdown = {};
  for (const row of weeklyUsage.results) {
    if (!dailyBreakdown[row.date]) dailyBreakdown[row.date] = {};
    dailyBreakdown[row.date][row.metric] = row.value;
  }

  return jsonResponse({
    users: {
      total: totalUsers.count,
      active_1h: activeH1.count,
      active_24h: activeH24.count,
      active_7d: activeD7.count,
      active_30d: activeD30.count,
    },
    connections: { total: totalConnections.count, by_type: connectionsByType.results },
    content: { total: totalContent.count, by_type: contentByType.results },
    favorites: totalFavorites.count,
    history: totalHistory.count,
    usage: {
      today: {
        api_requests: todayApiReqs?.v || 0,
        stream_requests: todayStreamReqs?.v || 0,
        total_requests: todayTotal,
      },
      limits: FREE_TIER,
      pct_requests: Math.round((todayTotal / FREE_TIER.cf_requests_day) * 100),
      d1_storage_mb: dbSize?.size ? Math.round(dbSize.size / 1024 / 1024 * 100) / 100 : null,
      daily: dailyBreakdown,
    },
    recent_users: recentUsers.results.map(u => ({
      id: u.id.slice(0, 8) + "...",
      created: u.created_at ? new Date(u.created_at * 1000).toISOString() : null,
      last_active: u.last_active ? new Date(u.last_active * 1000).toISOString() : null,
      connections: u.connections,
      favorites: u.favorites,
      history_items: u.history_items,
    })),
    top_content: topContent.results,
    generated_at: new Date().toISOString(),
  });
}

export function handleDashboardHTML() {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StreamVault Analytics</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#07070f;color:#dde0f5;font-family:'Segoe UI',system-ui,sans-serif;padding:2rem}
h1{font-size:1.6rem;margin-bottom:.3rem;background:linear-gradient(135deg,#00d4ff,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#8080aa;font-size:.82rem;margin-bottom:2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;margin-bottom:2rem}
.card{background:#0f0f1c;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:1.2rem}
.card-label{font-size:.7rem;color:#8080aa;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.4rem}
.card-value{font-size:1.8rem;font-weight:700;color:#00d4ff}
.card-value.green{color:#00e896}.card-value.orange{color:#ff6b35}.card-value.purple{color:#a78bfa}.card-value.red{color:#ff4466}.card-value.yellow{color:#fbbf24}
.section{margin-bottom:2rem}
.section-title{font-size:1rem;font-weight:600;margin-bottom:.8rem;color:#dde0f5;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:.4rem}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{text-align:left;color:#8080aa;font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;padding:.5rem .6rem;border-bottom:1px solid rgba(255,255,255,0.1)}
td{padding:.5rem .6rem;border-bottom:1px solid rgba(255,255,255,0.04);color:#dde0f5}
tr:hover td{background:rgba(255,255,255,0.02)}
.tag{display:inline-block;padding:.15rem .4rem;border-radius:4px;font-size:.65rem;font-weight:600;text-transform:uppercase}
.tag-xtream{background:#00d4ff22;color:#00d4ff}.tag-stalker{background:#ff6b3522;color:#ff6b35}.tag-m3u{background:#00e89622;color:#00e896}
.tag-live{background:#ff2d5522;color:#ff2d55}.tag-vod{background:#a78bfa22;color:#a78bfa}.tag-series{background:#fbbf2422;color:#fbbf24}
.loading{text-align:center;padding:3rem;color:#8080aa}
.err{color:#ff4466;padding:1rem;background:#ff446612;border-radius:8px;margin:1rem 0}
.refresh{background:#0f0f1c;border:1px solid rgba(255,255,255,0.1);color:#00d4ff;padding:.4rem .8rem;border-radius:6px;cursor:pointer;font-size:.75rem;float:right}
.refresh:hover{background:#16162a}
.bar{height:8px;background:#16162a;border-radius:4px;overflow:hidden;margin-top:.4rem}
.bar-fill{height:100%;border-radius:4px;transition:width .3s}
.warn{background:#ff6b3518;border:1px solid #ff6b3530;border-radius:8px;padding:.8rem 1rem;margin-bottom:1.5rem;font-size:.82rem;color:#ff6b35;display:none}
.warn.show{display:block}
.crit{background:#ff446618;border:1px solid #ff446630;color:#ff4466}
.limit-row{display:flex;align-items:center;gap:.8rem;padding:.5rem 0}
.limit-label{font-size:.78rem;color:#8080aa;min-width:140px}
.limit-bar{flex:1;height:8px;background:#16162a;border-radius:4px;overflow:hidden}
.limit-fill{height:100%;border-radius:4px;transition:width .3s}
.limit-pct{font-size:.75rem;font-weight:600;min-width:45px;text-align:right}
.chart{display:flex;align-items:flex-end;gap:3px;height:60px;margin-top:.5rem}
.chart-bar{flex:1;background:#00d4ff;border-radius:2px 2px 0 0;min-width:8px;position:relative}
.chart-bar:hover::after{content:attr(data-tip);position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#0f0f1c;border:1px solid rgba(255,255,255,0.1);padding:.2rem .4rem;border-radius:4px;font-size:.6rem;white-space:nowrap;color:#dde0f5}
.chart-labels{display:flex;gap:3px;margin-top:.3rem}
.chart-labels span{flex:1;text-align:center;font-size:.55rem;color:#44445a;min-width:8px}
</style>
</head><body>
<button class="refresh" onclick="load()">Refresh</button>
<h1>STREAMVAULT</h1>
<div class="sub">Analytics Dashboard</div>
<div id="app"><div class="loading">Loading analytics...</div></div>
<script>
function tag(t){return'<span class="tag tag-'+t+'">'+t+'</span>'}
function ago(iso){if(!iso)return'\\u2014';const d=Date.now()-new Date(iso).getTime();const m=Math.floor(d/60000);if(m<1)return'just now';if(m<60)return m+'m ago';const h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago'}
function pct(n,t){return t?Math.round(n/t*100):0}
function barColor(p){return p>=90?'#ff4466':p>=70?'#ff6b35':p>=50?'#fbbf24':'#00e896'}
function fmt(n){return n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':n.toString()}

async function load(){
  const app=document.getElementById('app');
  app.innerHTML='<div class="loading">Loading...</div>';
  try{
    const r=await fetch('/api/analytics');
    const d=await r.json();
    if(d.error){app.innerHTML='<div class="err">'+d.error+'</div>';return}
    const u=d.usage;
    let h='';

    // Warnings
    if(u.pct_requests>=80){
      h+='<div class="warn '+(u.pct_requests>=95?'crit':'')+' show">\\u26A0 CF Workers at <b>'+u.pct_requests+'%</b> of daily request limit ('+fmt(u.today.total_requests)+' / '+fmt(u.limits.cf_requests_day)+'). '+(u.pct_requests>=95?'CRITICAL: App will stop working when limit is reached!':'Consider reducing streaming through CF Worker.')+'</div>';
    }

    // Usage limits section
    h+='<div class="section"><div class="section-title">Free Tier Usage</div>';
    const limits=[
      {label:'CF Requests/Day',val:u.today.total_requests,max:u.limits.cf_requests_day},
      {label:'D1 Storage',val:u.d1_storage_mb||0,max:u.limits.cf_d1_storage_gb*1024,unit:'MB',maxUnit:u.limits.cf_d1_storage_gb+'GB'},
    ];
    limits.forEach(l=>{
      const p=pct(l.val,l.max);
      h+='<div class="limit-row"><span class="limit-label">'+l.label+'</span>';
      h+='<div class="limit-bar"><div class="limit-fill" style="width:'+Math.min(100,p)+'%;background:'+barColor(p)+'"></div></div>';
      h+='<span class="limit-pct" style="color:'+barColor(p)+'">'+(l.unit?l.val+l.unit:fmt(l.val))+' / '+(l.maxUnit||fmt(l.max))+'</span></div>';
    });
    // Request breakdown
    h+='<div style="margin-top:.8rem;display:flex;gap:1.5rem;font-size:.78rem;color:#8080aa">';
    h+='<span>API: <b style="color:#00d4ff">'+fmt(u.today.api_requests)+'</b></span>';
    h+='<span>Stream: <b style="color:#ff6b35">'+fmt(u.today.stream_requests)+'</b></span>';
    h+='</div>';

    // 7-day chart
    const days=Object.keys(u.daily).sort();
    if(days.length>0){
      const maxDay=Math.max(...days.map(d=>(u.daily[d].cf_api_requests||0)+(u.daily[d].cf_stream_requests||0)),1);
      h+='<div style="margin-top:1rem"><div style="font-size:.72rem;color:#8080aa;margin-bottom:.3rem">Last 7 Days (requests)</div>';
      h+='<div class="chart">';
      days.forEach(day=>{
        const api=u.daily[day].cf_api_requests||0;
        const stream=u.daily[day].cf_stream_requests||0;
        const total=api+stream;
        const hp=Math.max(2,Math.round(total/maxDay*100));
        h+='<div class="chart-bar" style="height:'+hp+'%;background:linear-gradient(to top,#00d4ff,#7c3aed)" data-tip="'+day+': '+fmt(total)+' (API:'+fmt(api)+', Stream:'+fmt(stream)+')"></div>';
      });
      h+='</div><div class="chart-labels">';
      days.forEach(day=>{h+='<span>'+day.slice(5)+'</span>'});
      h+='</div></div>';
    }
    h+='</div>';

    // User stats
    h+='<div class="grid">';
    h+='<div class="card"><div class="card-label">Total Users</div><div class="card-value">'+d.users.total+'</div></div>';
    h+='<div class="card"><div class="card-label">Active (1h)</div><div class="card-value green">'+d.users.active_1h+'</div></div>';
    h+='<div class="card"><div class="card-label">Active (24h)</div><div class="card-value green">'+d.users.active_24h+'</div></div>';
    h+='<div class="card"><div class="card-label">Active (7d)</div><div class="card-value">'+d.users.active_7d+'</div></div>';
    h+='<div class="card"><div class="card-label">Active (30d)</div><div class="card-value">'+d.users.active_30d+'</div></div>';
    h+='<div class="card"><div class="card-label">Connections</div><div class="card-value orange">'+d.connections.total+'</div></div>';
    h+='<div class="card"><div class="card-label">Content Items</div><div class="card-value purple">'+d.content.total.toLocaleString()+'</div></div>';
    h+='<div class="card"><div class="card-label">Favorites</div><div class="card-value">'+d.favorites+'</div></div>';
    h+='<div class="card"><div class="card-label">History</div><div class="card-value">'+d.history+'</div></div>';
    h+='</div>';

    // Connections by type
    if(d.connections.by_type.length){
      h+='<div class="section"><div class="section-title">Connections by Type</div><div class="grid">';
      d.connections.by_type.forEach(c=>{
        const p=pct(c.count,d.connections.total);
        h+='<div class="card"><div class="card-label">'+tag(c.type)+'</div><div class="card-value">'+c.count+'</div><div class="bar"><div class="bar-fill" style="width:'+p+'%;background:#00d4ff"></div></div></div>';
      });
      h+='</div></div>';
    }

    // Content by type
    if(d.content.by_type.length){
      h+='<div class="section"><div class="section-title">Content by Type</div><div class="grid">';
      d.content.by_type.forEach(c=>{
        h+='<div class="card"><div class="card-label">'+tag(c.type)+'</div><div class="card-value">'+c.count.toLocaleString()+'</div></div>';
      });
      h+='</div></div>';
    }

    // Recent users
    if(d.recent_users.length){
      h+='<div class="section"><div class="section-title">Recent Users</div>';
      h+='<table><tr><th>Guest ID</th><th>Created</th><th>Last Active</th><th>Conn</th><th>Favs</th><th>History</th></tr>';
      d.recent_users.forEach(u=>{
        h+='<tr><td><code>'+u.id+'</code></td><td>'+ago(u.created)+'</td><td>'+ago(u.last_active)+'</td><td>'+u.connections+'</td><td>'+u.favorites+'</td><td>'+u.history_items+'</td></tr>';
      });
      h+='</table></div>';
    }

    // Top content
    if(d.top_content.length){
      h+='<div class="section"><div class="section-title">Most Watched</div>';
      h+='<table><tr><th>Title</th><th>Type</th><th>Viewers</th></tr>';
      d.top_content.forEach(c=>{
        h+='<tr><td>'+c.name+'</td><td>'+tag(c.type)+'</td><td>'+c.viewers+'</td></tr>';
      });
      h+='</table></div>';
    }

    h+='<div class="sub" style="margin-top:2rem">Generated: '+new Date(d.generated_at).toLocaleString()+'</div>';
    app.innerHTML=h;
  }catch(e){app.innerHTML='<div class="err">Failed to load: '+e.message+'</div>'}
}
load();setInterval(load,60000);
</script>
</body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
