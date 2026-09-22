const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

function send(res, status, data, type='application/json'){
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}
function cleanUrl(u){
  try {
    const x = new URL(String(u));
    if (!/(^|\.)tiktok\.com$/i.test(x.hostname) && !/tiktok\.com$/i.test(x.hostname)) throw new Error('Not a TikTok URL');
    return x.href;
  } catch(e){ throw new Error('Invalid TikTok URL'); }
}
function first(...v){ return v.find(x => x !== undefined && x !== null && x !== '' && x !== 0); }
function num(v){ const n=Number(v); return Number.isFinite(n) ? n : 0; }
function deepObjects(x, out=[], seen=new Set()){
  if(!x || typeof x!=='object' || seen.has(x) || out.length>30000) return out;
  seen.add(x); out.push(x);
  if(Array.isArray(x)){ for(const v of x) deepObjects(v,out,seen); }
  else for(const v of Object.values(x)) deepObjects(v,out,seen);
  return out;
}
function findVideo(root, id){
  const all=deepObjects(root);
  let best=null;
  for(const o of all){
    if(!o || typeof o!=='object') continue;
    if(id && String(first(o.id,o.aweme_id,o.video_id,''))===String(id) && o.video) return o;
    if(o.video && typeof o.video==='object' && (!best || o.video.playAddr || o.video.play_addr)) best=o;
    if(id && String(first(o.aweme_id,o.id,''))===String(id)) best=o;
  }
  return best;
}
function parseScripts(html){
  const roots=[];
  const re=/<script[^>]*?(?:id=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while((m=re.exec(html))){
    const id=(m[1]||'').toLowerCase(), txt=m[2].trim();
    if(!txt || (!id.includes('sigi') && !id.includes('universal') && !id.includes('rehydration') && !txt.includes('ItemModule') && !txt.includes('itemStruct'))) continue;
    try { roots.push(JSON.parse(txt)); } catch(_){}
  }
  return roots;
}
function pickVariant(video){
  const lists=[];
  for(const k of ['bitrateInfo','bit_rate_info','bitrate_info','bitRateInfo']){
    if(Array.isArray(video?.[k])) lists.push(...video[k]);
  }
  if(!lists.length && video) {
    for(const o of deepObjects(video)) {
      if(Array.isArray(o?.bitrateInfo)) lists.push(...o.bitrateInfo);
      if(Array.isArray(o?.bit_rate_info)) lists.push(...o.bit_rate_info);
    }
  }
  const v=lists.find(x=>x && (x.PlayAddr||x.playAddr||x.play_addr)) || lists[0];
  if(!v) return null;
  const p=v.PlayAddr||v.playAddr||v.play_addr||{};
  const urls=p.UrlList||p.url_list||p.urlList||v.UrlList||v.url_list||v.urlList||[];
  return {
    quality:first(v.GearName,v.gear_name,v.qualityType,v.quality_type,p.QualityType,p.quality_type,v.urlKey,v.url_key),
    codec:first(v.CodecType,v.codecType,v.codec_type,p.CodecType,p.codec_type),
    bitrate:first(v.Bitrate,v.bit_rate,v.bitRate,p.Bitrate,p.bit_rate,p.bitRate),
    size:first(v.DataSize,v.data_size,v.dataSize,p.DataSize,p.data_size,p.dataSize),
    width:first(v.Width,v.width,p.Width,p.width),
    height:first(v.Height,v.height,p.Height,p.height),
    url:urls[0] || p.Url || p.url || v.Url || v.url || ''
  };
}
function extract(html, requestedUrl, oembed){
  const id=(requestedUrl.match(/\/video\/(\d+)/i)||[])[1]||'';
  const roots=parseScripts(html);
  let item=null, video=null, stats=null, author=null, music=null;
  for(const root of roots){
    const cand=findVideo(root,id);
    if(cand){ item=cand; video=cand.video||cand; stats=cand.stats||cand.statistics||{}; author=cand.author||cand.authorInfo||{}; music=cand.music||{}; break; }
  }
  // generic fallback: locate objects by ID and video-like object
  if(!item){
    for(const root of roots){
      for(const o of deepObjects(root)){
        if(o && typeof o==='object' && id && String(first(o.id,o.aweme_id,o.video_id,''))===id){
          item=o; video=o.video||{}; stats=o.stats||o.statistics||{}; author=o.author||{}; music=o.music||{}; break;
        }
      }
      if(item) break;
    }
  }
  const variant=pickVariant(video||{});
  const width=num(first(video?.width,variant?.width,item?.video?.width));
  const height=num(first(video?.height,variant?.height,item?.video?.height));
  const play=first(video?.playAddr,video?.play_addr,video?.downloadAddr,video?.download_addr,variant?.url);
  const result={
    ok:true,
    id:first(item?.id,item?.aweme_id,id),
    author:first(author?.uniqueId,author?.unique_id,author?.nickname,oembed?.author_name),
    nickname:first(author?.nickname,oembed?.author_name),
    caption:first(item?.desc,item?.description,oembed?.title,''),
    createTime:num(first(item?.createTime,item?.create_time)),
    duration:num(first(video?.duration, item?.duration)),
    cover:first(video?.cover,video?.coverUrl,video?.cover_url,oembed?.thumbnail_url),
    music:first(music?.title,music?.musicName,music?.music_name),
    stats:{
      views:num(first(stats?.playCount,stats?.play_count,stats?.viewCount,stats?.view_count)),
      likes:num(first(stats?.diggCount,stats?.digg_count,stats?.likeCount,stats?.like_count)),
      comments:num(first(stats?.commentCount,stats?.comment_count)),
      favorites:num(first(stats?.collectCount,stats?.collect_count,stats?.favoriteCount,stats?.favorite_count)),
      shares:num(first(stats?.shareCount,stats?.share_count)),
      downloads:num(first(stats?.downloadCount,stats?.download_count))
    },
    width, height,
    original: width&&height ? `${width}x${height}` : '',
    aspect: width&&height ? (width/height).toFixed(3) : '',
    codec:variant?.codec || '',
    bitrate:num(variant?.bitrate),
    size:num(variant?.size),
    browserQuality:variant?.quality || '',
    phoneQuality:variant?.quality || '',
    playUrl:play || variant?.url || '',
    vq:first(video?.VQScore,video?.vq_score,variant?.VQScore,variant?.vq_score),
    source:first(item?.source,video?.source),
    region:first(item?.region, item?.regionCode, item?.region_code),
    shadowban:first(item?.shadowBan,item?.shadow_ban)
  };
  return result;
}
async function fetchText(url, headers={}){
  const r=await fetch(url,{redirect:'follow',headers});
  const text=await r.text();
  return {r,text};
}
async function probeMedia(url){
  if(!url) return {};
  try{
    const h=await fetch(url,{redirect:'follow',headers:{Range:'bytes=0-2097151','User-Agent':'Mozilla/5.0'}});
    const sizeH=h.headers.get('content-range')||'';
    const m=sizeH.match(/\/(\d+)$/);
    const total=m?Number(m[1]):Number(h.headers.get('content-length')||0);
    const type=h.headers.get('content-type')||'';
    return {size:total||0,contentType:type};
  }catch(_){return {};}
}
async function analyze(url){
  const u=cleanUrl(url);
  const oeUrl='https://www.tiktok.com/oembed?url='+encodeURIComponent(u);
  let oembed={};
  try{ const oe=await fetchText(oeUrl,{'User-Agent':'Mozilla/5.0'}); if(oe.r.ok) oembed=JSON.parse(oe.text); }catch(_){}
  const page=await fetchText(u,{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36','Accept-Language':'en-US,en;q=0.9'});
  if(!page.r.ok) throw new Error(`TikTok page returned HTTP ${page.r.status}`);
  const d=extract(page.text,u,oembed);
  if(d.playUrl){
    const p=await probeMedia(d.playUrl);
    if(!d.size && p.size) d.size=p.size;
    d.mediaContentType=p.contentType||'';
  }
  d.source = d.source || '';
  d.region = d.region || '';
  d.shadowban = d.shadowban ?? '';
  return d;
}
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS') return send(res,204,'');
  try{
    if(req.url==='/health') return send(res,200,{ok:true,service:'cazper-analyzer'});
    if(req.method==='POST' && req.url==='/api/analyze'){
      let body=''; for await(const c of req) body+=c;
      const data=JSON.parse(body||'{}');
      const result=await analyze(data.url);
      return send(res,200,result);
    }
    return send(res,404,{ok:false,error:'Not found'});
  }catch(e){ return send(res,400,{ok:false,error:e.message||'Analysis failed'}); }
});
server.listen(PORT,HOST,()=>console.log(`CAZPER Analyzer backend: http://${HOST}:${PORT}`));
