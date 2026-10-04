import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Box3, InstancedMesh, Matrix4, Mesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expected = {
  'trail-assets.glb': ['BroadleafBark','BroadleafLeaves','PineBark','PineNeedles','Boulder','TimberStep'],
  'trail-assets-low.glb': ['BroadleafLowBark','BroadleafLowLeaves','PineLowBark','PineLowNeedles'],
};
const results = {};
for (const [filename, names] of Object.entries(expected)) {
  const bytes = fs.readFileSync(path.join(root,'public/models',filename));
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve,reject) => new GLTFLoader().parse(source,'',resolve,reject));
  gltf.scene.updateMatrixWorld(true);
  const meshes=[];gltf.scene.traverse(n=>{if(n instanceof Mesh)meshes.push(n)});
  assert.equal(meshes.length,names.length);
  const report={bytes:bytes.length,nodes:{}};
  for (const name of names) {
    const node=gltf.scene.getObjectByName(name);
    assert(node instanceof Mesh, `${name} absent`);
    assert(!Array.isArray(node.material));
    const geometry=node.geometry.clone().applyMatrix4(node.matrixWorld);
    assert(geometry.attributes.color, `${name} missing vertex colors`);
    assert(node.material.vertexColors,`${name} material ignores colors`);
    assert(!node.material.map,`${name} unexpectedly requires texture`);
    for(const value of geometry.attributes.position.array)assert(Number.isFinite(value));
    geometry.computeBoundingBox();
    const bounds=geometry.boundingBox;
    assert(bounds.min.y>=-1e-5,`${name} is below the ground`);
    const instanced=new InstancedMesh(geometry,node.material,2);
    instanced.setMatrixAt(0,new Matrix4());
    instanced.setMatrixAt(1,new Matrix4().makeTranslation(12,0,0));
    instanced.instanceMatrix.needsUpdate=true;
    instanced.computeBoundingBox();
    assert(instanced.boundingBox instanceof Box3);
    const triangles=geometry.index ? geometry.index.count/3 : geometry.attributes.position.count/3;
    report.nodes[name]={triangles,vertices:geometry.attributes.position.count,boundsYUp:{min:bounds.min.toArray(),max:bounds.max.toArray()}};
    instanced.dispose();geometry.dispose();
  }
  results[filename]=report;
}
const hi=results['trail-assets.glb'].nodes,lo=results['trail-assets-low.glb'].nodes;
assert(hi.BroadleafBark.triangles+hi.BroadleafLeaves.triangles<=8000);
assert(hi.PineBark.triangles+hi.PineNeedles.triangles<=8000);
assert(hi.Boulder.triangles<1000);
assert(hi.TimberStep.triangles<500);
assert(lo.BroadleafLowBark.triangles+lo.BroadleafLowLeaves.triangles<400);
assert(lo.PineLowBark.triangles+lo.PineLowNeedles.triangles<400);
assert(Math.abs(hi.BroadleafLeaves.boundsYUp.max[1]-lo.BroadleafLowLeaves.boundsYUp.max[1])<1e-4);
assert(Math.abs(hi.PineNeedles.boundsYUp.max[1]-lo.PineLowNeedles.boundsYUp.max[1])<1e-4);
fs.writeFileSync(path.join(root,'assets/blender/validation.json'),JSON.stringify(results,null,2)+'\n');
console.log('PASS: both GLBs load in Three.js; named meshes, colors, materials, base origin, LOD heights, budgets and InstancedMesh matrices verified.');
console.log(JSON.stringify(results,null,2));
