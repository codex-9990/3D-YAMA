import type { Coordinate } from './detail';

type Bounds = { minX:number; maxX:number; minZ:number; maxZ:number };
type Edge = Bounds & { a:Coordinate; b:Coordinate };
type Node = Bounds & { commonLow:number; commonHigh:number; count:number; edges?:Edge[]; left?:Node; right?:Node };
export class SceneryComplexityError extends Error {
  constructor(){super('地物の範囲が複雑なため、樹木・岩・階段の配置を省略しました。実DEMとルートは表示できます。');}
}
/** A shared operation budget, independent of CPU speed, also bounds degenerate polygons. */
export function polygonQueryBudget(limit=5_000_000){
  let used=0;
  return { get used(){return used;}, spend(){if(++used>limit)throw new SceneryComplexityError();} };
}
export function indexPolygon(rings:Coordinate[][],budget=polygonQueryBudget()){
  const build=(edges:Edge[]):Node=>{
    const n:Node={minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity,commonLow:-Infinity,commonHigh:Infinity,count:edges.length};
    for(const e of edges){n.minX=Math.min(n.minX,e.minX);n.maxX=Math.max(n.maxX,e.maxX);n.minZ=Math.min(n.minZ,e.minZ);n.maxZ=Math.max(n.maxZ,e.maxZ);n.commonLow=Math.max(n.commonLow,e.minZ);n.commonHigh=Math.min(n.commonHigh,e.maxZ);}
    if(edges.length<=8)n.edges=edges;
    else {const axis=n.maxX-n.minX>n.maxZ-n.minZ?'X':'Z';edges.sort((a,b)=>a[`min${axis}`]+a[`max${axis}`]-b[`min${axis}`]-b[`max${axis}`]);const mid=edges.length>>>1;n.left=build(edges.slice(0,mid));n.right=build(edges.slice(mid));}
    return n;
  };
  const roots=rings.map(r=>{const edges:Edge[]=[];for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i],b=r[j];if(a[1]!==b[1])edges.push({a,b,minX:Math.min(a[0],b[0]),maxX:Math.max(a[0],b[0]),minZ:Math.min(a[1],b[1]),maxZ:Math.max(a[1],b[1])});}return build(edges);});
  const parity=(n:Node,x:number,z:number):number=>{
    budget.spend();
    if(x>=n.maxX||z<n.minZ||z>=n.maxZ)return 0;
    if(x<n.minX&&z>=n.commonLow&&z<n.commonHigh)return n.count%2;
    if(!n.edges)return parity(n.left!,x,z)^parity(n.right!,x,z);
    let p=0;for(const {a,b} of n.edges){budget.spend();if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])p^=1;}return p;
  };
  return { bounds:roots[0], contains(x:number,z:number){return !!roots.length&&!!parity(roots[0],x,z)&&!roots.slice(1).some(r=>parity(r,x,z));} };
}

/** Exact horizontal scanlines: each edge is visited once per grid row, not per vertex.
 * Ring spans use the same [left,right) boundary rule as insidePolygon; holes are a union.
 * For validated input: <=512 rows * 15,000 edges, plus <=100 polygons * grid size.
 */
export function polygonGridMask(polygons:Coordinate[][][],xs:readonly number[],zs:readonly number[],stats?:{edgeVisits:number}):Uint8Array{
  const mask=new Uint8Array(xs.length*zs.length);
  const lower=(x:number)=>{let lo=0,hi=xs.length;while(lo<hi){const mid=(lo+hi)>>>1;if(xs[mid]<x)lo=mid+1;else hi=mid;}return lo;};
  for(const rings of polygons){
    const outer=new Int32Array(xs.length+1),holes=new Int32Array(xs.length+1);
    for(let row=0;row<zs.length;row++){
      outer.fill(0);holes.fill(0);const z=zs[row];
      for(let k=0;k<rings.length;k++){
        const ring=rings[k],crossings:number[]=[];
        for(let i=0,j=ring.length-1;i<ring.length;j=i++){
          if(stats)stats.edgeVisits++;
          const a=ring[i],b=ring[j];if((a[1]>z)!==(b[1]>z))crossings.push((b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]);
        }
        crossings.sort((a,b)=>a-b);const diff=k?holes:outer;
        for(let i=0;i+1<crossings.length;i+=2){diff[lower(crossings[i])]++;diff[lower(crossings[i+1])]--;}
      }
      let outside=0,hole=0;for(let col=0;col<xs.length;col++){outside+=outer[col];hole+=holes[col];if(outside&&!hole)mask[row*xs.length+col]=1;}
    }
  }
  return mask;
}
