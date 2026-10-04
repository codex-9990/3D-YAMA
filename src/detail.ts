/** Bounded, deterministic illustrative surface detail. Never changes DEM elevations. */
import { createProjection, projectPoint, type GeoPoint, type TerrainData, type Track } from './core';
export type Quality = 'low' | 'standard' | 'high';
export const QUALITY = {
  low: { label: '軽量', pixelRatio: 1, trees: 0, nearTrees: 0, nearDistance: 0, rocks: 0, shadow: 0 },
  standard: { label: '標準', pixelRatio: 1.5, trees: 1600, nearTrees: 0, nearDistance: 0, rocks: 120, shadow: 1024 },
  high: { label: '精細', pixelRatio: 2, trees: 4800, nearTrees: 96, nearDistance: 115, rocks: 360, shadow: 2048 },
} as const;
export type Coordinate = [number, number];
export type FeatureGeometry = { type: 'Point'; coordinates: Coordinate } | { type: 'LineString'; coordinates: Coordinate[] } | { type: 'Polygon'; coordinates: Coordinate[][] };
export interface DetailFeature { id: string; kind: 'bare_rock' | 'forest' | 'steps' | 'landmark'; name: string; geometry: FeatureGeometry; sourceUrl: string; approximate: boolean; surface?: 'concrete'|'unverified'|'timber'; focusKey?: 'ridge'|'stairs'|'forest' }
export interface SceneryData { schemaVersion: 1; features: DetailFeature[] }
export interface Placement { x: number; y: number; z: number; rotation: number; scale: number; variant: number }
export interface DetailPlan { trees: Placement[]; rocks: Placement[]; steps: Placement[] }
export function validateScenery(input: unknown): SceneryData {
  const d = input as SceneryData;
  if (!d || d.schemaVersion !== 1 || !Array.isArray(d.features) || d.features.length > 100) throw new Error('詳細地物データが不正です。');
  const coord = (p: Coordinate) => { if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85) throw new Error('地物の座標が不正です。'); return [p[0], p[1]] as Coordinate; };
  let count = 0;
  const points = (p: Coordinate[]) => { if (!Array.isArray(p) || (count += p.length) > 15000) throw new Error('地物の点数が不正です。'); return p.map(coord); };
  return { schemaVersion: 1, features: d.features.map(f => {
    if (!f || !['bare_rock','forest','steps','landmark'].includes(f.kind) || typeof f.id !== 'string' || f.id.length > 100 || typeof f.name !== 'string' || f.name.length > 150 || typeof f.sourceUrl !== 'string' || !/^https:\/\//.test(f.sourceUrl) || f.sourceUrl.length > 1000) throw new Error('地物の出典が不正です。');
    let geometry: FeatureGeometry;
    if (f.geometry?.type === 'Point') geometry = { type:'Point', coordinates:coord(f.geometry.coordinates) };
    else if (f.geometry?.type === 'LineString') { const coordinates=points(f.geometry.coordinates); if(coordinates.length<2) throw new Error('地物の線が不正です。'); geometry={type:'LineString',coordinates}; }
    else if(f.geometry?.type==='Polygon') { if(!Array.isArray(f.geometry.coordinates)||f.geometry.coordinates.length>50)throw new Error('地物の範囲が不正です。'); const coordinates=f.geometry.coordinates.map(points); if(!coordinates.length||coordinates.some(r=>r.length<4))throw new Error('地物の範囲が不正です。'); geometry={type:'Polygon',coordinates}; }
    else throw new Error('地物の形が不正です。');
    return { id:f.id, kind:f.kind, name:f.name, geometry, sourceUrl:f.sourceUrl, approximate: true, ...(['concrete','unverified','timber'].includes(f.surface??'')?{surface:f.surface}:{}), ...(['ridge','stairs','forest'].includes(f.focusKey??'')?{focusKey:f.focusKey}: {}) };
  }) };
}
export function insideRing(x:number,z:number,ring:Coordinate[]):boolean { let inside=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside; }
export function insidePolygon(x:number,z:number,rings:Coordinate[][]):boolean { return !!rings.length&&insideRing(x,z,rings[0])&&!rings.slice(1).some(r=>insideRing(x,z,r)); }
export function surfaceHeight(data:TerrainData,lat:number,lon:number):number {
  const x=Math.max(0,Math.min(data.cols-1,(lon-data.bounds.west)/(data.bounds.east-data.bounds.west)*(data.cols-1)));
  const z=Math.max(0,Math.min(data.rows-1,(lat-data.bounds.south)/(data.bounds.north-data.bounds.south)*(data.rows-1)));
  const col=Math.min(Math.floor(x),data.cols-2),row=Math.min(Math.floor(z),data.rows-2),u=x-col,v=z-row;
  const a=data.heights[row*data.cols+col],b=data.heights[row*data.cols+col+1],c=data.heights[(row+1)*data.cols+col],d=data.heights[(row+1)*data.cols+col+1];
  return u+v<=1?a+(b-a)*u+(c-a)*v:d+(c-d)*(1-u)+(b-d)*(1-v);
}
export function distanceToLine(x:number,z:number,line:Coordinate[]):number { let best=Infinity;for(let i=1;i<line.length;i++){const a=line[i-1],b=line[i],dx=b[0]-a[0],dz=b[1]-a[1],q=dx*dx+dz*dz,t=q?Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/q)):0;best=Math.min(best,Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t));}return best; }
/** Bounding-volume hierarchy keeps 50k-point imported projects out of the placement hot path. */
export function lineProximity(lines:Coordinate[][]):(x:number,z:number,radius:number)=>boolean {
  type Segment={a:Coordinate;b:Coordinate;minX:number;maxX:number;minZ:number;maxZ:number};
  type Node={minX:number;maxX:number;minZ:number;maxZ:number;left?:Node;right?:Node;segments?:Segment[]};
  const segments:Segment[]=[];
  for(const line of lines)for(let i=1;i<line.length;i++){const a=line[i-1],b=line[i];segments.push({a,b,minX:Math.min(a[0],b[0]),maxX:Math.max(a[0],b[0]),minZ:Math.min(a[1],b[1]),maxZ:Math.max(a[1],b[1])});}
  const build=(items:Segment[]):Node=>{const node:Node={minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity};for(const s of items){node.minX=Math.min(node.minX,s.minX);node.maxX=Math.max(node.maxX,s.maxX);node.minZ=Math.min(node.minZ,s.minZ);node.maxZ=Math.max(node.maxZ,s.maxZ);}if(items.length<=12){node.segments=items;return node;}const axis=node.maxX-node.minX>node.maxZ-node.minZ?'X':'Z';items.sort((a,b)=>(a[`min${axis}`]+a[`max${axis}`])-(b[`min${axis}`]+b[`max${axis}`]));const mid=items.length>>>1;node.left=build(items.slice(0,mid));node.right=build(items.slice(mid));return node;};
  const root=build(segments);
  const visit=(node:Node,x:number,z:number,r:number):boolean=>{if(x+r<node.minX||x-r>node.maxX||z+r<node.minZ||z-r>node.maxZ)return false;if(node.segments)return node.segments.some(s=>distanceToLine(x,z,[s.a,s.b])<r);return visit(node.left!,x,z,r)||visit(node.right!,x,z,r);};
  return (x,z,radius)=>visit(root,x,z,radius);
}
export function seeded(seed=73647):()=>number { return ()=>{seed|=0;seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;}; }
export function createDetailPlan(data:TerrainData,scenery:SceneryData,track?:Track):DetailPlan {
  const random=seeded(),projection=createProjection(data),b=data.bounds;
  const world=(p:Coordinate):Coordinate=>{const q=projectPoint({lon:p[0],lat:p[1]},projection);return [q.x,q.z];};
  const geo=(x:number,z:number):GeoPoint=>({lon:x/projection.metersPerDegreeLon+projection.lon,lat:projection.lat-z/projection.metersPerDegreeLat});
  const sw=world([b.west,b.south]),ne=world([b.east,b.north]);
  const polygons=(kind:string)=>scenery.features.filter(f=>f.kind===kind&&f.geometry.type==='Polygon').map(f=>(f.geometry as Extract<FeatureGeometry,{type:'Polygon'}>).coordinates.map(r=>r.map(world)));
  const forests=polygons('forest'),bare=polygons('bare_rock');
  const routes=track?.segments.map(s=>s.map(p=>world([p.lon,p.lat])))??[];
  const stairFeatures=scenery.features.filter(f=>f.kind==='steps'&&f.geometry.type==='LineString');
  const stairs=stairFeatures.map(f=>(f.geometry as Extract<FeatureGeometry,{type:'LineString'}>).coordinates.map(world));
  const trees:Placement[]=[],rocks:Placement[]=[],steps:Placement[]=[];
  const nearTrail=lineProximity([...routes,...stairs]);const nearRoute=lineProximity(routes);
  const within=(p:GeoPoint)=>p.lat>b.south&&p.lat<b.north&&p.lon>b.west&&p.lon<b.east;
  const height=(x:number,z:number)=>{const p=geo(x,z);return surfaceHeight(data,p.lat,p.lon);};
  // One spatially stable distribution shared by all quality settings. No random terrain relief.
  for(let i=0;i<50000&&trees.length<QUALITY.high.trees;i++){
    const x=sw[0]+random()*(ne[0]-sw[0]),z=ne[1]+random()*(sw[1]-ne[1]);
    if(!forests.some(p=>insidePolygon(x,z,p))||bare.some(p=>insidePolygon(x,z,p)))continue;
    if(nearTrail(x,z,5))continue;
    const y=height(x,z),slope=Math.hypot(height(x+2,z)-height(x-2,z),height(x,z+2)-height(x,z-2))/4;
    if(slope>1.9||y<2)continue;
    trees.push({x,y:y-.15,z,rotation:random()*Math.PI*2,scale:1.05+random()*.7,variant:random()>.72?1:0});
  }
  for(const polygon of bare){
    const xs=polygon[0].map(p=>p[0]),zs=polygon[0].map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
    for(let i=0;i<3000&&rocks.length<QUALITY.high.rocks;i++){
      const x=minX+random()*(maxX-minX),z=minZ+random()*(maxZ-minZ),p=geo(x,z);
      if(!within(p)||!insidePolygon(x,z,polygon)||nearRoute(x,z,1.15))continue;
      rocks.push({x,y:height(x,z)-.16,z,rotation:random()*Math.PI*2,scale:.35+random()*1.05,variant:0});
    }
  }
  // Actual mapped step centerlines, representative tread spacing, not measured step counts.
  for(const [stairIndex,line] of stairs.entries())for(let i=1;i<line.length;i++){
    const a=line[i-1],b=line[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]),rise=Math.abs(height(...b)-height(...a));
    const n=Math.min(600,Math.max(1,Math.ceil(length/.58),Math.ceil(rise/.22)));
    for(let j=0;j<n&&steps.length<1200;j++){
      const t=(j+.5)/n,x=a[0]+(b[0]-a[0])*t,z=a[1]+(b[1]-a[1])*t;if(!within(geo(x,z)))continue;
      steps.push({x,y:height(x,z)+.035,z,rotation:Math.atan2(b[0]-a[0],b[1]-a[1]),scale:1,variant:stairFeatures[stairIndex].surface==='concrete'?1:0});
    }
  }
  return {trees,rocks,steps};
}

/** Shared geometry budget across disconnected GPX segments; never joins their endpoints. */
export function routeGeometryBudget(lengths:readonly number[],budget=12000):number[]{
  if(!lengths.length)return [];
  if(lengths.length>budget)throw new Error('Route has too many disconnected geometry chunks.');
  const weights=lengths.map(v=>Number.isFinite(v)&&v>0?v:0),sum=weights.reduce((a,b)=>a+b,0),remaining=budget-lengths.length;
  const allocation=weights.map(w=>1+Math.floor(remaining*(sum?w/sum:1/weights.length)));
  let spare=budget-allocation.reduce((a,b)=>a+b,0);for(let i=0;spare>0;i++,spare--)allocation[i%allocation.length]++;
  return allocation;
}
