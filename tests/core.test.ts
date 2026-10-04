// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  MAX_GPX_BYTES,
  createProjection,
  horizontalDistance,
  parseGPX,
  pointAtDistance,
  projectPoint,
  routeStats,
  segmentDistances,
  terrainElevation,
  trackBounds,
  unprojectPoint,
  validateTerrain,
  type TerrainData,
  type Track,
} from '../src/core';

const gpx = (inside: string) => `<gpx xmlns="http://www.topografix.com/GPX/1/1">${inside}</gpx>`;
const p = (lat = '35', lon = '135', extra = '') => `<trkpt lat="${lat}" lon="${lon}">${extra}</trkpt>`;
const path = (points = p() + p('35.001', '135.002')) => gpx(`<trk><name>Morning &amp; mountain</name><trkseg>${points}</trkseg></trk>`);
const fixture = (): TerrainData => ({
  id: 'test-grid', name: 'Test grid', bounds: { west: 135, south: 35, east: 135.02, north: 35.02 },
  cols: 2, rows: 2, heights: [0, 10, 20, 30], min: 0, max: 30,
  attribution: 'Test data', sourceUrls: ['https://example.com/dem'], license: 'CC0',
});
const segmented = (): Track => ({
  name: 'Two segments',
  segments: [
    [{ lat: 35, lon: 135, elevation: 100 }, { lat: 35, lon: 135.001, elevation: 120 }],
    [{ lat: 35.01, lon: 135, elevation: 1000 }, { lat: 35.01, lon: 135.001, elevation: 980 }],
  ],
});

describe('parseGPX', () => {
  it('reads names, coordinates, elevation and time', () => {
    const track = parseGPX(path(p('35', '135', '<ele>100.25</ele><time>2026-01-01T00:00:00Z</time>') + p('35.001', '135.002', '<ele>-2.5</ele>')));
    expect(track.name).toBe('Morning & mountain');
    expect(track.segments[0][0]).toEqual({ lat: 35, lon: 135, elevation: 100.25, time: '2026-01-01T00:00:00Z' });
  });
  it('supports routes and namespace prefixes', () => {
    const track = parseGPX('<g:gpx xmlns:g="http://www.topografix.com/GPX/1/0"><g:rte><g:name>Ridge</g:name><g:rtept lat="35" lon="135"/><g:rtept lat="35.001" lon="135"/></g:rte></g:gpx>');
    expect(track.name).toBe('Ridge');
    expect(track.segments[0]).toHaveLength(2);
  });
  it('supports bare GPX and preserves track/route gaps in document order', () => {
    const track = parseGPX(`<gpx><trk><trkseg>${p()}${p('35.001')}</trkseg><trkseg>${p('35.01')}${p('35.011')}</trkseg></trk><rte><rtept lat="35.02" lon="135"/><rtept lat="35.021" lon="135"/></rte></gpx>`);
    expect(track.name).toBe('Imported route');
    expect(track.segments.map(s => s.length)).toEqual([2, 2, 2]);
  });
  it('ignores empty segments and extension lookalikes', () => {
    const track = parseGPX(gpx(`<trk><trkseg/><trkseg>${p()}${p('35.001')}<extensions><trkpt lat="99" lon="99"/></extensions></trkseg></trk><extensions><trk><trkseg>${p('99')}</trkseg></trk></extensions>`));
    expect(track.segments).toHaveLength(1);
    expect(track.segments[0]).toHaveLength(2);
  });
  it.each([
    '', '<gpx><trk></gpx>', '<html/>', '<gpx xmlns="https://evil.example/gpx"/>',
    '<!DOCTYPE gpx><gpx/>', '<!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><gpx/>',
    '<!ENTITY evil "x"><gpx/>',
  ])('rejects malformed, non-GPX or declared entity content: %s', xml => {
    expect(() => parseGPX(xml)).toThrow();
  });
  it.each(['', 'NaN', 'Infinity', '91', '-91', '0x20', '35junk'])('rejects invalid latitude %s', lat => {
    expect(() => parseGPX(path(p(lat) + p('35.001')))).toThrow();
  });
  it.each(['', 'NaN', 'Infinity', '181', '-181', '0x20'])('rejects invalid longitude %s', lon => {
    expect(() => parseGPX(path(p('35', lon) + p('35.001')))).toThrow();
  });
  it('rejects missing coordinates, malformed elevation and timestamp', () => {
    expect(() => parseGPX(path('<trkpt lon="135"/>' + p()))).toThrow();
    expect(() => parseGPX(path(p('35', '135', '<ele/>') + p()))).toThrow();
    expect(() => parseGPX(path(p('35', '135', '<ele>3</ele><ele>4</ele>') + p()))).toThrow();
    expect(() => parseGPX(path(p('35', '135', '<time>yesterday</time>') + p()))).toThrow();
  });
  it('rejects missing paths and disconnected singleton-only paths', () => {
    expect(() => parseGPX(gpx('<wpt lat="35" lon="135"/>'))).toThrow(/two points/);
    expect(() => parseGPX(path(p()))).toThrow(/two points/);
    expect(() => parseGPX(gpx(`<trk><trkseg>${p()}</trkseg><trkseg>${p('35.001')}</trkseg></trk>`))).toThrow(/two points/);
  });
  it('rejects over 50,000 points', () => {
    expect(() => parseGPX(path(p().repeat(50_001)))).toThrow(/50,000/);
  }, 15_000);
  it('enforces UTF-8 byte size, not only string length', () => {
    expect(() => parseGPX(' '.repeat(MAX_GPX_BYTES + 1))).toThrow(/10 MB/);
    expect(() => parseGPX('山'.repeat(Math.ceil(MAX_GPX_BYTES / 3)))).toThrow(/10 MB/);
  });
  it('rejects overly large extents and antimeridian routes', () => {
    expect(() => parseGPX(path(p('35', '135') + p('36', '135')))).toThrow(/25 km/);
    expect(() => parseGPX(path(p('0', '179.999') + p('0', '-179.999')))).toThrow(/antimeridian/);
  });
});

describe('projection and distance', () => {
  it('projects the center at zero with x east, z south and round-trips', () => {
    const projection = createProjection(fixture());
    const origin = projectPoint({ lat: 35.01, lon: 135.01 }, projection);
    expect(origin.x).toBeCloseTo(0, 8);
    expect(origin.z).toBeCloseTo(0, 8);
    const point = { lat: 35.017, lon: 135.019 };
    const projected = projectPoint(point, projection);
    expect(projected.x).toBeGreaterThan(0);
    expect(projected.z).toBeLessThan(0);
    const recovered = unprojectPoint(projected.x, projected.z, projection);
    expect(recovered.lat).toBeCloseTo(point.lat, 10);
    expect(recovered.lon).toBeCloseTo(point.lon, 10);
  });
  it('supports track, bounds and center as projection sources', () => {
    const track = segmented();
    const bounds = trackBounds(track);
    expect(createProjection(track)).toEqual(createProjection(bounds));
    expect(createProjection({ lat: 35, lon: 135 }).lat).toBe(35);
    expect(() => trackBounds({ name: 'Empty', segments: [] })).toThrow();
  });
  it('measures horizontal great-circle distance and ignores elevation', () => {
    expect(horizontalDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111195.08, 1);
    expect(horizontalDistance({ lat: 35, lon: 135, elevation: 0 }, { lat: 35, lon: 135, elevation: 1000 })).toBe(0);
    expect(() => horizontalDistance({ lat: NaN, lon: 0 }, { lat: 0, lon: 0 })).toThrow();
    expect(() => unprojectPoint(Infinity, 0, createProjection({ lat: 0, lon: 0 }))).toThrow();
  });
});

describe('route statistics and playback', () => {
  it('never counts gaps as route distance or elevation gain', () => {
    const track = segmented();
    const stats = routeStats(track);
    const expected = track.segments.reduce((sum, segment) => sum + horizontalDistance(segment[0], segment[1]), 0);
    expect(stats).toEqual({ distance: expected, gain: 20, loss: 20, pointCount: 4, segmentCount: 2, minElevation: 100, maxElevation: 1000, hasElevation: true, elevationComplete: true });
    expect(stats.distance).toBeLessThan(200);
    const distances = segmentDistances(track);
    expect(distances[1].start).toBe(distances[0].end);
    expect(distances[0].cumulative[0]).toBe(0);
  });
  it('does not claim complete ascent for missing or partial elevation', () => {
    const noElevation: Track = { name: 'Flat', segments: [[{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }]] };
    expect(routeStats(noElevation).gain).toBeUndefined();
    expect(routeStats(noElevation).hasElevation).toBe(false);
    noElevation.segments[0][0].elevation = 10;
    expect(routeStats(noElevation).hasElevation).toBe(true);
    expect(routeStats(noElevation).elevationComplete).toBe(false);
    expect(routeStats(noElevation).gain).toBeUndefined();
  });
  it('interpolates location, height and bearing along one edge', () => {
    const track = segmented();
    const distance = horizontalDistance(track.segments[0][0], track.segments[0][1]);
    const result = pointAtDistance(track, distance / 2);
    expect(result.point.lat).toBe(35);
    expect(result.point.lon).toBeCloseTo(135.0005, 10);
    expect(result.point.elevation).toBeCloseTo(110);
    expect(result.bearing).toBeCloseTo(90, 2);
    expect(result.segmentIndex).toBe(0);
  });
  it('jumps across segment gaps, never interpolating through them', () => {
    const track = segmented();
    const firstLength = horizontalDistance(track.segments[0][0], track.segments[0][1]);
    expect(pointAtDistance(track, firstLength - 0.01).segmentIndex).toBe(0);
    expect(pointAtDistance(track, firstLength).segmentIndex).toBe(1);
    expect(pointAtDistance(track, firstLength).point.lat).toBe(35.01);
    expect(pointAtDistance(track, firstLength + 1).point.lat).toBe(35.01);
  });
  it('clamps endpoints, handles duplicate points and rejects bad seek values', () => {
    const track = segmented();
    expect(pointAtDistance(track, -100).point).toEqual(track.segments[0][0]);
    expect(pointAtDistance(track, 1e9).point).toEqual(track.segments[1][1]);
    expect(() => pointAtDistance(track, NaN)).toThrow();
    expect(() => pointAtDistance({ name: 'Empty', segments: [] }, 0)).toThrow();
    const repeated: Track = { name: 'Still', segments: [[], [{ lat: 35, lon: 135 }, { lat: 35, lon: 135 }]] };
    expect(pointAtDistance(repeated, 20)).toEqual({ point: { lat: 35, lon: 135 }, bearing: 0, segmentIndex: 1 });
    expect(routeStats(repeated).distance).toBe(0);
  });
  it('interpolates time only when both edge endpoints have it', () => {
    const track: Track = { name: 'Time', segments: [[{ lat: 35, lon: 135, time: '2026-01-01T00:00:00Z' }, { lat: 35, lon: 135.001, time: '2026-01-01T00:10:00Z' }]] };
    expect(pointAtDistance(track, routeStats(track).distance / 2).point.time).toBe('2026-01-01T00:05:00.000Z');
  });
});

describe('terrain validation and bilinear sampling', () => {
  it('returns a validated copy and preserves provenance', () => {
    const terrain = fixture();
    const result = validateTerrain(terrain);
    expect(result).toEqual(terrain);
    expect(result).not.toBe(terrain);
    expect(result.heights).not.toBe(terrain.heights);
  });
  it('samples all south/north corners and center with south→north rows', () => {
    const terrain = fixture();
    expect(terrainElevation(terrain, 35, 135)).toBe(0);
    expect(terrainElevation(terrain, 35, 135.02)).toBe(10);
    expect(terrainElevation(terrain, 35.02, 135)).toBe(20);
    expect(terrainElevation(terrain, 35.02, 135.02)).toBe(30);
    expect(terrainElevation(terrain, 35.01, 135.01)).toBeCloseTo(15, 8);
    expect(terrainElevation(terrain, 35.005, 135.015)).toBeCloseTo(12.5, 8);
  });
  it.each([[34.999, 135.01], [35.021, 135.01], [35.01, 134.999], [35.01, 135.021], [NaN, 135]])('rejects outside/invalid sample %s,%s', (lat, lon) => {
    expect(() => terrainElevation(fixture(), lat, lon)).toThrow();
  });
  it.each([
    null, [], {}, { cols: 1 }, { rows: 513 }, { rows: 2.5 }, { cols: '2' },
    { heights: [0, 10, 20] }, { heights: new Array(4) }, { heights: [0, 10, 20, NaN] }, { heights: [0, 10, 20, null] },
    { heights: [0, 10, 20, Infinity] }, { heights: [0, 10, 20, '30'] },
    { min: 1 }, { max: 50 }, { name: '' }, { id: '../bad' }, { attribution: '' }, { license: '' },
    { sourceUrls: [] }, { sourceUrls: ['javascript:alert(1)'] }, { sourceUrls: ['https://user:password@example.com'] },
    { sourceUrls: ['not a url'] }, { bounds: { west: 135, east: 134, south: 35, north: 36 } },
    { bounds: { west: 135, east: 135.01, south: 35, north: 35 } },
    { bounds: { west: 135, east: 136, south: 35, north: 36 } },
    { bounds: { west: 135, east: 135.01, south: NaN, north: 35.01 } },
  ].map(patch => [patch]))('rejects malformed terrain %#', patch => {
    const input = patch === null || Array.isArray(patch) || (typeof patch === 'object' && !Object.keys(patch).length) ? patch : { ...fixture(), ...patch };
    expect(() => validateTerrain(input)).toThrow();
  });
  it('allows terrain padding up to 30 km while GPX routes remain limited to 25 km', () => {
    const terrain = fixture();
    terrain.bounds.north = 35.25;
    expect(validateTerrain(terrain).bounds.north).toBe(35.25);
    expect(() => parseGPX(path(p('35', '135') + p('35.25', '135')))).toThrow(/25 km/);
    terrain.bounds.north = 35.28;
    expect(() => validateTerrain(terrain)).toThrow(/30 km/);
  });
  it('allows matching rounded extrema and normalizes them to actual values', () => {
    const terrain = fixture();
    terrain.heights[0] = 0.001;
    expect(validateTerrain(terrain).min).toBe(0.001);
  });
});
