import { Curve, MathUtils, Vector3 } from 'three';

export const ROUTE_SEGMENT_LIMIT = 12000;
export const ROUTE_POINT_INSPECTION_LIMIT = 4_000_000;
export interface RouteChunk { sourceIndex: number; points: Vector3[] }
export interface RouteGeometryPlan {
  chunks: RouteChunk[];
  /** Largest input-vertex distance from its retained chord, in meters, excluding omitted chunks. */
  maxDeviation: number;
  omittedChunks: number;
  pointInspections: number;
  workLimited: boolean;
}

type Interval = { chunk: number; first: number; last: number; split: number; error: number };

/** Keep every vertex when it fits; otherwise spend the shared budget on the largest bends.
 * Over-budget routes are approximate, and their measured vertex deviation is reported.
 * Scanning also stops at a fixed work budget (after measuring every root interval once).
 * Each disconnected chunk costs at least one edge. If even that exceeds the cap, only the
 * longest chunks receive tubes; callers can still draw every original chunk as a line.
 */
export function sampleRouteGeometry(source: readonly Vector3[][], budget = ROUTE_SEGMENT_LIMIT): RouteGeometryPlan {
  const limit = Math.max(0, Math.min(ROUTE_SEGMENT_LIMIT, Math.floor(Number.isFinite(budget) ? budget : 0)));
  let chunks = source.map((points, sourceIndex) => ({ points, sourceIndex })).filter(chunk => chunk.points.length > 1);
  const omittedChunks = Math.max(0, chunks.length - limit);
  if (omittedChunks) {
    chunks = chunks.map(chunk => ({ ...chunk, length: chunk.points.reduce((sum, p, i) => sum + (i ? p.distanceTo(chunk.points[i - 1]) : 0), 0) }))
      .sort((a, b) => b.length - a.length || a.sourceIndex - b.sourceIndex).slice(0, limit)
      .sort((a, b) => a.sourceIndex - b.sourceIndex);
  }
  if (chunks.reduce((sum, chunk) => sum + chunk.points.length - 1, 0) <= limit) {
    return { chunks, maxDeviation: 0, omittedChunks, pointInspections: 0, workLimited: false };
  }

  // A max heap chooses globally by geometric error, rather than allocating scarce rings
  // by route length (which would starve a short, densely recorded switchback section).
  const heap: Interval[] = [];
  let pointInspections = 0;
  let workLimited = false;
  // Always measure every root once. Further scans have a deterministic cap, because
  // greedy farthest-point splits can otherwise repeatedly peel one vertex off a 50k path.
  const inspectionLimit = Math.max(ROUTE_POINT_INSPECTION_LIMIT, chunks.reduce((sum, chunk) => sum + Math.max(0, chunk.points.length - 2), 0));
  const push = (item: Interval) => {
    let i = heap.length;
    heap.push(item);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (heap[parent].error >= item.error) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = item;
  };
  const pop = (): Interval => {
    const item = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].error > heap[child].error) child++;
        if (last.error >= heap[child].error) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return item;
  };
  const add = (chunk: number, first: number, last: number) => {
    if (last - first < 2) return;
    const points = chunks[chunk].points, a = points[first], b = points[last];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    let split = -1, error = 0;
    for (let i = first + 1; i < last; i++) {
      pointInspections++;
      const p = points[i];
      const t = lengthSquared ? MathUtils.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / lengthSquared, 0, 1) : 0;
      const distanceSquared = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2 + (p.z - a.z - t * dz) ** 2;
      // Balance equally important zigzag vertices to avoid a quadratic chain of splits.
      if (distanceSquared > error || (distanceSquared === error && Math.abs(i - (first + last) / 2) < Math.abs(split - (first + last) / 2))) {
        split = i; error = distanceSquared;
      }
    }
    if (error > 0) push({ chunk, first, last, split, error });
  };
  const selected = chunks.map((chunk, i) => { add(i, 0, chunk.points.length - 1); return [0, chunk.points.length - 1]; });
  let edges = chunks.length;
  while (edges < limit && heap.length) {
    const next = heap[0];
    const childInspections = Math.max(0, next.split - next.first - 1) + Math.max(0, next.last - next.split - 1);
    if (pointInspections + childInspections > inspectionLimit) {
      // Do not remove this fully measured interval until both children can be scanned.
      // Its existing error remains exact for the retained chord, even when work stops.
      workLimited = true;
      break;
    }
    const item = pop();
    selected[item.chunk].push(item.split);
    add(item.chunk, item.first, item.split);
    add(item.chunk, item.split, item.last);
    edges++;
  }
  return {
    chunks: chunks.map((chunk, i) => ({ sourceIndex: chunk.sourceIndex, points: selected[i].sort((a, b) => a - b).map(index => chunk.points[index]) })),
    maxDeviation: Math.sqrt(heap[0]?.error ?? 0),
    omittedChunks,
    pointInspections,
    workLimited,
  };
}

/** TubeGeometry samples getPointAt(i / steps): map each sample to a retained vertex.
 * Arc-length resampling would shortcut corners again, even after choosing the right points.
 */
export class RouteCurve extends Curve<Vector3> {
  constructor(private readonly points: readonly Vector3[]) {
    super();
    if (points.length < 2) throw new Error('A route curve needs at least two points.');
  }
  getPoint(t: number, target = new Vector3()): Vector3 {
    const index = MathUtils.clamp(t, 0, 1) * (this.points.length - 1);
    const lower = Math.min(Math.floor(index), this.points.length - 2);
    return target.copy(this.points[lower]).lerp(this.points[lower + 1], index - lower);
  }
  getPointAt(t: number, target = new Vector3()): Vector3 { return this.getPoint(t, target); }
  getTangentAt(t: number, target = new Vector3()): Vector3 {
    const index = Math.round(MathUtils.clamp(t, 0, 1) * (this.points.length - 1));
    const before = this.points[Math.max(0, index - 1)], point = this.points[index], after = this.points[Math.min(this.points.length - 1, index + 1)];
    target.copy(after).sub(before);
    // An exact out-and-back has a zero centered tangent; use its outgoing leg.
    if (target.lengthSq() === 0) target.copy(after).sub(point);
    if (target.lengthSq() === 0) target.copy(point).sub(before);
    if (target.lengthSq() === 0) target.set(1, 0, 0);
    return target.normalize();
  }
}
