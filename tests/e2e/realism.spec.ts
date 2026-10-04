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
 for(let i=0;i<6;i++)for(const q of ['low','standard','high']){await page.locator(`[data-quality="${q}"]`).click();await page.waitForTimeout(90);expect((await snapshot(page)).quality).toBe(q);}
 await page.waitForTimeout(500);expect((await snapshot(page)).memory.geometries).toBeLessThanOrEqual(memory.geometries+2);
 await page.locator('[data-quality="low"]').click();expect((await snapshot(page)).detail.trees).toBe(0);expect((await snapshot(page)).detail.steps).toBe(0);
 await page.locator('[data-mode="walk"]').click();expect((await snapshot(page)).mode).toBe('walk');
 for(const key of ['Home','ArrowRight','End']){await page.locator('#progress').focus();await page.keyboard.press(key);expect((await snapshot(page)).camera.every(Number.isFinite)).toBe(true);}
 await page.locator('[data-mode="overhead"]').click();expect((await snapshot(page)).mode).toBe('overhead');await page.locator('#reset').click();expect((await snapshot(page)).mode).toBe('orbit');await expect(page.locator('[data-mode="orbit"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#stage-help')).toContainText('ドラッグで回転');
 expect(errors).toEqual([]);expect(external).toEqual([]);await writeFile('test-results/renderer-counters.json',JSON.stringify({high,standard,errors,external},null,2));
});
test('project and portable ZIP preserve detail and private local data without remote assets',async({page})=>{
 await ready(page);await page.locator('#save').click();
 let p=page.waitForEvent('download');await page.locator('#save-project').click();let download=await p;const project=JSON.parse(await readFile((await download.path())!,'utf8'));expect(project.version).toBe(1);expect(project.scenery.features.length).toBeGreaterThan(0);expect(project.photos).toHaveLength(0);
 p=page.waitForEvent('download');await page.locator('#save-viewer').click();download=await p;const zip=unzipSync(new Uint8Array(await readFile((await download.path())!)));for(const name of ['models/trail-assets.glb','models/trail-assets-low.glb','data/sample-features.json','data/project.json','index.html'])expect(zip[name]?.length).toBeGreaterThan(0);
 expect(JSON.parse(new TextDecoder().decode(zip['data/project.json'])).scenery).toEqual(project.scenery);
 await page.locator('[data-close="export-dialog"]').click();
 await page.locator('#project-file').setInputFiles({name:'roundtrip.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});await expect(page.locator('#notice')).toContainText('保存した記録を開きました');
 await page.locator('#gpx-file').setInputFiles({name:'local.gpx',mimeType:'application/gpx+xml',buffer:Buffer.from('<gpx><trk><name>Private local route</name><trkseg><trkpt lat="34.6657" lon="135.1117"/><trkpt lat="34.6658" lon="135.1118"/></trkseg></trk></gpx>')});
 await expect(page.locator('#route-name')).toHaveText('Private local route');expect((await snapshot(page)).detail.trees).toBe(0);await expect(page.locator('[data-focus="forest"]')).toBeDisabled();
});
test('mobile layout keeps quality and controls usable without overflow',async({browser})=>{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});const page=await context.newPage();await ready(page);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);for(const q of ['low','standard','high']){await page.locator(`[data-quality="${q}"]`).tap();expect((await snapshot(page)).quality).toBe(q);}
 await page.screenshot({path:'test-results/mobile-high.png'});await context.close();
});

test('a missing model is surfaced without losing the real DEM',async({page})=>{
 await page.route('**/models/trail-assets.glb',route=>route.abort());await page.goto('/');await expect(page.locator('#loading')).toBeHidden();await expect(page.locator('#coverage')).toBeHidden();await expect(page.locator('#notice')).toContainText('地物モデルを読み込めませんでした',{timeout:15000});await page.locator('[data-quality="low"]').click();expect((await snapshot(page)).quality).toBe('low');
});
