import {describe,it,expect} from 'vitest';
import {insidePolygon,validateScenery,type Coordinate,type SceneryData} from '../src/detail';
import {indexPolygon,polygonGridMask,polygonQueryBudget,SceneryComplexityError} from '../src/polygons';
import {SceneryLayer} from '../src/scenery';
import type {TerrainData} from '../src/core';

const square=(a:number,b:number,c:number,d:number):Coordinate[]=>[[a,b],[c,b],[c,d],[a,d],[a,b]];
const circle=(n:number):Coordinate[]=>Array.from({length:n},(_,i)=>[Math.cos(i/(n-1)*Math.PI*2),Math.sin(i/(n-1)*Math.PI*2)]);
describe('bounded exact polygon containment',()=>{
  it('matches reference parity for concavity, overlapping holes, vertices and reversed rings',()=>{
    const polygons:Coordinate[][][]=[
      [[[0,0],[5,0],[5,2],[2,2],[2,5],[0,5],[0,0]],square(.5,.5,1.5,3),square(1,1,2,4)],
      [square(3,3,6,6).reverse(),square(4,4,5,5)],
      [[[0,0],[6,6],[0,6],[6,0],[0,0]]],
    ];
    const xs=Array.from({length:33},(_,i)=>i/4-1),zs=[...xs],mask=polygonGridMask(polygons,xs,zs);
    const indexed=polygons.map(p=>indexPolygon(p));
    for(let row=0;row<zs.length;row++)for(let col=0;col<xs.length;col++){
      const x=xs[col],z=zs[row],expected=polygons.some(p=>insidePolygon(x,z,p));
      expect(!!mask[row*xs.length+col]).toBe(expected);
      expect(indexed.some(p=>p.contains(x,z))).toBe(expected);
    }
  });
  it('visits a 15,000-coordinate polygon once per DEM row, not per vertex',()=>{
    const ring=circle(15000),axis=Array.from({length:512},(_,i)=>i/511*2.2-1.1),stats={edgeVisits:0};
    const start=performance.now(),mask=polygonGridMask([[ring]],axis,axis,stats);
    expect(stats.edgeVisits).toBe(512*15000);
    expect(mask.length).toBe(512*512);
    expect(mask[256*512+256]).toBe(1);expect(mask[0]).toBe(0);
    expect(performance.now()-start).toBeLessThan(3000);
    const budget=polygonQueryBudget(),indexed=indexPolygon([ring],budget);
    for(let i=0;i<4096;i++){const x=(i%64)/32-1,z=Math.floor(i/64)/32-1;expect(indexed.contains(x,z)).toBe(insidePolygon(x,z,[ring]));}
    expect(budget.used).toBeLessThan(200000);
  });
  it('enforces one shared deterministic query limit instead of misclassifying a polygon',()=>{
    const budget=polygonQueryBudget(100),a=indexPolygon([circle(100)],budget),b=indexPolygon([circle(100)],budget);
    expect(()=>{for(let i=0;i<100;i++){a.contains(.2,.2);b.contains(.4,.4);}}).toThrow(SceneryComplexityError);
    expect(budget.used).toBe(101);
  });
  it('recovers from valid adversarial scenery without retaining stale detail or losing the DEM',()=>{
    const terrain:TerrainData={id:'test',name:'test',bounds:{west:135,south:35,east:135.01,north:35.01},cols:2,rows:2,heights:[100,100,100,100],min:100,max:100,sourceUrls:[],attribution:'test',license:'test'};
    const scenery:SceneryData={schemaVersion:1,features:[
      {id:'forest',kind:'forest',name:'forest',sourceUrl:'https://example.com',approximate:true,geometry:{type:'Polygon',coordinates:[square(135,35,135.01,35.01)]}},
      {id:'degenerate',kind:'bare_rock',name:'degenerate',sourceUrl:'https://example.com',approximate:true,geometry:{type:'Polygon',coordinates:[Array.from({length:14995},(_,i)=>i%2?[135.01,35.01]:[135,35])]}}
    ]};
    const layer=new SceneryLayer();layer.setQuality('low');const start=performance.now();layer.setData(terrain,validateScenery(scenery));
    expect(performance.now()-start).toBeLessThan(3000);
    expect(layer.stats.notice).toContain('複雑');expect(layer.stats.trees).toBe(0);
    expect(terrain.heights).toEqual([100,100,100,100]);
    layer.setData(terrain,undefined);expect(layer.stats.notice).toBeUndefined();layer.dispose();
  });
});
