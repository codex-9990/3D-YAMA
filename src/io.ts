import { validateScenery, type SceneryData } from './detail';
import { zipSync, strToU8 } from 'fflate';
import { parseGPX, validateTerrain, type Track, type TerrainData, trackBounds } from './core';
export interface Photo {id:string;name:string;lat:number;lon:number;url:string;distance:number}
export interface Project {version:1;track:Track;terrain:TerrainData;photos:Photo[];peaks:Peak[];scenery?:SceneryData}
export interface Peak {name:string;lat:number;lon:number;elevation?:number}
export const MAX_PROJECT_BYTES=40*1024*1024;
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export function trackToGPX(track:Track):string{return `<?xml version="1.0"?><gpx version="1.1" creator="3D YAMA" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escape(track.name)}</name>${track.segments.map(seg=>`<trkseg>${seg.map(p=>`<trkpt lat="${p.lat}" lon="${p.lon}">${p.elevation===undefined?'':`<ele>${p.elevation}</ele>`}${p.time?`<time>${escape(p.time)}</time>`:''}</trkpt>`).join('')}</trkseg>`).join('')}</trk></gpx>`;}
export function readProject(text:string):Project{
 if(text.length>MAX_PROJECT_BYTES)throw new Error('プロジェクトは40 MB以下にしてください。');
 const d=JSON.parse(text);if(!d||d.version!==1||!Array.isArray(d.track?.segments)||!Array.isArray(d.photos)||!Array.isArray(d.peaks))throw new Error('対応していないプロジェクト形式です。');
 if(d.track.segments.length>1000||d.track.segments.some((s:unknown)=>!Array.isArray(s))||d.track.segments.flat().length>50000||typeof d.track.name!=='string')throw new Error('GPXの点数または名前が不正です。');
 if(d.track.segments.some((seg:any[])=>seg.some(p=>!p||typeof p.lat!=='number'||typeof p.lon!=='number'||!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||(p.elevation!==undefined&&(typeof p.elevation!=='number'||!Number.isFinite(p.elevation)))||(p.time!==undefined&&typeof p.time!=='string'))))throw new Error('GPXの座標または時刻が不正です。');
 const track=parseGPX(trackToGPX(d.track));const terrain=validateTerrain(d.terrain);
 if(d.photos.length>20||d.peaks.length>200)throw new Error('写真または山名が多すぎます。');
 const photos=d.photos.map((p:Photo,i:number)=>{if(!p||typeof p.name!=='string'||p.name.length>200||!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||Math.abs(p.lat)>85||Math.abs(p.lon)>180||!Number.isFinite(p.distance)||p.distance<0||typeof p.url!=='string'||p.url.length>2e6||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*(?![\s\S])/.test(p.url))throw new Error('写真データが不正です。');return {id:`photo-${i}`,name:p.name,lat:p.lat,lon:p.lon,distance:p.distance,url:p.url};});
 const peaks=d.peaks.map((p:Peak)=>{if(!p||typeof p.name!=='string'||p.name.length>100||!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||Math.abs(p.lat)>85||Math.abs(p.lon)>180)throw new Error('山名データが不正です。');return {name:p.name,lat:p.lat,lon:p.lon,elevation:Number.isFinite(p.elevation)?p.elevation:undefined};});
 return {version:1,track,terrain,photos,peaks,...(d.scenery===undefined?{}:{scenery:validateScenery(d.scenery)})};
}
export function download(blob:Blob,name:string){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
export async function importPhoto(file:File):Promise<string>{
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12*1024*1024)throw new Error('写真はJPEG / PNG / WebP、1枚12 MB以下にしてください。');
 const bitmap=await createImageBitmap(file);try{if(bitmap.width*bitmap.height>40e6)throw new Error('写真は4,000万画素以下にしてください。');const scale=Math.min(1,1280/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));const ctx=canvas.getContext('2d');if(!ctx)throw new Error('写真の変換に失敗しました。');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.83);}finally{bitmap.close();}}
export async function exportViewer(project:Project):Promise<void>{
 const response=await fetch(new URL('index.html',location.href));if(!response.ok)throw new Error('ビューアーの取得に失敗しました。');const html=await response.text();
 if(html.includes('/src/main.ts')||html.includes('/@vite/client'))throw new Error('静的ZIPは npm run build → npm run preview で作成できます。開発中はプロジェクト保存を利用してください。');
 const doc=new DOMParser().parseFromString(html,'text/html');const files:Record<string,Uint8Array>={'index.html':strToU8(html),'data/project.json':strToU8(JSON.stringify(project))};
 const paths=[...Array.from(doc.querySelectorAll('script[src]'),n=>n.getAttribute('src')!),...Array.from(doc.querySelectorAll('link[href]'),n=>n.getAttribute('href')!)];
 for(const path of paths){const url=new URL(path,location.href);if(url.origin!==location.origin)throw new Error('外部アセットは書き出せません。');const res=await fetch(url);if(!res.ok)throw new Error(`アセット取得に失敗しました: ${path}`);files[path.replace(/^\.\//,'').replace(/^\//,'')]=new Uint8Array(await res.arrayBuffer());}
 for(const path of ['THIRD_PARTY_NOTICES.txt','data/terrain.json','data/sample-route.gpx','data/sample-peaks.json','data/provenance.json','data/LICENSES.txt','data/sample-osm-source.geojson','data/sample-features.json','models/trail-assets.glb','models/trail-assets-low.glb','models/README.md']){const res=await fetch(new URL(path,location.href));if(!res.ok)throw new Error(`データ取得に失敗しました: ${path}`);files[path]=new Uint8Array(await res.arrayBuffer());}
 files['START-HERE.txt']=strToU8('3D YAMA — portable viewer\n\nServe this folder with any static HTTP server. For example:\n  python3 -m http.server 8080\nThen open http://localhost:8080. File:// is not supported.\n\nThis archive contains the route and any attached resized photos. They can reveal your location. Only publish or send it if you intend to share those details.\nThe viewer has no analytics or upload endpoint. Optional GSI terrain requests require pressing the explicit load button.\nGSI terrain attribution: https://maps.gsi.go.jp/development/ichiran.html\nSample route/peaks: © OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright\nNot for navigation. See data/provenance.json.\n');
 download(new Blob([zipSync(files,{level:6}) as BlobPart],{type:'application/zip'}),'3d-yama-viewer.zip');
}
export function decodeElevation(r:number,g:number,b:number):number|null{const n=r*65536+g*256+b;return n===8388608?null:(n>8388608?n-16777216:n)*.01;}
function pixel(lon:number,lat:number,z:number){const n=256*2**z;return {x:(lon+180)/360*n,y:(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n};}
export async function fetchGsiTerrain(track:Track,signal:AbortSignal):Promise<TerrainData>{
 const b=trackBounds(track);if(b.west<122||b.east>154||b.south<20||b.north>46)throw new Error('地理院DEMの取得は日本国内向けです。他地域は地形JSONを読み込んでください。');
 const mid=(b.north+b.south)/2;const padY=.0015,padX=.0015/Math.cos(mid*Math.PI/180);const bounds={west:b.west-padX,east:b.east+padX,south:b.south-padY,north:b.north+padY};
 let z=14;for(;z>10;z--){const a=pixel(bounds.west,bounds.north,z),c=pixel(bounds.east,bounds.south,z);if((Math.floor(c.x/256)-Math.floor(a.x/256)+1)*(Math.floor(c.y/256)-Math.floor(a.y/256)+1)<=24)break;}
 const tiles=new Map<string,Uint8ClampedArray>();const requests:string[]=[];const nw=pixel(bounds.west,bounds.north,z),se=pixel(bounds.east,bounds.south,z);const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('画像処理に対応していません。');
 for(let ty=Math.floor(nw.y/256);ty<=Math.floor(se.y/256);ty++)for(let tx=Math.floor(nw.x/256);tx<=Math.floor(se.x/256);tx++){
  const url=`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${tx}/${ty}.png`;const r=await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'});if(!r.ok)throw new Error('地理院DEMを取得できませんでした。通信状態または対象範囲を確認してください。');const blob=await r.blob();if(blob.size>2e6)throw new Error('標高タイルが不正です。');const bitmap=await createImageBitmap(blob);if(bitmap.width!==256||bitmap.height!==256){bitmap.close();throw new Error('標高タイルのサイズが不正です。');}ctx.clearRect(0,0,256,256);ctx.drawImage(bitmap,0,0);bitmap.close();tiles.set(`${tx}/${ty}`,ctx.getImageData(0,0,256,256).data);requests.push(url);
 }
 const cols=161,rows=161,heights:number[]=[];for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){const lon=bounds.west+(bounds.east-bounds.west)*col/(cols-1),lat=bounds.south+(bounds.north-bounds.south)*row/(rows-1);const p=pixel(lon,lat,z);const data=tiles.get(`${Math.floor(p.x/256)}/${Math.floor(p.y/256)}`)!;const i=((Math.floor(p.y)%256)*256+Math.floor(p.x)%256)*4;const h=decodeElevation(data[i],data[i+1],data[i+2]);if(h===null||data[i+3]===0)throw new Error('この範囲には海域・未収録の標高があります。架空の地形では補完しません。より狭いGPXか、欠損のない地形JSONを利用してください。');heights.push(Math.round(h*100)/100);}
 return validateTerrain({id:'gsi-local',name:'読み込んだルート周辺',bounds,cols,rows,heights,min:Math.min(...heights),max:Math.max(...heights),attribution:'地理院タイル（標高タイル DEM10B）を加工して作成',sourceUrls:['https://maps.gsi.go.jp/development/ichiran.html',...requests],license:'GSI content terms / Public Data License 1.0'});
}
