import type {Project} from '../../src/io';

/** Generated geometry near (0,0), with no personal/surveyed locations or imported GPX. */
export function maximumProjectFixture():Project {
 const terrain={id:'maximum-polygon-grid',name:'Maximum polygon fixture',bounds:{west:0,south:0,east:.01,north:.01},cols:512,rows:512,heights:Array(512*512).fill(100),min:100,max:100,sourceUrls:['https://example.com/synthetic-test-fixture'],attribution:'Generated test fixture',license:'Test fixture'};
 const track={name:'Synthetic 10 cm bends',segments:[Array.from({length:1000},(_,i)=>({lat:.005+(i%2)*.0000007,lon:.004+i*.0000007}))]};
 const ring:[number,number][]=Array.from({length:15000},(_,i)=>{const a=i/14999*Math.PI*2;return[.005+Math.cos(a)*.0048,.005+Math.sin(a)*.0048];});
 return {version:1,terrain,track,photos:[],peaks:[],scenery:{schemaVersion:1,features:[{id:'forest',kind:'forest',name:'Generated forest',sourceUrl:'https://example.com',approximate:true,geometry:{type:'Polygon',coordinates:[ring]}}]}};
}
