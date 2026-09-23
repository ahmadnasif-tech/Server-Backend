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
    const txt=m[2].trim(); if(!txt) continue;
    try { roots.push(JSON.parse(txt)); } catch(_){
      try {
        const decoded=txt.replace(/\\u([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16))).replace(/\\"/g,'"');
        if(decoded!==txt && /^\s*[\[{]/.test(decoded)) roots.push(JSON.parse(decoded));
      } catch(__){}
    }
  }
  return roots;
}
function rawNumberCandidates(html, keys){
  const t=String(html||''), out=[];
  for(const key of keys){
    const re=new RegExp('["\\\\]'+key+'["\\\\]\\s*[:=]\\s*["\\\\]?(\\d{1,4})','gi');
    let m; while((m=re.exec(t))) { const n=Number(m[1]); if(Number.isFinite(n)&&n>0&&n<=240) out.push(n); }
  }
  return out;
}
function modeNumber(values){
  if(!values.length)return 0; const c=new Map(); for(const n of values)c.set(n,(c.get(n)||0)+1);
  return [...c.entries()].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0][0];
}
function rawRegionCandidate(html){
  const t=String(html||'');
  for(const key of ['region_code','regionCode','authorRegion','author_region','countryCode','country_code','registeredCountry','registered_country','creatorRegion','creator_region']){
    const re=new RegExp('["\\\\]'+key+'["\\\\]\\s*[:=]\\s*["\\\\]([^"\\\\]{1,80})','i');
    const m=t.match(re); if(m){const r=normalizePublicRegion(m[1]); if(r)return r;}
  }
  return '';
}
function collectVariants(video){
  const out=[],seen=new Set();
  const keys=[
    'bitrateInfo','bit_rate','bitRate','bit_rate_info','bitrate_info','bitRateInfo',
    'playAddr','play_addr','downloadAddr','download_addr',
    'playAddrH264','play_addr_h264','downloadAddrH264','download_addr_h264',
    'playAddrBytevc1','play_addr_bytevc1','downloadAddrBytevc1','download_addr_bytevc1',
    'playAddrBytevc2','play_addr_bytevc2','downloadAddrBytevc2','download_addr_bytevc2',
    'playAddrH265','play_addr_h265','downloadAddrH265','download_addr_h265',
    'playAddrH264HD','play_addr_h264_hd','downloadAddrH264HD','download_addr_h264_hd',
    'playAddrH265HD','play_addr_h265_hd','downloadAddrH265HD','download_addr_h265_hd'
  ];
  const num=(...xs)=>{for(const x of xs){const n=Number(x);if(Number.isFinite(n)&&n>0)return n}return 0};
  const mediaUrl=x=>{
    if(typeof x==='string')return x;
    if(!x||typeof x!=='object')return '';
    for(const k of ['UrlList','urlList','url_list','url','uri','Url','download_url','downloadUrl']){
      const a=x[k];
      if(Array.isArray(a)){const u=a.find(v=>typeof v==='string'&&/^https?:/i.test(v));if(u)return String(u)}
      if(typeof a==='string'&&/^https?:/i.test(a))return a;
    }
    return '';
  };
  const add=(x,keyHint)=>{
    if(!x)return;
    const o=typeof x==='object'?x:{value:x};
    const p=o.PlayAddr||o.playAddr||o.play_addr||o.DownloadAddr||o.downloadAddr||o.download_addr||{};
    const url=mediaUrl(x)||mediaUrl(p);
    if(!url||!/^https?:/i.test(url))return;
    const q=o.GearName||o.gearName||o.gear_name||o.QualityType||o.qualityType||o.quality_type||
      p.GearName||p.gearName||p.gear_name||p.QualityType||p.qualityType||keyHint||'';
    const codec=o.CodecType||o.codecType||o.codec_type||o.codec||p.CodecType||p.codecType||p.codec_type||'';
    const width=num(o.Width,o.width,p.Width,p.width,o.VideoWidth,o.video_width,p.VideoWidth,p.video_width);
    const height=num(o.Height,o.height,p.Height,p.height,o.VideoHeight,o.video_height,p.VideoHeight,p.video_height);
    const bitrate=num(o.Bitrate,o.bit_rate,o.bitRate,o.bitrate,p.Bitrate,p.bit_rate,p.bitRate,p.bitrate);
    const size=num(o.DataSize,o.data_size,o.dataSize,p.DataSize,p.data_size,p.DataSize,p.size);
    const fps=num(o.FPS,o.Fps,o.fps,o.FrameRate,o.frameRate,o.frame_rate,p.FPS,p.Fps,p.fps,p.FrameRate,p.frameRate,p.frame_rate);
    const name=String(q||keyHint||'video stream');
    const id=url+'|'+name+'|'+width+'x'+height+'|'+codec;
    if(seen.has(id))return;
    seen.add(id);
    out.push({name,quality:String(q||''),codec:String(codec||''),bitrate,size,width,height,fps,url,sourceKey:String(keyHint||'')});
  };
  const walk=(x,d=0)=>{
    if(!x||typeof x!=='object'||d>18)return;
    if(Array.isArray(x)){x.forEach(v=>walk(v,d+1));return}
    for(const [k,v] of Object.entries(x)){
      if(keys.includes(k)){
        if(Array.isArray(v))v.forEach(x=>add(x,k));else add(v,k);
      }
      if(v&&typeof v==='object')walk(v,d+1);
    }
  };
  walk(video);
  return out;
}
function variantQuality(v, fallbackFps=0){
  if(!v) return '';
  const q=String(v.quality||v.name||'');
  const m=q.match(/(?:^|_)(\d{3,4})(?:_|p|$)/i);
  const w=num(v.width), h=num(v.height);
  const base=num(m?.[1]) || (w&&h ? Math.min(w,h) : 0) || (w||h);
  if(!base) return q;
  const f=num(v.fps)||num(fallbackFps);
  return f>0 ? `${base}p${Math.round(f)}` : `${base}p`;
}
function pickVariant(video){
  const variants=collectVariants(video);
  if(!variants.length) return null;
  // Prefer the highest-resolution stream; bitrate is only a tie-breaker.
  return variants.slice().sort((a,b)=>{
    const ar=(a.width||0)*(a.height||0), br=(b.width||0)*(b.height||0);
    return (br-ar)||((b.bitrate||0)-(a.bitrate||0));
  })[0];
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
  const variants=collectVariants(video||{});
  const variant=pickVariant(video||{});
  const width=num(first(video?.width,variant?.width,item?.video?.width));
  const height=num(first(video?.height,variant?.height,item?.video?.height));
  const play=first(video?.playAddr,video?.play_addr,video?.downloadAddr,video?.download_addr,variant?.url);
  const sourceRegion=first(
    item?.region,item?.regionCode,item?.region_code,
    item?.authorRegion,item?.author_region,item?.countryCode,item?.country_code,
    video?.region,video?.regionCode,video?.region_code,
    author?.region,author?.regionCode,author?.region_code,
    author?.countryCode,author?.country_code
  );
  // Only use an explicitly exposed region/country field. Never infer it from
  // the viewer's location, language, timezone, or CDN hostname.
  const variantFps=num(first(video?.fps,video?.frameRate,video?.frame_rate,variant?.fps));
  const normalizedVariants=variants.map(v=>({
    ...v,
    displayQuality:variantQuality(v,variantFps)
  })).filter(v=>v.url||v.width||v.height||v.quality);
  const bestQuality=normalizedVariants.slice().sort((a,b)=>{
    const ar=(a.width||0)*(a.height||0), br=(b.width||0)*(b.height||0);
    return (br-ar)||((b.bitrate||0)-(a.bitrate||0));
  })[0]||null;
  const result={
    ok:true,
    id:first(item?.id,item?.aweme_id,id),
    author:first(author?.uniqueId,author?.unique_id,author?.nickname,oembed?.author_name),
    username:first(author?.uniqueId,author?.unique_id,''),
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
      downloads:first(stats?.downloadCount,stats?.download_count)
    },
    width, height,
    original: width&&height ? `${width}x${height}` : '',
    aspect: width&&height ? (width/height).toFixed(3) : '',
    codec:variant?.codec || '',
    bitrate:num(variant?.bitrate),
    size:num(variant?.size),
    browserQuality:bestQuality?.displayQuality || variantQuality(variant,variantFps) || '',
    phoneQuality:bestQuality?.displayQuality || variantQuality(variant,variantFps) || '',
    variants:normalizedVariants,
    playUrl:play || variant?.url || '',
    vq:first(video?.VQScore,video?.vq_score,variant?.VQScore,variant?.vq_score),
    fps:variantFps,
    source:first(item?.source,video?.source),
    region:sourceRegion,
    shadowban:first(item?.shadowBan,item?.shadow_ban)
  };
  return result;
}
function assessPublicRestrictionSignal(d, pageStatus, oembedOk){
  // TikTok does not publish an official public "shadow ban" flag.
  // UI uses Yes/No only when a concrete public signal can support it.
  // "No" means no public-access restriction signal was detected; it is
  // NOT an official statement about TikTok's recommendation/moderation systems.
  const explicit=d.shadowban;
  if(typeof explicit==='boolean'){
    return {
      status:explicit?'Yes':'No',
      basis:'Explicit boolean field found in the public response; not an official TikTok shadow-ban verdict'
    };
  }
  if(typeof explicit==='string'){
    const e=explicit.trim().toLowerCase();
    if(['true','yes','shadow_banned','shadow-ban','shadow ban'].includes(e)){
      return {status:'Yes',basis:'Explicit public response signal; not an official TikTok shadow-ban verdict'};
    }
    if(['false','no','not_shadow_banned'].includes(e)){
      return {status:'No',basis:'Explicit public response signal; not an official TikTok shadow-ban verdict'};
    }
  }
  const hasId=!!d.id;
  const hasStats=Object.values(d.stats||{}).some(v=>Number(v)>0);
  const hasPlayback=!!d.playUrl;
  if(pageStatus===200 && hasId && (hasPlayback || hasStats || oembedOk)){
    return {
      status:'No',
      basis:'Public video page, metadata and/or playback stream are accessible; no public restriction signal detected. This is not an official TikTok shadow-ban verdict'
    };
  }
  return {
    status:'Inconclusive',
    basis:'Insufficient public evidence to classify the video as No or Yes'
  };
}

async function fetchText(url, headers={}){
  const r=await fetch(url,{redirect:'follow',headers});
  const text=await r.text();
  return {r,text};
}
function u32(b,o){return o+4<=b.length?((b[o]*0x1000000)+(b[o+1]<<16)+(b[o+2]<<8)+b[o+3]):0}
function ascii(b,o,n){let s='';for(let i=o;i<Math.min(b.length,o+n);i++){const c=b[i];s+=c>=32&&c<=126?String.fromCharCode(c):'\0'}return s}
function parseMp4Technical(buf){
  const b=new Uint8Array(buf), out={codec:'',fps:0,width:0,height:0,bitrate:0};
  const codecs={avc1:'H.264/AVC',avc3:'H.264/AVC',hvc1:'H.265/HEVC',hev1:'H.265/HEVC',av01:'AV1',vp09:'VP9'};
  function walk(st,en,ctx={}){
    let p=st;
    while(p+8<=en){
      let size=u32(b,p),type=ascii(b,p+4,4),head=8;
      if(size===1&&p+16<=en){size=Number((BigInt(u32(b,p+8))*4294967296n)+BigInt(u32(b,p+12)));head=16}
      if(size===0)size=en-p;
      if(size<8||p+size>en)break;
      const body=p+head,end=p+size;
      if(codecs[type]&&!out.codec)out.codec=codecs[type];
      if(type==='tkhd'&&body+84<=end){const ver=b[body],wo=ver===1?body+88:body+76,ho=ver===1?body+92:body+80;const w=u32(b,wo)/65536,h=u32(b,ho)/65536;if(w>0&&h>0&&w<10000&&h<10000){out.width=Math.round(w);out.height=Math.round(h)}}
      if(['avc1','avc3','hvc1','hev1','av01','vp09','mp4v'].includes(type)&&body+28<=end){const w=(b[body+24]<<8)|b[body+25],h=(b[body+26]<<8)|b[body+27];if(w&&h){out.width=w;out.height=h}}
      if(type==='btrt'&&body+12<=end)out.bitrate=out.bitrate||u32(b,body+8)||u32(b,body+4);
      let nctx={...ctx};
      if(type==='trak'){const probe=ascii(b,body,Math.min(8192,end-body));if(/hdlr[\s\S]{4,12}vide/.test(probe))nctx.isVideo=true;const md=probe.indexOf('mdhd');if(md>=0){const mdAbs=body+md,mdBody=mdAbs+8,ver=b[mdBody],ts=ver===1?u32(b,mdBody+20):u32(b,mdBody+8);if(ts)nctx.timescale=ts;}}
      if(type==='hdlr'&&body+12<=end)nctx.isVideo=ascii(b,body+8,4)==='vide';
      if(type==='mdhd'&&nctx.isVideo){const ver=b[body],ts=ver===1?u32(b,body+20):u32(b,body+8);if(ts)nctx.timescale=ts}
      if(type==='stts'&&nctx.isVideo&&body+8<=end&&nctx.timescale){const count=u32(b,body+4);let q=body+8,samp=0,ticks=0;for(let i=0;i<count&&q+8<=end;i++,q+=8){const c=u32(b,q),d=u32(b,q+4);samp+=c;ticks+=c*d}if(samp&&ticks){const fps=samp/(ticks/nctx.timescale);if(fps>1&&fps<240)out.fps=out.fps||fps}}
      const containers=new Set(['moov','trak','mdia','minf','stbl','stsd','edts','dinf','mvex','moof','traf','mfra','meta','udta','ilst','avc1','avc3','hvc1','hev1','av01','vp09','mp4v']);
      if(containers.has(type)){let child=body;if(type==='meta')child+=4;if(type==='stsd')child+=8;if(['avc1','avc3','hvc1','hev1','av01','vp09','mp4v'].includes(type))child+=78;if(child<end)walk(child,end,nctx)}
      p+=size;
    }
  }
  walk(0,b.length,{}); return out;
}
async function probeMedia(url, rangeStart=0, rangeEnd=null){
  if(!url)return {};
  try{
    const headers={'User-Agent':'Mozilla/5.0','Accept':'video/mp4,video/*;q=0.9,*/*;q=0.8'};
    if(Number.isFinite(rangeStart) && rangeStart>=0){
      headers.Range = rangeEnd!==null && Number.isFinite(rangeEnd)
        ? `bytes=${rangeStart}-${Math.max(rangeStart,rangeEnd)}`
        : `bytes=${rangeStart}-${rangeStart+1048575}`;
    }
    const h=await fetch(url,{redirect:'follow',headers});
    const cr=h.headers.get('content-range')||'', m=cr.match(/\/(\d+)$/);
    const total=m?Number(m[1]):Number(h.headers.get('content-length')||0);
    const ab=await h.arrayBuffer();
    const technical=parseMp4Technical(ab);
    return {size:total||0,contentType:h.headers.get('content-type')||'',technical,contentRange:cr,finalUrl:h.url||url};
  }catch(_){return {}}
}
async function probeMediaDeep(url){
  if(!url)return {};
  const head=await probeMedia(url,0,1048575);
  let best={...head};
  const total=Number(head.size||0)||0;
  if(total>1048576){
    const tail=await probeMedia(url,Math.max(0,total-4194304),total-1);
    for(const k of ['codec','fps','width','height','bitrate']){
      if(!best.technical?.[k] && tail.technical?.[k]){
        best.technical=best.technical||{}; best.technical[k]=tail.technical[k];
      }
    }
    best.size=best.size||tail.size||total;
  }
  return best;
}
function findDeepValue(root, keys){
  const wanted=new Set(keys.map(String));
  for(const o of deepObjects(root)){
    if(!o||typeof o!=='object')continue;
    for(const k of wanted){
      if(Object.prototype.hasOwnProperty.call(o,k)){
        const v=o[k];
        if(v!==undefined&&v!==null&&v!==''&&v!==0)return v;
      }
    }
  }
  return '';
}
function detectPrivatePage(html, oembed, item, pageStatus){
  if(item?.id)return false;
  const t=String(html||'').toLowerCase();
  const signals=[
    'this video is private','video is private','this video is unavailable','video unavailable',
    'this post is private','post is private','only me','private video','content is unavailable',
    'video has been removed','video was removed','couldn\'t find this video','could not find this video'
  ];
  return pageStatus===200 && (signals.some(x=>t.includes(x)) || !Object.keys(oembed||{}).length && /private|unavailable|removed/.test(t));
}

const RESEARCH_FIELDS='id,create_time,username,region_code,video_description,music_id,like_count,comment_count,share_count,view_count,favorites_count,video_duration,hashtag_names,video_label,video_tag';
let researchTokenCache={token:'',expiresAt:0};
async function getResearchAccessToken(){
  const direct=process.env.TIKTOK_RESEARCH_ACCESS_TOKEN||'';
  if(direct) return direct;
  const key=process.env.TIKTOK_CLIENT_KEY||'';
  const secret=process.env.TIKTOK_CLIENT_SECRET||'';
  if(!key||!secret) return '';
  if(researchTokenCache.token && researchTokenCache.expiresAt>Date.now()+60000) return researchTokenCache.token;
  try{
    const body=new URLSearchParams({client_key:key,client_secret:secret,grant_type:'client_credentials'});
    const r=await fetch('https://open.tiktokapis.com/v2/oauth/token/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    if(!r.ok)return '';
    const j=await r.json();
    if(!j?.access_token)return '';
    researchTokenCache={token:j.access_token,expiresAt:Date.now()+Math.max(60,Number(j.expires_in||7200)-60)*1000};
    return j.access_token;
  }catch(_){return ''}
}
function ymdUtc(epoch){
  const d=new Date(Number(epoch||0)*1000);
  if(!Number.isFinite(d.getTime()))return '';
  const y=d.getUTCFullYear(),m=String(d.getUTCMonth()+1).padStart(2,'0'),day=String(d.getUTCDate()).padStart(2,'0');
  return `${y}${m}${day}`;
}
async function researchVideoById(id, createTime){
  const token=await getResearchAccessToken();
  if(!token||!id)return null;
  const date=ymdUtc(createTime)||ymdUtc(Date.now()/1000);
  try{
    const r=await fetch('https://open.tiktokapis.com/v2/research/video/query/?fields='+encodeURIComponent(RESEARCH_FIELDS),{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({query:{and:[{operation:'EQ',field_name:'video_id',field_values:[String(id)]}]},max_count:20,start_date:date,end_date:date})
    });
    const j=await r.json();
    if(!r.ok||j?.error?.code)return null;
    const list=j?.data?.videos||[];
    return list.find(v=>String(v.id)===String(id))||null;
  }catch(_){return null}
}


function collectRawMediaUrls(html){
  const out=[],seen=new Set();
  const text=String(html||'');
  const re=/(https?:\\?\/\\?\/(?:[^"'\\\s]|\\.){20,}?)(?=["'\\\s])/gi;
  let m;
  while((m=re.exec(text))){
    let u=String(m[1]).replace(/\\u002F/gi,'/').replace(/\\\//g,'/').replace(/\\u0026/gi,'&');
    if(!/^https?:\/\//i.test(u))continue;
    if(!/(tiktokcdn|ibytedtos|muscdn|byteoversea|bytefcdn)/i.test(u))continue;
    if(!/\.(?:mp4|m3u8)(?:[?#]|$)/i.test(u) && !/[?&](?:mime_type|format|codec_type|video_id|vwidth|vheight)/i.test(u))continue;
    if(seen.has(u))continue;
    seen.add(u); out.push(u);
    if(out.length>=64)break;
  }
  return out;
}

function normalizePublicRegion(value){
  if(value===undefined||value===null)return '';
  const s=String(value).trim().toUpperCase().replace(/[._-]+/g,' ').replace(/\s+/g,' ');
  const map={LK:'LK',LKA:'LK','SRI LANKA':'LK',US:'US',USA:'US','UNITED STATES':'US',
    CA:'CA',CAN:'CA',CANADA:'CA',GB:'GB',GBR:'GB',UK:'GB','UNITED KINGDOM':'GB',
    IN:'IN',IND:'IN',INDIA:'IN',SG:'SG',SGP:'SG',SINGAPORE:'SG',MY:'MY',MYS:'MY',
    MALAYSIA:'MY',ID:'ID',IDN:'ID',INDONESIA:'ID',AU:'AU',AUS:'AU',AUSTRALIA:'AU',
    NZ:'NZ',NZL:'NZ','NEW ZEALAND':'NZ',DE:'DE',DEU:'DE',GERMANY:'DE',FR:'FR',
    FRA:'FR',FRANCE:'FR',JP:'JP',JPN:'JP',JAPAN:'JP',KR:'KR',KOR:'KR','SOUTH KOREA':'KR',
    BR:'BR',BRA:'BR',BRAZIL:'BR',PH:'PH',PHL:'PH',PHILIPPINES:'PH',TH:'TH',THA:'TH',
    THAILAND:'TH',VN:'VN',VNM:'VN',VIETNAM:'VN',ES:'ES',ESP:'ES',SPAIN:'ES',
    IT:'IT',ITA:'IT',ITALY:'IT',NL:'NL',NLD:'NL',NETHERLANDS:'NL',AE:'AE',ARE:'AE',
    'UNITED ARAB EMIRATES':'AE',SA:'SA',SAU:'SA','SAUDI ARABIA':'SA'};
  return map[s]||(/^[A-Z]{2}$/.test(s)?s:'');
}
function extractPublicRegion(root){
  if(!root)return '';
  // Only creator/account-region fields are accepted here. Generic `country`
  // fields are intentionally excluded because they can describe unrelated
  // metadata and would create false Region results.
  const keys=['region_code','regionCode','authorRegion','author_region','countryCode','country_code',
    'registeredCountry','registered_country','creatorRegion','creator_region'];
  for(const o of deepObjects(root)){
    if(!o||typeof o!=='object')continue;
    const authorish=!!(o.author||o.authorInfo||o.uniqueId||o.unique_id||o.nickname||o.creator);
    if(!authorish)continue;
    for(const k of keys){ if(Object.prototype.hasOwnProperty.call(o,k)){const r=normalizePublicRegion(o[k]);if(r)return r;} }
    if(Object.prototype.hasOwnProperty.call(o,'region')){const r=normalizePublicRegion(o.region);if(r)return r;}
  }
  for(const o of deepObjects(root)){
    if(!o||typeof o!=='object')continue;
    for(const k of keys){ if(Object.prototype.hasOwnProperty.call(o,k)){const r=normalizePublicRegion(o[k]);if(r)return r;} }
  }
  return '';
}
function extractPublicRegionFromPage(html){
  const roots=parseScripts(html);
  for(const root of roots){const r=extractPublicRegion(root);if(r)return {value:r,source:'TikTok public page embedded metadata'};}
  const t=String(html||'');
  for(const key of ['region_code','regionCode','authorRegion','author_region','countryCode','country_code']){
    const re=new RegExp("[\\\"']"+key+"[\\\"']\\s*[:=]\\s*[\\\"']([^\\\"']{1,80})[\\\"']","gi");
    let m; while((m=re.exec(t))){const r=normalizePublicRegion(m[1]);if(r)return {value:r,source:'TikTok public page embedded metadata'};}
  }
  return {value:'',source:''};
}

function extractUserDetailRegionFromHtml(html){
  const t=String(html||'');
  // Current TikTok web pages embed creator profile data under
  // __DEFAULT_SCOPE__.webapp.user-detail. Some deployments expose `region`
  // only inside that profile object, not inside the video item.
  const markers=['webapp.user-detail','user-detail','__DEFAULT_SCOPE__'];
  for(const marker of markers){
    let pos=0;
    while((pos=t.indexOf(marker,pos))>=0){
      const chunk=t.slice(Math.max(0,pos-2000),Math.min(t.length,pos+120000));
      const patterns=[
        /\"region\"\s*:\s*\"([^\"]{1,80})\"/i,
        /\"region_code\"\s*:\s*\"([^\"]{1,80})\"/i,
        /\"regionCode\"\s*:\s*\"([^\"]{1,80})\"/i
      ];
      for(const re of patterns){const m=chunk.match(re);if(m){const r=normalizePublicRegion(m[1]);if(r)return {value:r,source:'TikTok webapp.user-detail creator profile'};}}
      pos+=marker.length;
    }
  }
  return {value:'',source:''};
}


async function publicTikTokUserRegion(username){
  const clean=String(username||'').replace(/^@/,'').trim();
  if(!clean)return null;
  const endpoints=[
    'https://www.tiktok.com/api/user/detail/?uniqueId='+encodeURIComponent(clean),
    'https://www.tiktok.com/api/user/detail/?unique_id='+encodeURIComponent(clean),
    'https://m.tiktok.com/api/user/detail/?uniqueId='+encodeURIComponent(clean),
    'https://www.tiktok.com/api/user/detail/?unique_id='+encodeURIComponent(clean)
  ];
  const regionKeys=['region','regionCode','region_code','countryCode','country_code','registeredCountry','registered_country'];
  for(const endpoint of endpoints){
    try{
      const r=await fetch(endpoint,{
        redirect:'follow',
        headers:{
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
          'Accept':'application/json,text/plain,*/*',
          'Accept-Language':'en-US,en;q=0.9',
          'Referer':'https://www.tiktok.com/@'+encodeURIComponent(clean)
        }
      });
      if(!r.ok)continue;
      const j=await r.json();
      const direct=[
        j?.userInfo?.user?.region,j?.user?.region,j?.data?.userInfo?.user?.region,
        j?.userInfo?.user?.regionCode,j?.userInfo?.user?.region_code,
        j?.user?.regionCode,j?.user?.region_code,
        j?.userInfo?.user?.countryCode,j?.userInfo?.user?.country_code
      ];
      for(const value of direct){
        const region=normalizePublicRegion(value);
        if(region)return {value:region,source:'TikTok public user detail endpoint'};
      }
      // Some public responses wrap the profile several levels deeper. Accept
      // only explicit region/country-code fields on an object that also looks
      // like a user/profile record; never use generic geo/location fields.
      for(const o of deepObjects(j)){
        if(!o||typeof o!=='object')continue;
        const userish=!!(o.uniqueId||o.unique_id||o.nickname||o.secUid||o.sec_uid||o.user||o.userInfo||o.profile);
        if(!userish)continue;
        for(const k of regionKeys){
          if(Object.prototype.hasOwnProperty.call(o,k)){
            const region=normalizePublicRegion(o[k]);
            if(region)return {value:region,source:'TikTok public user detail endpoint'};
          }
        }
      }
    }catch(_){}
  }
  return null;
}

function findFirstFieldByRegex(html, keys){
  const t=String(html||'');
  for(const key of keys){
    const re=new RegExp("[\\\"']"+key+"[\\\"']\\s*[:=]\\s*[\\\"']([^\\\"']{1,80})[\\\"']","gi");
    const m=t.match(re); if(m&&m[1])return m[1];
  }
  return '';
}

async function fetchUnsignedItemDetail(id, pageHtml){
  if(!id) return null;
  // TikTok's web item-detail endpoint is known to return the same aweme_detail
  // structure used by web extractors, including video.bit_rate[]. It may reject
  // unsigned requests; this is only a best-effort enrichment and never affects
  // the public-page fallback.
  let msToken='';
  const mt=String(pageHtml||'').match(/(?:msToken|ms_token)\s*[=:]\s*["']([^"']{20,})["']/i);
  if(mt) msToken=mt[1];
  const params=new URLSearchParams({
    aid:'1988',app_language:'en',app_name:'tiktok_web',browser_language:'en-US',
    browser_name:'Mozilla',browser_online:'true',browser_platform:'Win32',
    channel:'tiktok_web',cookie_enabled:'true',device_platform:'web_pc',
    focus_state:'true',from_page:'video',history_len:'1',is_fullscreen:'false',
    is_page_visible:'true',itemId:String(id),language:'en',os:'windows',
    priority_region:'US',referer:'',region:'US',screen_height:'1080',
    screen_width:'1920',webcast_language:'en',tz_name:'UTC'
  });
  if(msToken) params.set('msToken',msToken);
  try{
    const r=await fetch('https://www.tiktok.com/api/item/detail/?'+params.toString(),{
      redirect:'follow',headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'Accept':'application/json,text/plain,*/*','Accept-Language':'en-US,en;q=0.9',
        'Referer':'https://www.tiktok.com/'
      }
    });
    if(!r.ok) return null;
    const text=await r.text();
    if(!text||!text.trim())return null;
    try{return JSON.parse(text)}catch(_){return null}
  }catch(_){return null}
}

async function analyze(url){
  const u=cleanUrl(url);
  const oeUrl='https://www.tiktok.com/oembed?url='+encodeURIComponent(u);
  let oembed={};
  try{ const oe=await fetchText(oeUrl,{'User-Agent':'Mozilla/5.0'}); if(oe.r.ok) oembed=JSON.parse(oe.text); }catch(_){}
  const page=await fetchText(u,{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36','Accept-Language':'en-US,en;q=0.9'});
  if(!page.r.ok){
    if([401,403,404].includes(page.r.status)) return {ok:true,private:true,visibility:'Private / Unavailable',id:'',stats:{},region:'',shadowban:'Inconclusive',publicPageStatus:page.r.status};
    throw new Error(`TikTok page returned HTTP ${page.r.status}`);
  }
  const d=extract(page.text,u,oembed);
  // API-style enrichment: current TikTok extractors obtain per-stream FPS
  // from video.bit_rate[]. The normal web page exposes bitrateInfo instead,
  // so try the public web item-detail response as an additional source.
  try{
    const apiDetail=await fetchUnsignedItemDetail(d.id||((u.match(/\/video\/(\d+)/i)||[])[1]||''),page.text);
    const apiVideo=apiDetail?.itemInfo?.itemStruct?.video || apiDetail?.itemStruct?.video || apiDetail?.video;
    if(apiVideo){
      const apiVariants=collectVariants(apiVideo);
      if(apiVariants.length){
        d.variants=[...(d.variants||[]),...apiVariants];
        const seen=new Set();
        d.variants=d.variants.filter(v=>{const k=String(v.url||'')+'|'+String(v.name||'')+'|'+String(v.fps||0);if(seen.has(k))return false;seen.add(k);return true;});
      }
      if(!d.fps){
        const apiFps=modeNumber(apiVariants.map(v=>Number(v.fps||0)).filter(n=>n>0));
        if(apiFps)d.fps=apiFps;
      }
    }
  }catch(_){}
  // Raw bootstrap fallback: catches escaped/non-standard TikTok JSON containers.
  const rawFps=rawNumberCandidates(page.text,['FPS','Fps','fps','FrameRate','frameRate','frame_rate']);
  const rawFpsMode=modeNumber(rawFps);
  if(!d.fps && rawFpsMode) d.fps=rawFpsMode;
  if(Array.isArray(d.variants) && rawFpsMode){
    for(const v of d.variants){ if(!v.fps) v.fps=rawFpsMode; v.displayQuality=variantQuality(v,rawFpsMode); }
  }
  if(!d.region){ const rr=rawRegionCandidate(page.text); if(rr) d.region=rr; }
  d.visibility=detectPrivatePage(page.text,oembed, d.id?{id:d.id}:null, page.r.status)?'Private':'Public';
  if(d.visibility==='Private' && !d.id){
    return {ok:true,private:true,visibility:'Private',id:'',stats:d.stats||{},region:'',shadowban:'Inconclusive',publicPageStatus:page.r.status};
  }
  // Probe the selected stream and every distinct exposed variant. This keeps
  // FPS/codec/bitrate/size tied to the actual stream instead of one global value.
  const variantList=Array.isArray(d.variants)?d.variants:[];
  const rawUrls=collectRawMediaUrls(page.text);
  const existing=new Set(variantList.map(v=>String(v.url||'')));
  for(const u0 of rawUrls){
    if(existing.has(u0))continue;
    existing.add(u0);
    variantList.push({name:'discovered_stream',quality:'',codec:'',bitrate:0,size:0,width:0,height:0,fps:0,url:u0,sourceKey:'raw_bootstrap'});
  }
  const targets=[...variantList].filter(v=>v.url).slice(0,64);
  const probed=await Promise.all(targets.map(async v=>({v,p:await probeMediaDeep(v.url)})));
  for(const {v,p} of probed){
    const t=p.technical||{};
    v.size=Number(v.size||p.size||0)||0;
    v.codec=v.codec||t.codec||'';
    v.width=Number(v.width||t.width||0)||0;
    v.height=Number(v.height||t.height||0)||0;
    v.fps=Number(v.fps||t.fps||0)||0;
    v.bitrate=Number(v.bitrate||t.bitrate||0)||0;
    if(!v.bitrate && v.size && d.duration>0)v.bitrate=Math.round((v.size*8)/d.duration);
    v.displayQuality=variantQuality(v,v.fps);
  }
  d.variants=variantList;
  const best=(d.variants||[]).slice().sort((a,b)=>{
    const ar=(a.width||0)*(a.height||0), br=(b.width||0)*(b.height||0);
    const af=a.fps?1:0,bf=b.fps?1:0;
    return (br-ar)||((bf-af))||((b.bitrate||0)-(a.bitrate||0));
  })[0]||null;
  const bestUrl=best?.url||d.playUrl||'';
  const selected=best||{};
  d.playUrl=bestUrl;
  d.width=Number(selected.width||d.width||0)||0;
  d.height=Number(selected.height||d.height||0)||0;
  d.original=d.width&&d.height?`${d.width}x${d.height}`:'';
  d.aspect=d.width&&d.height?(d.width/d.height).toFixed(3):'';
  d.codec=selected.codec||d.codec||'';
  d.bitrate=Number(selected.bitrate||d.bitrate||0)||0;
  d.size=Number(selected.size||d.size||0)||0;
  d.fps=Number(selected.fps||d.fps||0)||0;
  d.browserQuality=selected.displayQuality||variantQuality(selected,d.fps)||d.browserQuality||'';
  d.phoneQuality=d.browserQuality;
  d.source=d.source||'';
  // Public-only Region extraction. Never infer Region from viewer/server location,
  // language, timezone, IP, CDN hostname, or media URL.
  d.region=d.region||'';
  d.regionSource=d.regionSource||'';
  if(d.region){
    const normalized=normalizePublicRegion(d.region);
    if(normalized)d.region=normalized;
  }
  if(!d.region){
    const exact=extractUserDetailRegionFromHtml(page.text);
    if(exact.value){d.region=exact.value;d.regionSource=exact.source;}
  }
  if(!d.region){
    const publicRegion=extractPublicRegionFromPage(page.text);
    if(publicRegion.value){d.region=publicRegion.value;d.regionSource=publicRegion.source;}
  }
  // Additional public user-profile fallback inspired by current/open TikTok
  // web API wrappers: query the public user detail endpoint using the creator
  // username. Only an explicitly returned region field is accepted.
  if(!d.region && d.username){
    // The video page may omit account region even when the public creator page
    // exposes it. Fetch the public profile page and inspect its embedded JSON.
    try{
      const profileUrl='https://www.tiktok.com/@'+encodeURIComponent(String(d.username).replace(/^@/,''));
      const pr=await fetchText(profileUrl,{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'Accept-Language':'en-US,en;q=0.9',
        'Referer':u
      });
      if(pr.r.ok){
        const exact=extractUserDetailRegionFromHtml(pr.text);
        if(exact.value){d.region=exact.value;d.regionSource=exact.source;}
        if(!d.region){
          const rr=extractPublicRegionFromPage(pr.text);
          if(rr.value){d.region=rr.value;d.regionSource='TikTok public creator profile embedded metadata';}
        }
      }
    }catch(_){}
  }
  if(!d.region && d.username){
    const publicUserRegion=await publicTikTokUserRegion(d.username);
    if(publicUserRegion){
      d.region=publicUserRegion.value;
      d.regionSource=publicUserRegion.source;
    }
  }
  // Research API enrichment is optional. It is the documented source for
  // creator account region_code and additional public content fields. It is
  // archived research data, not a realtime moderation/analytics feed.
  const research=await researchVideoById(d.id,d.createTime);
  if(research){
    d.researchApi=true;
    d.region=d.region||research.region_code||'';
    if(d.stats.views==null || d.stats.views==='') d.stats.views=research.view_count;
    if(d.stats.likes==null || d.stats.likes==='') d.stats.likes=research.like_count;
    if(d.stats.comments==null || d.stats.comments==='') d.stats.comments=research.comment_count;
    if(d.stats.shares==null || d.stats.shares==='') d.stats.shares=research.share_count;
    if(d.stats.favorites==null || d.stats.favorites==='') d.stats.favorites=research.favorites_count;
    d.researchRegionBasis='TikTok Research API region_code (creator account registration country; archived research data)';
  }
  // Raw bootstrap fallback for fields that exist in the page but are nested
  // outside the selected item object.
  if(!d.region){
    const publicRegion=extractPublicRegionFromPage(page.text);
    if(publicRegion.value){d.region=publicRegion.value;d.regionSource=publicRegion.source;}
  }
  if(!d.source){
    d.source=findFirstFieldByRegex(page.text,['videoSource','video_source','uploadSource','upload_source','creationSource','creation_source','source']);
  }

  // Downloads are only reported when TikTok exposes a real download-count field.
  // Do not estimate or derive it from views/shares.
  if(!d.stats.downloads){
    const roots=parseScripts(page.text);
    for(const root of roots){
      const x=findDeepValue(root,['downloadCount','download_count','downloads']);
      if(x!==''&&Number.isFinite(Number(x))){d.stats.downloads=Number(x);break;}
    }
  }
  if(d.stats.downloads!==undefined && d.stats.downloads!==null && d.stats.downloads!=='') d.stats.downloads=Number(d.stats.downloads)||0;
  const shadowSignal=assessPublicRestrictionSignal(d,page.r.status,!!Object.keys(oembed).length);
  d.shadowban=shadowSignal.status;
  d.shadowbanBasis=shadowSignal.basis;
  d.shadowbanOfficial=false;
  d.publicPageStatus=page.r.status;
  d.visibility='Public';
  return d;
}
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS') return send(res,204,'');
  try{
    if(req.url==='/health') return send(res,200,{ok:true,service:'cazper-analyzer',researchApiConfigured:!!(process.env.TIKTOK_RESEARCH_ACCESS_TOKEN||(process.env.TIKTOK_CLIENT_KEY&&process.env.TIKTOK_CLIENT_SECRET))});
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
