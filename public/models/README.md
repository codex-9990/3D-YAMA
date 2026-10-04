# Trail model kit

Original procedural Blender geometry made for 3D-YAMA. No downloaded models, textures, photographs, or third-party asset packs are included. These files add no separate license grant; use is subject to the project's applicable terms. No external model or texture attribution is required.

The warm-temperate broadleaf tree, open-crowned Japanese-style pine, pale weathered boulder, and timber step are illustrative approximations. They are not a species survey, photogrammetry data, or measured reproductions of the actual trail, 馬の背 ridge, or real stairs.

- `trail-assets.glb`: 999,444 bytes; `BroadleafBark` + `BroadleafLeaves` (7,818 triangles, 8 m tall), `PineBark` + `PineNeedles` (7,122 triangles, 8.5 m tall), `Boulder` (320 triangles), `TimberStep` (216 triangles).
- `trail-assets-low.glb`: 19,736 bytes; `BroadleafLowBark` + `BroadleafLowLeaves` and `PineLowBark` + `PineLowNeedles` (300 triangles per complete tree). Heights match the detailed trees.

Load with Three.js `GLTFLoader`. All meshes use meters, Y-up, and a ground origin at (0, 0, 0), with identity node transforms. Each named node has one vertex-colored material and no textures. Foliage is double-sided. Keep the loaded material and apply identical instance matrices to each tree's bark/foliage pair. Each mesh is suitable for `InstancedMesh`; after populating matrices, update `instanceMatrix.needsUpdate`, bounding box, and bounding sphere. No Draco/Meshopt/image decoders or additional dependencies are needed. Do not apply a second Blender-to-Y-up rotation.

Timber local X is the cross-trail width (1.52 m), Y is height (about 0.226 m), and Z is depth (about 0.25 m). Route placement, scaling, LOD policy, terrain alignment, and collision belong to the application.

Editable `.blend`, deterministic generation script, visual preview, detailed load example, and validation results are in `assets/blender/` in the source repository. The exported assets were validated with the project's Three.js `GLTFLoader` and `InstancedMesh`; this verifies asset compatibility rather than overall app rendering or route accuracy.
