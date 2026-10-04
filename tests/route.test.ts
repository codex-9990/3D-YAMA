import { describe, expect, it } from 'vitest';
import { Line3, TubeGeometry, Vector3 } from 'three';
import { ROUTE_POINT_INSPECTION_LIMIT, ROUTE_SEGMENT_LIMIT, RouteCurve, sampleRouteGeometry } from '../src/route';

const edgeCount = (chunks: { points: Vector3[] }[]) => chunks.reduce((sum, chunk) => sum + chunk.points.length - 1, 0);
const zigzag = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => new Vector3(offset + i, 0, i % 2));

function tubeCenters(points: Vector3[]): Vector3[] {
  const geometry = new TubeGeometry(new RouteCurve(points), points.length - 1, .2, 6, false);
  const vertices = geometry.getAttribute('position');
  const centers = points.map((_, i) => {
    const center = new Vector3();
    // The seventh vertex repeats the first one to close the radial seam.
    for (let j = 0; j < 6; j++) center.add(new Vector3().fromBufferAttribute(vertices, i * 7 + j));
    return center.divideScalar(6);
  });
  expect(Array.from(vertices.array).every(Number.isFinite)).toBe(true);
  geometry.dispose();
  return centers;
}

describe('route tube sampling', () => {
  it('puts actual tube rings at every sub-4m switchback instead of flattening its peaks', () => {
    const original = zigzag(5);
    const result = sampleRouteGeometry([original]);
    expect(edgeCount(result.chunks)).toBe(4);
    expect(result.maxDeviation).toBe(0);
    const centers = tubeCenters(result.chunks[0].points);
    centers.forEach((center, i) => expect(center.distanceTo(original[i])).toBeLessThan(1e-6));
    expect(centers[1].z).toBeCloseTo(1);
    expect(centers[3].z).toBeCloseTo(1);
  });

  it('preserves a thousand-point dense track with ten-centimeter legs', () => {
    const original = Array.from({ length: 1000 }, (_, i) => new Vector3(i * .06, 0, (i % 2) * .08));
    const result = sampleRouteGeometry([original]);
    expect(edgeCount(result.chunks)).toBe(999);
    expect(result.maxDeviation).toBe(0);
    tubeCenters(result.chunks[0].points).forEach((center, i) => expect(center.distanceTo(original[i])).toBeLessThan(1e-5));
  });

  it('preserves unequal spacing, elevation bends and exact out-and-back vertices', () => {
    const original = [new Vector3(0, 0, 0), new Vector3(.7, 3, .2), new Vector3(0, 0, 0), new Vector3(20, 1, 0)];
    const result = sampleRouteGeometry([original]);
    tubeCenters(result.chunks[0].points).forEach((center, i) => expect(center.distanceTo(original[i])).toBeLessThan(1e-6));
  });

  it('preserves every vertex right up to the shared geometry cap', () => {
    const source = [zigzag(6001), zigzag(6001, 10000)];
    const result = sampleRouteGeometry(source);
    expect(edgeCount(result.chunks)).toBe(ROUTE_SEGMENT_LIMIT);
    expect(result.maxDeviation).toBe(0);
    result.chunks.forEach((chunk, i) => expect(chunk.points).toEqual(source[i]));
  });

  it('prioritizes short switchbacks over arbitrarily long straight runs when budget constrained', () => {
    const bends = zigzag(5);
    const straight = Array.from({ length: 100 }, (_, i) => new Vector3(i * 1000, 0, 100));
    const result = sampleRouteGeometry([straight, bends], 5);
    expect(edgeCount(result.chunks)).toBe(5);
    expect(result.chunks[0].points).toEqual([straight[0], straight.at(-1)]);
    expect(result.chunks[1].points).toEqual(bends);
    expect(result.maxDeviation).toBeCloseTo(0, 8);
  });

  it('caps a maximum-size dense GPX and reports the unavoidable geometric approximation', () => {
    const points = zigzag(50000);
    const start = performance.now();
    const result = sampleRouteGeometry([points]);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(edgeCount(result.chunks)).toBe(ROUTE_SEGMENT_LIMIT);
    expect(result.chunks[0].points[0]).toBe(points[0]);
    expect(result.chunks[0].points.at(-1)).toBe(points.at(-1));
    expect(result.maxDeviation).toBeGreaterThan(0);
    expect(result.maxDeviation).toBeLessThanOrEqual(1);
    expect(result.omittedChunks).toBe(0);
  });

  it('bounds adversarial nearly unequal zigzags while keeping the remaining deviation exact', () => {
    const points = Array.from({ length: 50000 }, (_, i) => new Vector3(i, 0, (i % 2 ? -1 : 1) * (1 - i / 50000)));
    const start = performance.now();
    const result = sampleRouteGeometry([points]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.pointInspections).toBeLessThanOrEqual(ROUTE_POINT_INSPECTION_LIMIT);
    expect(result.workLimited).toBe(true);
    expect(edgeCount(result.chunks)).toBeLessThanOrEqual(ROUTE_SEGMENT_LIMIT);
    const selected = result.chunks[0].points;
    expect(selected[0]).toBe(points[0]);
    expect(selected.at(-1)).toBe(points.at(-1));
    let deviation = 0;
    for (let i = 1; i < selected.length; i++) {
      const line = new Line3(selected[i - 1], selected[i]);
      for (let j = selected[i - 1].x; j <= selected[i].x; j++) {
        deviation = Math.max(deviation, line.closestPointToPoint(points[j], true, new Vector3()).distanceTo(points[j]));
      }
    }
    expect(result.maxDeviation).toBeCloseTo(deviation, 12);
  });

  it('reports the measured maximum deviation of source vertices from their retained chords', () => {
    const points = Array.from({ length: 200 }, (_, i) => new Vector3(i, Math.sin(i * .17) * 7, Math.sin(i * .31) * 3));
    const result = sampleRouteGeometry([points], 15);
    const selected = result.chunks[0].points;
    let deviation = 0;
    for (let i = 1; i < selected.length; i++) {
      const line = new Line3(selected[i - 1], selected[i]);
      for (let j = points.indexOf(selected[i - 1]); j <= points.indexOf(selected[i]); j++) {
        deviation = Math.max(deviation, line.closestPointToPoint(points[j], true, new Vector3()).distanceTo(points[j]));
      }
    }
    expect(result.maxDeviation).toBeCloseTo(deviation, 12);
  });

  it('keeps 1,000 disconnected dense GPX segments separate under one shared cap', () => {
    const source = Array.from({ length: 1000 }, (_, i) => zigzag(50, i * 100));
    const result = sampleRouteGeometry(source);
    expect(edgeCount(result.chunks)).toBe(ROUTE_SEGMENT_LIMIT);
    expect(result.chunks).toHaveLength(1000);
    for (const chunk of result.chunks) {
      const original = source[chunk.sourceIndex];
      expect(chunk.points[0]).toBe(original[0]);
      expect(chunk.points.at(-1)).toBe(original.at(-1));
      expect(chunk.points.every(point => original.includes(point))).toBe(true);
    }
  });

  it('keeps the hard cap even when clipping creates more disconnected chunks than available edges', () => {
    const source = Array.from({ length: 12001 }, (_, i) => [new Vector3(i * 10, 0, 0), new Vector3(i * 10 + (i ? 2 : 1), 0, 0)]);
    const result = sampleRouteGeometry(source);
    expect(edgeCount(result.chunks)).toBe(ROUTE_SEGMENT_LIMIT);
    expect(result.omittedChunks).toBe(1);
    expect(result.chunks[0].sourceIndex).toBe(1);
    for (const chunk of result.chunks) expect(chunk.points).toBe(source[chunk.sourceIndex]);
  });

  it('handles empty and zero-budget inputs without bridging or invalid curves', () => {
    expect(sampleRouteGeometry([[], [new Vector3()]])).toEqual({ chunks: [], maxDeviation: 0, omittedChunks: 0, pointInspections: 0, workLimited: false });
    expect(sampleRouteGeometry([zigzag(5)], 0)).toEqual({ chunks: [], maxDeviation: 0, omittedChunks: 1, pointInspections: 0, workLimited: false });
    const geometry = sampleRouteGeometry([zigzag(13001)], 50000);
    expect(edgeCount(geometry.chunks)).toBeLessThanOrEqual(ROUTE_SEGMENT_LIMIT);
  });
});
