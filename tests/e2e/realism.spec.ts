import {test,expect} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {unzipSync} from 'fflate';
const snapshot=async(page:any)=>page.evaluate(()=> (window as any).yamaDiagnostics.snapshot());
async function ready(page:any){await page.goto('/');await expect(page.locator('#loading')).toBeHidden({timeout:30000});await expect(page.locator('#coverage')).toBeHidden();await expect.poll(async()=> (await snapshot(page))?.detail.loaded,{timeout:30000}).toBe(true);}
test('real DEM, Blender detail, quality changes, closeups and cameras render',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const external:string[]=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4176/')&&!r.url().startsWith('data:'))external.push(r.url());});
 await ready(page);await page.screenshot({path:'test-results/overview-standard.png'});
 expect((await snapshot(page)).detail.trees).toBeGreaterThan(0);
 await page.locator('[data-focus="forest"]').click();await expect.poll(async()=> (await snapshot(page)).detail.nearTrees,{timeout:15000}).toBeGreaterThan(0);await page.waitForTimeout(2500);
 await page.screenshot({path:'test-results/forest-high.png'});const high=await snapshot(page);expect(high.quality).toBe('high');expect(high.detail.nearTrees).toBeLessThanOrEqual(96);
 await page.locator('[data-quality="standard"]').click();await page.waitForTimeout(900);await page.screenshot({path:'test-results/forest-standard.png'});const standard=await snapshot(page);expect(standard.detail.nearTrees).toBe(0);expect(standard.render.triangles).toBeLessThan(high.render.triangles);
 for(const focus of ['bare_rock','steps']){await page.locator(`[data-focus="${focus}"]`).click();await page.waitForTimeout(2600);await page.screenshot({path:`test-results/${focus}-high.png`});}
 const memory=(await snapshot(page)).memory;
 for(let i=0;i<3;i++)for(const q of ['low','standard','high']){await page.locator(`[data-quality="${q}"]`).click();await page.waitForTimeout(90);expect((await snapshot(page)).quality).toBe(q);}
 const beforeIdle=(await snapshot(page)).render.frame;await page.waitForTimeout(700);expect((await snapshot(page)).render.frame-beforeIdle).toBeLessThan(4);
 await page.waitForTimeout(500);expect((await snapshot(page)).memory.geometries).toBeLessThanOrEqual(memory.geometries+2);
 await page.locator('[data-quality="low"]').click();expect((await snapshot(page)).detail.trees).toBe(0);expect((await snapshot(page)).detail.steps).toBe(0);
 await page.locator('[data-mode="walk"]').click();expect((await snapshot(page)).mode).toBe('walk');
 for(const key of ['Home','ArrowRight','End']){await page.locator('#progress').focus();await page.keyboard.press(key);expect((await snapshot(page)).camera.every(Number.isFinite)).toBe(true);}
 await page.locator('[data-mode="overhead"]').click();expect((await snapshot(page)).mode).toBe('overhead');await page.locator('#reset').click();expect((await snapshot(page)).mode).toBe('orbit');await expect(page.locator('[data-mode="orbit"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#stage-help')).toContainText('ドラッグで回転');
 expect(errors).toEqual([]);expect(external).toEqual([]);await writeFile('test-results/renderer-counters.json',JSON.stringify({high,standard,errors,external},null,2));
});
test('project and portable ZIP preserve detail and local-only data without remote assets',async({page})=>{
 await ready(page);await page.locator('#save').click();
 let p=page.waitForEvent('download');await page.locator('#save-project').click();let download=await p;const project=JSON.parse(await readFile((await download.path())!,'utf8'));expect(project.version).toBe(1);expect(project.scenery.features.length).toBeGreaterThan(0);expect(project.photos).toHaveLength(0);
 p=page.waitForEvent('download');await page.locator('#save-viewer').click();download=await p;const zip=unzipSync(new Uint8Array(await readFile((await download.path())!)));for(const name of ['models/trail-assets.glb','models/trail-assets-low.glb','data/sample-features.json','data/project.json','index.html'])expect(zip[name]?.length).toBeGreaterThan(0);
 expect(JSON.parse(new TextDecoder().decode(zip['data/project.json'])).scenery).toEqual(project.scenery);
 await page.locator('[data-close="export-dialog"]').click();
 await page.locator('#project-file').setInputFiles({name:'roundtrip.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});await expect(page.locator('#notice')).toContainText('保存した記録を開きました');
 // Entirely synthetic coordinates near (0,0), never a person's location or GPX.
 const synthetic={version:1,terrain:{...project.terrain,id:'synthetic',bounds:{west:0,south:0,east:.01,north:.01},cols:2,rows:2,heights:[100,100,100,100],min:100,max:100},track:{name:'Synthetic fixture',segments:[[{lat:.005,lon:.005},{lat:.006,lon:.006}]]},photos:[],peaks:[],scenery:{schemaVersion:1,features:[{id:'synthetic-forest',kind:'forest',name:'Synthetic forest',sourceUrl:'https://example.com',approximate:true,geometry:{type:'Polygon',coordinates:[[[0,0],[.01,0],[.01,.01],[0,.01],[0,0]]]}}]}};
 await page.locator('#project-file').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(synthetic))});
 await expect(page.locator('#route-name')).toHaveText('Synthetic fixture');expect((await snapshot(page)).detail.trees).toBeGreaterThan(0);
 await page.locator('#gpx-file').setInputFiles({name:'synthetic.gpx',mimeType:'application/gpx+xml',buffer:Buffer.from('<gpx><trk><name>Synthetic route fixture</name><trkseg><trkpt lat="0.005" lon="0.005"/><trkpt lat="0.006" lon="0.006"/></trkseg></trk></gpx>')});
 await expect(page.locator('#route-name')).toHaveText('Synthetic route fixture');expect((await snapshot(page)).detail.trees).toBe(0);await expect(page.locator('[data-focus="forest"]')).toBeDisabled();
});
test('mobile layout keeps quality and controls usable without overflow',async({browser})=>{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});const page=await context.newPage();await ready(page);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);for(const q of ['low','standard','high']){await page.locator(`[data-quality="${q}"]`).tap();expect((await snapshot(page)).quality).toBe(q);}
 await page.screenshot({path:'test-results/mobile-high.png'});await context.close();
});

test('a missing model is surfaced without losing the real DEM',async({page})=>{
 await page.route('**/models/trail-assets.glb',route=>route.abort());await page.goto('/');await expect(page.locator('#loading')).toBeHidden();await expect(page.locator('#coverage')).toBeHidden();await expect(page.locator('#notice')).toContainText('地物モデルを読み込めませんでした',{timeout:15000});await page.locator('[data-quality="low"]').click();expect((await snapshot(page)).quality).toBe('low');
});

test('maximum scenery imports stay usable and preserve densely recorded route bends',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await ready(page);await page.locator('[data-quality="low"]').click();
 // Stress geometry is generated around (0,0); it is not a surveyed or personal route.
 const terrain={id:'maximum-polygon-grid',name:'Maximum polygon fixture',bounds:{west:0,south:0,east:.01,north:.01},cols:512,rows:512,heights:Array(512*512).fill(100),min:100,max:100,sourceUrls:[],attribution:'Generated test fixture',license:'Test fixture'};
 const track={name:'Synthetic 10 cm bends',segments:[Array.from({length:1000},(_,i)=>({lat:.005+(i%2)*.0000007,lon:.004+i*.0000007}))]};
 const ring=Array.from({length:15000},(_,i)=>{const a=i/14999*Math.PI*2;return[.005+Math.cos(a)*.0048,.005+Math.sin(a)*.0048];});
 const feature={id:'forest',kind:'forest',name:'Generated forest',sourceUrl:'https://example.com',approximate:true,geometry:{type:'Polygon',coordinates:[ring]}};
 const project={version:1,terrain,track,photos:[],peaks:[],scenery:{schemaVersion:1,features:[feature]}};
 await page.locator('#project-file').setInputFiles({name:'maximum.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await expect(page.locator('#route-name')).toHaveText(track.name,{timeout:30000});await expect(page.locator('#coverage')).toBeHidden();
 const imported=await snapshot(page);expect(imported.terrain).toBe(terrain.id);expect(imported.routeGeometry.segments).toBe(999);expect(imported.routeGeometry.maxDeviation).toBe(0);expect(imported.detail.notice).toBeUndefined();
 await page.screenshot({path:'test-results/maximum-polygon-grid.png'});
 project.scenery.features=[{...feature,geometry:{type:'Polygon',coordinates:[[[0,0],[.01,0],[.01,.01],[0,.01],[0,0]]]}},{...feature,id:'pathological',kind:'bare_rock',geometry:{type:'Polygon',coordinates:[Array.from({length:14995},(_,i)=>i%2?[.01,.01]:[0,0])]}}];
 await page.locator('#project-file').setInputFiles({name:'bounded-complexity.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await expect(page.locator('#detail-status')).toContainText('複雑',{timeout:30000});await expect(page.locator('#coverage')).toBeHidden();
 await page.locator('[data-mode="walk"]').click();expect((await snapshot(page)).mode).toBe('walk');
 await page.locator('[data-quality="standard"]').click();expect((await snapshot(page)).detail.trees).toBe(0);await expect(page.locator('#detail-status')).toContainText('複雑');
 await page.locator('#sample').click();await expect(page.locator('#route-kind')).toHaveText('FIELD NOTE · SUMA, KOBE');expect((await snapshot(page)).detail.notice).toBeUndefined();expect((await snapshot(page)).detail.trees).toBeGreaterThan(0);
 expect(errors).toEqual([]);await writeFile('test-results/import-boundaries.json',JSON.stringify({imported,errors},null,2));
});
