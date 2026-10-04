import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createDetailPlan, QUALITY, type DetailPlan, type Placement, type Quality, type SceneryData } from './detail';
import type { TerrainData, Track } from './core';

type Part = { geometry: THREE.BufferGeometry; material: THREE.Material };
type Batch = { mesh: THREE.InstancedMesh; placements: Placement[]; near: boolean; species?: number };
/** Original Blender assets, instanced in bounded batches; close geometry replaces far geometry. */
export class SceneryLayer {
  readonly group = new THREE.Group();
  private assets?: Map<string,Part>;
  private loading?: Promise<void>;
  private plan?: DetailPlan;
  private quality:Quality='standard';
  private batches:Batch[]=[];
  private disposed=false;
  private lastLOD=-Infinity;
  private dummy=new THREE.Object3D();
  private lastCamera=new THREE.Vector3(Infinity,Infinity,Infinity);
  onStatus?:(message:string)=>void;
  constructor(){this.group.name='Illustrative Blender surface details';}
  setData(data:TerrainData,scenery:SceneryData|undefined,track?:Track){this.plan=scenery?createDetailPlan(data,scenery,track):undefined;this.rebuild();}
  setQuality(quality:Quality){this.quality=quality;this.rebuild();}
  get stats(){return {quality:this.quality,trees:Math.min(this.plan?.trees.length??0,QUALITY[this.quality].trees),rocks:Math.min(this.plan?.rocks.length??0,QUALITY[this.quality].rocks),steps:this.quality==='low'?0:this.plan?.steps.length??0,loaded:!!this.assets,nearTrees:this.batches.filter(b=>b.near&&b.mesh.name.includes('Bark')).reduce((sum,b)=>sum+b.mesh.count,0)};}
  private load(){
    if(this.loading)return this.loading;
    const loader=new GLTFLoader();
    this.loading=Promise.all(['trail-assets-low.glb','trail-assets.glb'].map(file=>loader.loadAsync(new URL(`./models/${file}`,location.href).href))).then(models=>{
      const assets=new Map<string,Part>();
      for(const model of models){model.scene.updateMatrixWorld(true);model.scene.traverse(node=>{if(node instanceof THREE.Mesh){const geometry=node.geometry.clone();geometry.applyMatrix4(node.matrixWorld);const source=Array.isArray(node.material)?node.material[0]:node.material;assets.set(node.name,{geometry,material:source.clone()});node.geometry.dispose();}});const materials=new Set<THREE.Material>();model.scene.traverse(n=>{if(n instanceof THREE.Mesh)(Array.isArray(n.material)?n.material:[n.material]).forEach(m=>materials.add(m));});materials.forEach(m=>m.dispose());}
      const concrete=new RoundedBoxGeometry(1.35,.22,.47,1,.018);concrete.translate(0,.11,0);assets.set('ConcreteStep',{geometry:concrete,material:new THREE.MeshStandardMaterial({color:'#b4b4a7',roughness:.97})});
      if(this.disposed){assets.forEach(p=>{p.geometry.dispose();p.material.dispose();});return;}
      this.assets=assets;this.rebuild();this.onStatus?.('Blender地物を読み込みました。樹木の配置・岩の細部・段数は近似表現です。');
    }).catch(()=>{this.onStatus?.('地物モデルを読み込めませんでした。実DEMは表示できます。軽量モードか再読み込みをお試しください。');this.loading=undefined;});
    return this.loading;
  }
  private clear(){for(const b of this.batches)b.mesh.dispose();this.batches=[];this.group.clear();}
  private rebuild(){
    this.clear();this.lastLOD=-Infinity;this.lastCamera.set(Infinity,Infinity,Infinity);
    if(!this.plan||this.quality==='low')return;
    if(!this.assets){void this.load();return;}
    const q=QUALITY[this.quality],trees=this.plan.trees.slice(0,q.trees);
    for(const [species,prefix] of [[0,'Broadleaf'],[1,'Pine']] as const){
      const placements=trees.filter(t=>t.variant===species);
      const foliage=species===0?'Leaves':'Needles';
      for(const part of ['Bark',foliage]){
        this.add(prefix+'Low'+part,placements,false,species);
        if(q.nearTrees)this.add(prefix+part,placements,true,species);
      }
    }
    this.add('Boulder',this.plan.rocks.slice(0,q.rocks),false);
    this.add('TimberStep',this.plan.steps.filter(p=>p.variant===0),false);
    this.add('ConcreteStep',this.plan.steps.filter(p=>p.variant===1),false);
    this.update(new THREE.Vector3(Infinity,Infinity,Infinity),0);this.lastLOD=-Infinity;
  }
  private add(name:string,placements:Placement[],near:boolean,species?:number){
    const part=this.assets?.get(name);if(!part||!placements.length)return;
    const limit=near?Math.min(QUALITY[this.quality].nearTrees,placements.length):placements.length;
    const mesh=new THREE.InstancedMesh(part.geometry,part.material,limit);mesh.name=name+(near?'_near':'_far');mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;
    mesh.castShadow=this.quality==='high'&&(near||species===undefined);mesh.receiveShadow=true;mesh.count=near?0:limit;
    this.batches.push({mesh,placements,near,species});this.group.add(mesh);
  }
  update(camera:THREE.Vector3,time:number){
    if(!this.assets||this.quality==='low'||!this.plan)return;
    if(time-this.lastLOD<250&&this.lastLOD!==-Infinity)return;
    if(this.lastLOD!==-Infinity&&camera.distanceToSquared(this.lastCamera)<2)return;
    this.lastLOD=time;this.lastCamera.copy(camera);
    const q=QUALITY[this.quality],trees=this.plan.trees.slice(0,q.trees);
    const selected=new Set(trees.map(p=>({p,d:(p.x-camera.x)**2+(p.y+4-camera.y)**2+(p.z-camera.z)**2})).filter(v=>v.d<q.nearDistance**2).sort((a,b)=>a.d-b.d).slice(0,q.nearTrees).map(v=>v.p));
    for(const batch of this.batches){let index=0;for(const p of batch.placements){const detailed=selected.has(p);if(batch.species!==undefined&&(batch.near?!detailed:detailed))continue;
      this.dummy.position.set(p.x,p.y,p.z);this.dummy.rotation.set(0,p.rotation,0);this.dummy.scale.setScalar(p.scale);this.dummy.updateMatrix();batch.mesh.setMatrixAt(index++,this.dummy.matrix);
      if(index>=batch.mesh.instanceMatrix.count)break;
    }batch.mesh.count=index;batch.mesh.instanceMatrix.needsUpdate=true;}
  }
  dispose(){this.disposed=true;this.clear();this.assets?.forEach(p=>{p.geometry.dispose();p.material.dispose();});this.assets=undefined;}
}
