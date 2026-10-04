# Original trail assets

Original deterministic geometry authored in Blender for 3D-YAMA. This is an illustrative warm-temperate Japanese trail kit, not a botanical identification, site survey, photogrammetry scan, or measured reproduction of a real staircase or the 馬の背 ridge. No downloaded models, image textures, or external asset dependencies are used.

## Deliverables

- `../../public/models/trail-assets.glb`: detailed original meshes, about 1 MB total
- `../../public/models/trail-assets-low.glb`: distant-tree meshes, about 20 KB total
- `trail-assets.blend`: editable Blender 4.3.2 source, with named high/low collections
- `generate_trail_assets.py`: deterministic geometry/material/source/GLB generator
- `asset-preview.png`: lightweight Blender-rendered visual QA of the detailed kit
- `preview_assets.py`: optional contact-sheet renderer; does not change the saved source
- `asset-manifest.json`: generated Blender Z-up bounds and source geometry counts
- `validation.json`: actual Three.js-loaded Y-up bounds, counts, and bundle sizes
- `verify_assets.mjs`: GLTFLoader + InstancedMesh validation using the app's existing Three.js dependency

## Mesh contract

All GLB geometry is **Y-up, in meters, ground base at (0, 0, 0)**. The Blender source is Z-up, as usual. Exported glTF nodes have identity transforms. Do not rotate the exported geometry by another 90 degrees. Each node is a mesh with one material and vertex colors, no texture loading. Foliage materials are double-sided; bark, stone, and timber use opaque rough surfaces.

| GLB | Mesh node names | Triangles | Nominal height |
| --- | --- | ---: | ---: |
| detailed | `BroadleafBark` + `BroadleafLeaves` | 2,738 + 5,080 = 7,818 | 8.0 m |
| detailed | `PineBark` + `PineNeedles` | 1,670 + 5,452 = 7,122 | 8.5 m |
| detailed | `Boulder` | 320 | 0.882 m |
| detailed | `TimberStep` | 216 | 0.226 m |
| low | `BroadleafLowBark` + `BroadleafLowLeaves` | 92 + 208 = 300 | 8.0 m |
| low | `PineLowBark` + `PineLowNeedles` | 92 + 208 = 300 | 8.5 m |

The broadleaf has a tapered/ridged trunk, visible buttress roots, asymmetric limbs, twig shoots, and 2,540 individually oriented, gently bent lanceolate leaves. The pine uses a crooked tapering trunk, upswept lateral limbs and open, uneven needle fans rather than conical layers. The boulder has eroded irregular facets, mild striation, and subtle earthy/moss-toned lower variation. The step is a worn transverse timber beam with uneven edges, shallow top cracks, and two wooden stake heads. Timber local X is width (1.52 m), Y is height, and Z is depth (about 0.25 m).

## Three.js loading and instancing

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { InstancedMesh } from 'three';

const gltf = await new GLTFLoader().loadAsync('/models/trail-assets.glb');
gltf.scene.updateMatrixWorld(true);

function createInstances(nodeName, matrices) {
  const source = gltf.scene.getObjectByName(nodeName);
  if (!source?.isMesh) throw new Error(`Missing asset ${nodeName}`);
  // Baking matrixWorld is safe even if a future source adds a transform.
  const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
  const instances = new InstancedMesh(geometry, source.material, matrices.length);
  matrices.forEach((matrix, index) => instances.setMatrixAt(index, matrix));
  instances.instanceMatrix.needsUpdate = true;
  instances.computeBoundingBox();
  instances.computeBoundingSphere();
  return instances;
}

// Use the EXACT SAME per-tree matrices for bark and foliage.
scene.add(createInstances('BroadleafBark', broadleafMatrices));
scene.add(createInstances('BroadleafLeaves', broadleafMatrices));
```

- Reuse the loaded material, including vertex-color and foliage double-side settings. Replacing it with an unconfigured solid-color material loses the subtle asset colors.
- Use positive instance scales and rotation around Y; give paired tree parts identical transforms. Random yaw and modest width/height variation reduce repetition.
- Load the low GLB separately, selecting its own node names. Its tree top heights match the detailed versions exactly. Use detailed trees near the trail/camera and low trees where crowns occupy few pixels; the low crowns are intentionally coarse.
- These are standard GLBs. No Draco, Meshopt, KTX, image assets, network decoders, or new npm dependencies are required.
- Geometry is static and reusable by InstancedMesh. Wind animation is not embedded. Tree placement, terrain normal alignment, collision, route accuracy and rendering LOD selection remain application responsibilities.

## Reproduction and checks

From the repository root:

```sh
/usr/bin/blender -b --factory-startup -t 2 --python assets/blender/generate_trail_assets.py
node assets/blender/verify_assets.mjs
/usr/bin/blender -b assets/blender/trail-assets.blend -t 2 --python assets/blender/preview_assets.py
```

Validation confirms both GLBs parse with the app's GLTFLoader; all expected nodes exist; materials preserve vertex colors and need no textures; coordinates are finite and ground-clamped; low/high heights match; every mesh fits its triangle budget; and each mesh accepts InstancedMesh transforms and bound computation. The preview uses a tiny 12-sample CPU render with no denoiser dependency. Source generation does not run the app build, install anything, or access Git.
