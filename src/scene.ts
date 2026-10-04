import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createProjection, horizontalDistance, pointAtDistance, projectPoint,
  routeStats, terrainElevation,
} from './core';
import type { GeoPoint, TerrainData, Track } from './core';

export type ViewMode = 'orbit' | 'walk' | 'overhead';
export type TerrainPeak = { name: string; lat: number; lon: number; elevation?: number };
export type TrailPhoto = { id: string; name: string; lat: number; lon: number; url: string };
type Projection = ReturnType<typeof createProjection>;
type Label = { element: HTMLElement; position: THREE.Vector3; kind: 'peak' | 'photo' | 'cardinal' };
type RouteSample = { position: THREE.Vector3; distance: number };

const clamp = THREE.MathUtils.clamp;
const PALETTE = [
  new THREE.Color('#8fafa1'), new THREE.Color('#769880'),
  new THREE.Color('#65846a'), new THREE.Color('#9fa184'), new THREE.Color('#d9c9a1'),
];

/** Arc-length polyline lookup is O(log n), including for 50,000-point GPX files. */
class RouteCurve extends THREE.Curve<THREE.Vector3> {
  private lengths: number[] = [0];
  private total = 0;
  constructor(private points: THREE.Vector3[]) {
    super();
    for (let i = 1; i < points.length; i++) {
      this.total += points[i].distanceTo(points[i - 1]);
      this.lengths.push(this.total);
    }
  }
  getLength(): number { return this.total; }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const distance = clamp(t, 0, 1) * this.total;
    let low = 1; let high = this.lengths.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.lengths[mid] < distance) low = mid + 1;
      else high = mid;
    }
    const length = this.lengths[low] - this.lengths[low - 1];
    const fraction = length > 0 ? (distance - this.lengths[low - 1]) / length : 0;
    return target.copy(this.points[low - 1]).lerp(this.points[low], fraction);
  }
  getPointAt(t: number, target = new THREE.Vector3()): THREE.Vector3 { return this.getPoint(t, target); }
  getTangentAt(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const delta = Math.min(0.001, 1 / Math.max(this.points.length, 1));
    const before = this.getPoint(Math.max(0, t - delta));
    const after = this.getPoint(Math.min(1, t + delta));
    return target.copy(after).sub(before).normalize();
  }
}

/** Offline-only, meter-scale terrain diorama. The DEM is never vertically exaggerated. */
export class TrailScene {
  public onPhotoSelect?: (id: string) => void;
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.5, 60000);
  private controls: OrbitControls;
  private terrainGroup = new THREE.Group();
  private routeGroup = new THREE.Group();
  private walkingRouteGroup = new THREE.Group();
  private markerGroup = new THREE.Group();
  private labelRoot: HTMLDivElement;
  private labels: Label[] = [];
  private terrainMesh?: THREE.Mesh;
  private data?: TerrainData;
  private track?: Track;
  private projection?: Projection;
  private peaks: TerrainPeak[] = [];
  private photos: TrailPhoto[] = [];
  private samples: RouteSample[] = [];
  private walker: THREE.Group;
  private light: THREE.DirectionalLight;
  private resizeObserver: ResizeObserver;
  private mode: ViewMode = 'orbit';
  private quality: 'low' | 'high' = 'high';
  private distance = 0;
  private routeLength = 0;
  private width = 1;
  private height = 1;
  private span = 4000;
  private centerY = 0;
  private desiredPosition = new THREE.Vector3();
  private desiredTarget = new THREE.Vector3();
  private currentTarget = new THREE.Vector3();
  private transition = false;
  private animationFrame = 0;
  private lastTime = 0;
  private disposed = false;
  private raycaster = new THREE.Raycaster();
  private pointerStart = { x: 0, y: 0 };
  private onProgress?: (distance: number) => void;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(container: HTMLElement, onProgress?: (distance: number) => void) {
    this.container = container;
    this.onProgress = onProgress;
    // A context failure is intentionally surfaced to the app's accessible fallback.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor('#e9eeea', 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'terrain-canvas';
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D terrain. Drag to rotate, scroll to zoom. Use the view buttons for route-following and map views.');
    Object.assign(this.renderer.domElement.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
    container.appendChild(this.renderer.domElement);

    this.labelRoot = document.createElement('div');
    this.labelRoot.className = 'terrain-labels';
    Object.assign(this.labelRoot.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none' });
    container.appendChild(this.labelRoot);

    this.scene.add(this.terrainGroup, this.routeGroup, this.walkingRouteGroup, this.markerGroup);
    this.walkingRouteGroup.visible = false;
    this.scene.add(new THREE.HemisphereLight('#fbf5df', '#617c71', 2.2));
    this.light = new THREE.DirectionalLight('#fff3d5', 3.2);
    this.light.position.set(-2500, 4000, 1500);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.normalBias = 4;
    this.light.shadow.bias = -0.00012;
    this.scene.add(this.light, this.light.target);
    const fill = new THREE.DirectionalLight('#cfdfeb', 1.05);
    fill.position.set(2000, 1200, -2200);
    this.scene.add(fill);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI / 2.12;
    this.controls.minPolarAngle = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.8;
    this.controls.addEventListener('start', this.stopTransition);
    this.camera.position.set(3600, 3000, 4200);
    this.controls.update();
    this.walker = this.createWalker();
    this.scene.add(this.walker);
    this.walker.visible = false;
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  setTerrain(data: TerrainData): void {
    if (data.cols < 2 || data.rows < 2 || data.heights.length !== data.cols * data.rows) {
      throw new Error('Terrain grid is incomplete.');
    }
    this.data = data;
    this.projection = createProjection(data);
    this.clearGroup(this.terrainGroup);
    const sw = projectPoint({ lat: data.bounds.south, lon: data.bounds.west }, this.projection);
    const ne = projectPoint({ lat: data.bounds.north, lon: data.bounds.east }, this.projection);
    const width = ne.x - sw.x;
    const depth = sw.z - ne.z;
    this.span = Math.max(width, depth);
    this.centerY = (data.min + data.max) * 0.33;
    const floor = Math.min(data.min - this.span * 0.017, -this.span * 0.012);
    const cols = data.cols;
    const rows = data.rows;
    const positions = new Float32Array(cols * rows * 3);
    const colors = new Float32Array(cols * rows * 3);
    const indices: number[] = [];
    const c = new THREE.Color();
    const range = Math.max(data.max - data.min, 1);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const y = Number.isFinite(data.heights[i]) ? data.heights[i] : data.min;
        positions[i * 3] = sw.x + width * col / (cols - 1);
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = sw.z - depth * row / (rows - 1);
        const level = clamp((y - data.min) / range, 0, 1) * (PALETTE.length - 1);
        const stop = Math.min(Math.floor(level), PALETTE.length - 2);
        c.copy(PALETTE[stop]).lerp(PALETTE[stop + 1], level - stop);
        // Small-scale shading comes from the real slope, never invented relief.
        const west = data.heights[row * cols + Math.max(col - 1, 0)];
        const east = data.heights[row * cols + Math.min(col + 1, cols - 1)];
        const south = data.heights[Math.max(row - 1, 0) * cols + col];
        const north = data.heights[Math.min(row + 1, rows - 1) * cols + col];
        const gradient = Math.hypot((east - west) / (2 * width / (cols - 1)), (north - south) / (2 * depth / (rows - 1)));
        c.lerp(new THREE.Color('#b7b69b'), clamp(gradient - 0.6, 0, 0.45));
        c.toArray(colors, i * 3);
        if (row < rows - 1 && col < cols - 1) {
          const a = i; const b = i + 1; const d = i + cols; const e = d + 1;
          indices.push(a, b, d, b, e, d);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    material.onBeforeCompile = shader => {
      shader.vertexShader = 'varying float vTerrainElevation;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainElevation = position.y;');
      shader.fragmentShader = 'varying float vTerrainElevation;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        float contourCoord = vTerrainElevation / 25.0;
        float contourDistance = abs(fract(contourCoord - 0.5) - 0.5);
        float contourWidth = max(fwidth(contourCoord), 0.008);
        float contour = 1.0 - smoothstep(contourWidth * 0.3, contourWidth * 1.0, contourDistance);
        float majorCoord = vTerrainElevation / 100.0;
        float majorDistance = abs(fract(majorCoord - 0.5) - 0.5);
        float majorWidth = max(fwidth(majorCoord), 0.004);
        float major = 1.0 - smoothstep(majorWidth * 0.3, majorWidth * 1.3, majorDistance);
        float edgeFade = 1.0 - smoothstep(0.2, 0.65, fwidth(contourCoord));
        diffuseColor.rgb *= 1.0 - (contour * 0.105 + major * 0.06) * edgeFade;
      `);
    };
    material.customProgramCacheKey = () => 'true-dem-contours-v1';
    const terrain = new THREE.Mesh(geometry, material);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    this.terrainMesh = terrain;
    this.terrainGroup.add(terrain);

    // The cut faces follow the boundary samples exactly; no skirt floats above the DEM.
    const edgeIndices: number[] = [];
    for (let col = 0; col < cols; col++) edgeIndices.push(col);
    for (let row = 1; row < rows; row++) edgeIndices.push(row * cols + cols - 1);
    for (let col = cols - 2; col >= 0; col--) edgeIndices.push((rows - 1) * cols + col);
    for (let row = rows - 2; row > 0; row--) edgeIndices.push(row * cols);
    const edgePositions: number[] = [];
    const edgeColors: number[] = [];
    const upper = new THREE.Color('#748479');
    const lower = new THREE.Color('#344f46');
    for (let i = 0; i < edgeIndices.length; i++) {
      const a = edgeIndices[i] * 3;
      const b = edgeIndices[(i + 1) % edgeIndices.length] * 3;
      const p1 = [positions[a], positions[a + 1], positions[a + 2]];
      const p2 = [positions[b], positions[b + 1], positions[b + 2]];
      const p3 = [positions[a], floor, positions[a + 2]];
      const p4 = [positions[b], floor, positions[b + 2]];
      edgePositions.push(...p1, ...p3, ...p2, ...p2, ...p3, ...p4);
      for (const color of [upper, lower, upper, upper, lower, lower]) edgeColors.push(color.r, color.g, color.b);
    }
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(edgeColors, 3));
    edgeGeometry.computeVertexNormals();
    const edge = new THREE.Mesh(edgeGeometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    edge.castShadow = true;
    this.terrainGroup.add(edge);
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(width, this.span * 0.005, depth), new THREE.MeshStandardMaterial({ color: '#344f46', roughness: 1 }));
    bottom.position.y = floor - this.span * 0.0025;
    bottom.castShadow = true;
    this.terrainGroup.add(bottom);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(this.span * 12, this.span * 12), new THREE.ShadowMaterial({ color: '#354e42', opacity: 0.12 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = floor - this.span * 0.019;
    ground.receiveShadow = true;
    this.terrainGroup.add(ground);

    this.light.position.set(-this.span * 0.5, this.span * 1.2, this.span * 0.45);
    this.light.target.position.set(0, this.centerY, 0);
    const shadowCamera = this.light.shadow.camera;
    shadowCamera.left = shadowCamera.bottom = -this.span * 0.8;
    shadowCamera.right = shadowCamera.top = this.span * 0.8;
    shadowCamera.near = 1;
    shadowCamera.far = this.span * 4;
    shadowCamera.updateProjectionMatrix();
    this.light.shadow.normalBias = this.span * 0.00065;
    this.controls.minDistance = Math.max(100, this.span * 0.08);
    this.controls.maxDistance = this.span * 4;
    this.camera.far = this.span * 15;
    this.camera.updateProjectionMatrix();
    this.rebuildRoute();
    this.rebuildLabels();
    this.reset();
  }

  setTrack(track: Track): void {
    this.track = track;
    this.routeLength = routeStats(track).distance;
    this.distance = 0;
    this.rebuildRoute();
    this.setDistance(0);
  }

  setPeaks(peaks: TerrainPeak[]): void { this.peaks = peaks; this.rebuildLabels(); }
  setPhotos(photos: TrailPhoto[]): void { this.photos = photos; this.rebuildLabels(); }

  setMode(mode: ViewMode): void {
    if (mode === this.mode && this.data) return;
    this.mode = mode;
    this.routeGroup.visible = mode !== 'walk';
    this.walkingRouteGroup.visible = mode === 'walk';
    this.camera.near = mode === 'walk' ? 0.05 : 0.5;
    this.controls.enabled = mode === 'orbit';
    this.camera.up.set(0, 1, 0);
    this.camera.fov = mode === 'walk' ? 60 : 38;
    this.camera.updateProjectionMatrix();
    this.walker.visible = !!this.track && this.contains(this.currentPoint()) && mode !== 'walk';
    if (mode === 'walk') {
      this.updateWalkCamera();
    } else if (mode === 'overhead') {
      this.camera.up.set(0, 0, -1);
      this.desiredPosition.set(0, this.centerY + this.span * (this.width / this.height < 1 ? 2.4 : 1.75), 0.01);
      this.desiredTarget.set(0, this.centerY, 0);
      this.transition = true;
    } else {
      this.setOrbitCamera();
    }
  }

  setDistance(meters: number): void {
    this.distance = clamp(Number.isFinite(meters) ? meters : 0, 0, this.routeLength);
    if (!this.track || !this.projection) return;
    const point = this.currentPoint();
    if (!point || !this.contains(point)) { this.walker.visible = false; return; }
    const p = this.worldPosition(point, 5);
    this.walker.position.copy(p);
    this.walker.visible = this.mode !== 'walk';
    if (this.mode === 'walk') this.updateWalkCamera();
  }

  setQuality(quality: 'low' | 'high'): void {
    this.quality = quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : 2));
    this.renderer.shadowMap.enabled = quality === 'high';
    this.terrainGroup.traverse(object => {
      if (object instanceof THREE.Mesh) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => { material.needsUpdate = true; });
      }
    });
    this.resize();
  }

  reset(): void {
    this.mode = 'orbit';
    this.routeGroup.visible = true;
    this.walkingRouteGroup.visible = false;
    this.camera.near = 0.5;
    this.controls.enabled = true;
    this.camera.up.set(0, 1, 0);
    this.camera.fov = 38;
    this.camera.updateProjectionMatrix();
    this.setOrbitCamera();
    this.camera.position.copy(this.desiredPosition);
    this.controls.target.copy(this.desiredTarget);
    this.currentTarget.copy(this.desiredTarget);
    this.controls.update();
    this.transition = false;
    this.setDistance(this.distance);
  }

  capture(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('start', this.stopTransition);
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.pointerUp);
    this.clearGroup(this.terrainGroup);
    this.clearGroup(this.routeGroup);
    this.clearGroup(this.walkingRouteGroup);
    this.clearGroup(this.markerGroup);
    this.clearGroup(this.walker);
    this.light.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRoot.remove();
  }

  private contains(point?: GeoPoint): boolean {
    if (!point || !this.data) return false;
    const b = this.data.bounds;
    return point.lat >= b.south && point.lat <= b.north && point.lon >= b.west && point.lon <= b.east;
  }

  private currentPoint(): GeoPoint | undefined {
    if (!this.track || !this.track.segments.some(segment => segment.length)) return undefined;
    return pointAtDistance(this.track, this.distance).point;
  }

  private worldPosition(point: GeoPoint, lift = 0): THREE.Vector3 {
    const projected = projectPoint(point, this.projection!);
    const elevation = this.contains(point) ? this.surfaceElevation(point) : (point.elevation ?? 0);
    return new THREE.Vector3(projected.x, elevation + lift, projected.z);
  }

  /** Matches the rendered triangle interpolation, so a 2 m camera never enters a ridge. */
  private surfaceElevation(point: GeoPoint): number {
    const data = this.data!;
    const x = clamp((point.lon - data.bounds.west) / (data.bounds.east - data.bounds.west) * (data.cols - 1), 0, data.cols - 1);
    const z = clamp((point.lat - data.bounds.south) / (data.bounds.north - data.bounds.south) * (data.rows - 1), 0, data.rows - 1);
    const col = Math.min(Math.floor(x), data.cols - 2);
    const row = Math.min(Math.floor(z), data.rows - 2);
    const u = x - col; const v = z - row;
    const a = data.heights[row * data.cols + col];
    const b = data.heights[row * data.cols + col + 1];
    const d = data.heights[(row + 1) * data.cols + col];
    const e = data.heights[(row + 1) * data.cols + col + 1];
    return u + v <= 1 ? a + (b - a) * u + (d - a) * v : e + (d - e) * (1 - u) + (b - e) * (1 - v);
  }

  private rebuildRoute(): void {
    this.clearGroup(this.routeGroup);
    this.clearGroup(this.walkingRouteGroup);
    this.samples = [];
    if (!this.track || !this.data || !this.projection) return;
    const radius = clamp(this.span / 1500, 2.2, 6);
    const lift = radius * 1.1 + 0.8;
    const sampleSpacing = Math.max(10, this.span / 500, this.routeLength / 30000);
    const routeMaterial = new THREE.MeshStandardMaterial({ color: '#fb714f', emissive: '#a83d26', emissiveIntensity: 0.22, roughness: 0.7 });
    const underMaterial = new THREE.MeshBasicMaterial({ color: '#fff0d7', transparent: true, opacity: 0.78 });
    let cumulative = 0;
    let first: THREE.Vector3 | undefined;
    let last: THREE.Vector3 | undefined;
    const chunks: THREE.Vector3[][] = [];
    for (const segment of this.track.segments) {
      let chunk: THREE.Vector3[] = [];
      for (let i = 0; i < segment.length; i++) {
        const a = segment[Math.max(0, i - 1)];
        const b = segment[i];
        const length = i === 0 ? 0 : horizontalDistance(a, b);
        const steps = i === 0 ? 1 : Math.max(1, Math.min(30000, Math.ceil(length / sampleSpacing)));
        for (let step = 1; step <= steps; step++) {
          const t = i === 0 ? 0 : step / steps;
          const point = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
          if (!this.contains(point)) {
            if (chunk.length > 1) chunks.push(chunk);
            chunk = [];
            continue;
          }
          const position = this.worldPosition(point, lift);
          const d = cumulative + length * t;
          if (!first) first = position.clone();
          last = position.clone();
          const previous = chunk[chunk.length - 1];
          if (!previous || previous.distanceTo(position) > 0.3) {
            chunk.push(position);
            this.samples.push({ position, distance: d });
          }
        }
        cumulative += length;
      }
      if (chunk.length > 1) chunks.push(chunk);
    }
    for (const chunk of chunks) {
      const groundPositions = chunk.map(point => new THREE.Vector3(point.x, point.y - lift + 0.24, point.z));
      const groundTrace = new THREE.Line(new THREE.BufferGeometry().setFromPoints(groundPositions), new THREE.LineBasicMaterial({ color: '#f57750', transparent: true, opacity: 0.85 }));
      this.walkingRouteGroup.add(groundTrace);
      // A piecewise linear curve preserves the supplied route and never bridges GPX segments.
      const path = new RouteCurve(chunk);
      const steps = Math.min(12000, Math.max(chunk.length * 2, Math.ceil(path.getLength() / 8)));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(path, steps, radius, 6, false), routeMaterial);
      tube.renderOrder = 3;
      this.routeGroup.add(tube);
      const under = new THREE.Mesh(new THREE.TubeGeometry(path, steps, radius * 1.38, 6, false), underMaterial);
      under.position.y = -radius * 0.6;
      under.renderOrder = 2;
      this.routeGroup.add(under);
    }
    // Materials not used by a mesh also need disposal when the route is empty.
    if (!chunks.length) { routeMaterial.dispose(); underMaterial.dispose(); }
    if (first) this.addEndpoint(first, '#fcf8ea', '#466458', radius * 2.4);
    if (last && first && last.distanceTo(first) > radius * 6) this.addEndpoint(last, '#fff3de', '#ed7351', radius * 2.4);
    this.walker.scale.setScalar(Math.max(0.75, this.span / 4500));
    this.setDistance(this.distance);
  }

  private addEndpoint(position: THREE.Vector3, outer: string, inner: string, size: number): void {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(size, size, size * 0.45, 24), new THREE.MeshStandardMaterial({ color: outer, roughness: 0.8 }));
    ring.position.copy(position);
    ring.position.y += size * 0.3;
    this.routeGroup.add(ring);
    const center = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.57, size * 0.57, size * 0.5, 20), new THREE.MeshStandardMaterial({ color: inner, roughness: 0.8 }));
    center.position.copy(ring.position);
    center.position.y += size * 0.1;
    this.routeGroup.add(center);
  }

  private rebuildLabels(): void {
    this.clearGroup(this.markerGroup);
    this.labels = [];
    this.labelRoot.replaceChildren();
    if (!this.data || !this.projection) return;
    const peakRadius = clamp(this.span / 1800, 2, 5);
    for (const peak of this.peaks) {
      if (!this.contains(peak)) continue;
      const world = this.worldPosition(peak, 5);
      const marker = new THREE.Mesh(new THREE.ConeGeometry(peakRadius * 1.7, peakRadius * 3, 3), new THREE.MeshStandardMaterial({ color: '#ffecd0', roughness: 0.9 }));
      marker.position.copy(world);
      marker.position.y += peakRadius;
      this.markerGroup.add(marker);
      const label = this.createLabel('peak');
      const name = document.createElement('span');
      name.textContent = peak.name;
      Object.assign(name.style, { fontWeight: '600', letterSpacing: '0.025em' });
      const height = document.createElement('span');
      height.textContent = `${Math.round(peak.elevation ?? terrainElevation(this.data, peak.lat, peak.lon))} m`;
      Object.assign(height.style, { color: '#66766a', fontSize: '10px', marginLeft: '7px', fontVariantNumeric: 'tabular-nums' });
      label.append(name, height);
      this.labels.push({ element: label, position: world.clone().add(new THREE.Vector3(0, 15, 0)), kind: 'peak' });
    }
    for (const photo of this.photos) {
      if (!this.contains(photo)) continue;
      const world = this.worldPosition(photo, 6);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(peakRadius * 0.25, peakRadius * 0.25, peakRadius * 7, 6), new THREE.MeshBasicMaterial({ color: '#e16a49' }));
      stem.position.copy(world);
      stem.position.y += peakRadius * 3.5;
      this.markerGroup.add(stem);
      const label = this.createLabel('photo');
      const button = document.createElement('button');
      button.type = 'button';
      button.title = photo.name;
      button.setAttribute('aria-label', `View photo: ${photo.name}`);
      Object.assign(button.style, { pointerEvents: 'auto', cursor: 'pointer', border: '2px solid #fff9ed', borderRadius: '9px', padding: '0', width: '38px', height: '38px', background: '#f47753', boxShadow: '0 3px 9px #29463833', overflow: 'hidden', display: 'block' });
      const img = document.createElement('img');
      if (/^(blob:|data:image\/|\.?\.?\/)/.test(photo.url)) img.src = photo.url;
      img.alt = '';
      Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
      button.append(img);
      button.addEventListener('click', event => { event.stopPropagation(); this.onPhotoSelect?.(photo.id); });
      label.append(button);
      this.labels.push({ element: label, position: world.clone().add(new THREE.Vector3(0, peakRadius * 8, 0)), kind: 'photo' });
    }
    const north = this.createLabel('cardinal');
    north.textContent = 'N';
    Object.assign(north.style, { fontSize: '11px', fontWeight: '700', color: '#75877c', background: 'transparent', boxShadow: 'none', border: 'none', letterSpacing: '0.18em' });
    const edge = projectPoint({ lat: this.data.bounds.north, lon: (this.data.bounds.east + this.data.bounds.west) / 2 }, this.projection);
    this.labels.push({ element: north, position: new THREE.Vector3(edge.x, this.data.min, edge.z - this.span * 0.035), kind: 'cardinal' });
  }

  private createLabel(kind: Label['kind']): HTMLDivElement {
    const element = document.createElement('div');
    element.className = `terrain-label terrain-label--${kind}`;
    Object.assign(element.style, { position: 'absolute', top: '0', left: '0', whiteSpace: 'nowrap', willChange: 'transform', fontFamily: 'inherit', fontSize: '11px', lineHeight: '1.25', color: '#3d5548', pointerEvents: 'none' });
    if (kind === 'peak') Object.assign(element.style, { padding: '5px 8px', borderRadius: '5px', background: 'rgba(250,250,238,.87)', boxShadow: '0 1px 5px #2d4f3f0d', border: '1px solid #ffffff70' });
    this.labelRoot.append(element);
    return element;
  }

  private createWalker(): THREE.Group {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(13, 2.4, 8, 32), new THREE.MeshBasicMaterial({ color: '#fff8e9' }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 2;
    group.add(ring);
    const body = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 12), new THREE.MeshStandardMaterial({ color: '#f76d48', emissive: '#b24025', emissiveIntensity: 0.3 }));
    body.position.y = 12;
    group.add(body);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 12, 8), new THREE.MeshBasicMaterial({ color: '#fff6dd' }));
    stem.position.y = 6;
    group.add(stem);
    return group;
  }

  private setOrbitCamera(): void {
    const fit = this.width / this.height < 0.9 ? 1.55 : 1;
    this.desiredPosition.set(this.span * 0.67 * fit, this.centerY + this.span * 0.75 * fit, this.span * 0.95 * fit);
    this.desiredTarget.set(0, this.centerY, 0);
    this.currentTarget.copy(this.controls.target);
    this.transition = true;
  }

  private updateWalkCamera(): void {
    if (!this.track || !this.projection || !this.data) return;
    const at = pointAtDistance(this.track, this.distance);
    if (!this.contains(at.point)) return;
    const current = this.worldPosition(at.point, 2.1);
    const bearing = at.bearing * Math.PI / 180;
    const direction = new THREE.Vector3(Math.sin(bearing), 0, -Math.cos(bearing));
    const ahead = pointAtDistance(this.track, Math.min(this.distance + 15, this.routeLength));
    // Never join GPX gaps. Parent-owned distance/replay is the only movement input.
    const target = ahead.segmentIndex === at.segmentIndex && this.contains(ahead.point)
      ? this.worldPosition(ahead.point, 2.1)
      : current.clone().addScaledVector(direction, 15);
    if (target.distanceTo(current) < 3) target.copy(current).addScaledVector(direction, 15);
    // Snap position to the route rather than interpolating a shortcut through the mountain.
    this.camera.position.copy(current);
    this.desiredPosition.copy(current);
    this.desiredTarget.copy(target);
    this.currentTarget.copy(target);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.transition = false;
  }

  private resize = (): void => {
    if (this.disposed) return;
    const wasPortrait = this.width / this.height < 0.9;
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    if (this.data && this.mode === 'orbit' && wasPortrait !== (this.width / this.height < 0.9)) this.setOrbitCamera();
  };

  private stopTransition = (): void => { this.transition = false; };
  private pointerDown = (event: PointerEvent): void => { this.pointerStart = { x: event.clientX, y: event.clientY }; };
  private pointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || this.mode === 'walk' || !this.terrainMesh || !this.samples.length || !this.onProgress) return;
    if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 6) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh)[0];
    if (!hit) return;
    let closest: RouteSample | undefined;
    let best = Infinity;
    for (const sample of this.samples) {
      const delta = sample.position.distanceToSquared(hit.point);
      if (delta < best) { best = delta; closest = sample; }
    }
    if (closest && best < (this.span * 0.035) ** 2) {
      this.setDistance(closest.distance);
      this.onProgress(closest.distance);
    }
  };

  private animate = (time: number): void => {
    if (this.disposed) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    if (this.quality === 'low' && time - this.lastTime < 30) return;
    const delta = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;
    if (this.transition) {
      const amount = this.reducedMotion ? 1 : 1 - Math.exp(-delta * (this.mode === 'walk' ? 6 : 4));
      this.camera.position.lerp(this.desiredPosition, amount);
      this.currentTarget.lerp(this.desiredTarget, amount);
      this.controls.target.copy(this.currentTarget);
      this.camera.lookAt(this.currentTarget);
      if (this.camera.position.distanceTo(this.desiredPosition) < 0.25 && this.currentTarget.distanceTo(this.desiredTarget) < 0.25) this.transition = false;
    }
    if (this.mode === 'orbit') this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  };

  private updateLabels(): void {
    const projected = new THREE.Vector3();
    const occupied: { x: number; y: number; w: number }[] = [];
    for (const label of this.labels) {
      projected.copy(label.position).project(this.camera);
      const x = (projected.x * 0.5 + 0.5) * this.width;
      const y = (-projected.y * 0.5 + 0.5) * this.height;
      const visible = projected.z > -1 && projected.z < 1 && x > 15 && x < this.width - 15 && y > 20 && y < this.height - 12;
      let hidden = !visible;
      if (visible && label.kind === 'peak') {
        const w = label.element.offsetWidth || 110;
        hidden = occupied.some(other => Math.abs(other.x - x) < (other.w + w) * 0.49 && Math.abs(other.y - y) < 27);
        if (!hidden) occupied.push({ x, y, w });
      }
      label.element.style.visibility = hidden ? 'hidden' : 'visible';
      label.element.style.transform = `translate(${x.toFixed(1)}px, ${(y - 9).toFixed(1)}px) translate(-50%, -100%)`;
      label.element.style.opacity = this.mode === 'walk' && label.kind === 'cardinal' ? '0' : '1';
    }
  }

  private clearGroup(group: THREE.Group): void {
    const materials = new Set<THREE.Material>();
    group.traverse(object => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => materials.add(material));
    });
    materials.forEach(material => material.dispose());
    group.clear();
  }
}
