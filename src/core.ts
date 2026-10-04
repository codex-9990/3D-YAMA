/** Pure geographic, GPX and terrain utilities. Distances/elevations are meters. */
export interface GeoPoint {
  lat: number;
  lon: number;
  elevation?: number;
  time?: string;
}

export interface Track {
  name: string;
  /** Gaps between segments are intentional: never connect them. Treat tracks as immutable. */
  segments: GeoPoint[][];
}

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TerrainData {
  id: string;
  name: string;
  bounds: GeoBounds;
  cols: number;
  rows: number;
  /** Row-major, west→east within each row; row 0 is SOUTH, last row NORTH. */
  heights: number[];
  min: number;
  max: number;
  attribution: string;
  sourceUrls: string[];
  license: string;
}

export interface Projection {
  lat: number;
  lon: number;
  metersPerDegreeLat: number;
  metersPerDegreeLon: number;
}

export interface RouteStats {
  distance: number;
  /** Undefined for incomplete elevation data, rather than presenting a partial ascent. */
  gain?: number;
  loss?: number;
  pointCount: number;
  segmentCount: number;
  minElevation?: number;
  maxElevation?: number;
  hasElevation: boolean;
  elevationComplete: boolean;
}

export interface SegmentDistance {
  segmentIndex: number;
  /** Distance along the whole route, excluding gaps. */
  start: number;
  end: number;
  distance: number;
  /** Distance from the start of this segment for every point. */
  cumulative: number[];
}

export const MAX_GPX_BYTES = 10 * 1024 * 1024;
export const MAX_TRACK_POINTS = 50_000;
export const MAX_DOMAIN_METERS = 25_000;
export const MAX_TERRAIN_DOMAIN_METERS = 30_000;
export const MAX_TERRAIN_SIDE = 512;
const EARTH_RADIUS = 6_371_008.8;
const DEG = Math.PI / 180;
const METERS_PER_DEGREE = EARTH_RADIUS * DEG;
const GPX_NAMESPACES = new Set(['', 'http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1']);

function fail(message: string): never {
  throw new Error(message);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number.`);
  return value;
}

function coordinates(point: GeoPoint): void {
  const lat = finiteNumber(point.lat, 'Latitude');
  const lon = finiteNumber(point.lon, 'Longitude');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) fail('Coordinates are outside the latitude/longitude range.');
}

function numericText(text: string | null, label: string): number {
  // Number('') and Number('0x20') are valid JavaScript, but not valid GPX values.
  if (text === null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) {
    fail(`${label} must be a valid number.`);
  }
  return finiteNumber(Number(text), label);
}

function children(element: Element, localName: string, namespace: string): Element[] {
  return Array.from(element.children).filter(child => child.localName === localName && (child.namespaceURI ?? '') === namespace);
}

function firstText(element: Element, localName: string, namespace: string): string | undefined {
  return children(element, localName, namespace)[0]?.textContent?.trim() || undefined;
}

function readPoint(element: Element, namespace: string): GeoPoint {
  const point: GeoPoint = {
    lat: numericText(element.getAttribute('lat'), 'Latitude'),
    lon: numericText(element.getAttribute('lon'), 'Longitude'),
  };
  coordinates(point);
  const elevations = children(element, 'ele', namespace);
  if (elevations.length > 1) fail('A GPX point has more than one elevation.');
  if (elevations.length) {
    point.elevation = numericText(elevations[0].textContent, 'Elevation');
    if (point.elevation < -12_000 || point.elevation > 100_000) fail('GPX elevation is outside the supported range.');
  }
  const time = firstText(element, 'time', namespace);
  if (time) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(time) || !Number.isFinite(Date.parse(time))) {
      fail('A GPX timestamp is invalid.');
    }
    point.time = time;
  }
  return point;
}

/** Parse GPX 1.0/1.1 or unnamespaced GPX without executing/reading external content. */
export function parseGPX(xml: string): Track {
  if (typeof xml !== 'string') fail('GPX input must be text.');
  if (xml.length > MAX_GPX_BYTES || new TextEncoder().encode(xml).byteLength > MAX_GPX_BYTES) {
    fail('GPX files must be 10 MB or smaller.');
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail('GPX DOCTYPE and ENTITY declarations are not allowed.');
  // Reject over-limit files before constructing a potentially very large XML DOM.
  // Counting lookalike points in comments/extensions conservatively is intentional.
  const candidatePointTags = /<(?:[^\s<>/:]+:)?(?:trkpt|rtept)(?=[\s/>])/g;
  let candidatePointCount = 0;
  while (candidatePointTags.exec(xml)) {
    if (++candidatePointCount > MAX_TRACK_POINTS) fail('GPX routes may contain at most 50,000 points.');
  }
  if (typeof DOMParser === 'undefined') fail('An XML DOMParser is required to read GPX.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (!root || root.localName === 'parsererror' || document.getElementsByTagNameNS('*', 'parsererror').length) {
    fail('This GPX file contains malformed XML.');
  }
  const namespace = root.namespaceURI ?? '';
  if (root.localName !== 'gpx' || !GPX_NAMESPACES.has(namespace)) fail('The file is not a supported GPX document.');
  const segments: GeoPoint[][] = [];
  let count = 0;
  let name = '';
  for (const item of Array.from(root.children)) {
    if ((item.namespaceURI ?? '') !== namespace) continue;
    if (item.localName !== 'trk' && item.localName !== 'rte') continue;
    if (!name) name = firstText(item, 'name', namespace) ?? '';
    const groups = item.localName === 'trk' ? children(item, 'trkseg', namespace) : [item];
    const pointTag = item.localName === 'trk' ? 'trkpt' : 'rtept';
    for (const group of groups) {
      const points = children(group, pointTag, namespace);
      count += points.length;
      if (count > MAX_TRACK_POINTS) fail('GPX routes may contain at most 50,000 points.');
      if (points.length) segments.push(points.map(point => readPoint(point, namespace)));
    }
  }
  if (count < 2 || !segments.some(segment => segment.length >= 2)) {
    fail('The GPX needs at least two points in one track or route segment.');
  }
  const track: Track = {
    name: name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || 'Imported route',
    segments,
  };
  validateDomain(trackBounds(track));
  return track;
}

/** Great-circle horizontal distance. Elevation does not inflate walking distance. */
export function horizontalDistance(a: GeoPoint, b: GeoPoint): number {
  coordinates(a);
  coordinates(b);
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function trackBounds(track: Track): GeoBounds {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const segment of track.segments) {
    for (const point of segment) {
      coordinates(point);
      west = Math.min(west, point.lon);
      east = Math.max(east, point.lon);
      south = Math.min(south, point.lat);
      north = Math.max(north, point.lat);
    }
  }
  if (!Number.isFinite(west)) fail('The route has no points.');
  return { west, south, east, north };
}

function validateDomain(bounds: GeoBounds, maximum = MAX_DOMAIN_METERS): void {
  if (bounds.east - bounds.west > 180) fail('Routes crossing the antimeridian are not supported.');
  const lat = (bounds.south + bounds.north) / 2;
  const width = (bounds.east - bounds.west) * METERS_PER_DEGREE * Math.cos(lat * DEG);
  const height = (bounds.north - bounds.south) * METERS_PER_DEGREE;
  if (Math.hypot(width, height) > maximum) fail(`Choose a local area with an extent of ${maximum / 1000} km or less.`);
}

/** Equirectangular local projection: x east and z south, in unscaled meters. */
export function createProjection(source: GeoPoint | TerrainData | Track | GeoBounds): Projection {
  let center: GeoPoint;
  if ('lat' in source && 'lon' in source) {
    center = source;
  } else {
    const bounds = 'segments' in source ? trackBounds(source) : 'bounds' in source ? source.bounds : source;
    center = { lat: (bounds.north + bounds.south) / 2, lon: (bounds.east + bounds.west) / 2 };
  }
  coordinates(center);
  return {
    lat: center.lat,
    lon: center.lon,
    metersPerDegreeLat: METERS_PER_DEGREE,
    metersPerDegreeLon: METERS_PER_DEGREE * Math.max(1e-12, Math.cos(center.lat * DEG)),
  };
}

export function projectPoint(point: GeoPoint, projection: Projection): { x: number; z: number } {
  coordinates(point);
  return {
    x: (point.lon - projection.lon) * projection.metersPerDegreeLon,
    z: (projection.lat - point.lat) * projection.metersPerDegreeLat,
  };
}

export function unprojectPoint(x: number, z: number, projection: Projection): GeoPoint {
  finiteNumber(x, 'x');
  finiteNumber(z, 'z');
  const point = {
    lat: projection.lat - z / projection.metersPerDegreeLat,
    lon: projection.lon + x / projection.metersPerDegreeLon,
  };
  coordinates(point);
  return point;
}

/** Distances preserve original segment indexes and never add an edge across a gap. */
export function segmentDistances(track: Track): SegmentDistance[] {
  let offset = 0;
  return track.segments.map((segment, segmentIndex) => {
    const cumulative: number[] = [];
    let distance = 0;
    for (let index = 0; index < segment.length; index++) {
      coordinates(segment[index]);
      if (index > 0) distance += horizontalDistance(segment[index - 1], segment[index]);
      cumulative.push(distance);
    }
    const result = { segmentIndex, start: offset, end: offset + distance, distance, cumulative };
    offset += distance;
    return result;
  });
}

export function routeStats(track: Track): RouteStats {
  const distances = segmentDistances(track);
  let pointCount = 0;
  let elevationCount = 0;
  let gain = 0;
  let loss = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const segment of track.segments) {
    pointCount += segment.length;
    for (let index = 0; index < segment.length; index++) {
      const elevation = segment[index].elevation;
      if (elevation === undefined) continue;
      finiteNumber(elevation, 'Elevation');
      elevationCount++;
      min = Math.min(min, elevation);
      max = Math.max(max, elevation);
      const previous = segment[index - 1]?.elevation;
      if (previous !== undefined) {
        const difference = elevation - previous;
        if (difference > 0) gain += difference;
        else loss -= difference;
      }
    }
  }
  const elevationComplete = pointCount > 0 && elevationCount === pointCount;
  return {
    distance: distances.at(-1)?.end ?? 0,
    gain: elevationComplete ? gain : undefined,
    loss: elevationComplete ? loss : undefined,
    pointCount,
    segmentCount: track.segments.filter(segment => segment.length > 0).length,
    minElevation: elevationCount ? min : undefined,
    maxElevation: elevationCount ? max : undefined,
    hasElevation: elevationCount > 0,
    elevationComplete,
  };
}

interface RouteEdge { a: GeoPoint; b: GeoPoint; start: number; end: number; segmentIndex: number; }
interface RouteIndex { edges: RouteEdge[]; first: GeoPoint; last: GeoPoint; firstSegment: number; total: number; }
const routeIndexes = new WeakMap<Track, RouteIndex>();

/** Cache is safe when a Track and its point/segment arrays are treated as immutable. */
function routeIndex(track: Track): RouteIndex {
  const existing = routeIndexes.get(track);
  if (existing) return existing;
  const edges: RouteEdge[] = [];
  let first: GeoPoint | undefined;
  let last: GeoPoint | undefined;
  let firstSegment = 0;
  let total = 0;
  for (let segmentIndex = 0; segmentIndex < track.segments.length; segmentIndex++) {
    const segment = track.segments[segmentIndex];
    for (let i = 0; i < segment.length; i++) {
      coordinates(segment[i]);
      if (!first) { first = segment[i]; firstSegment = segmentIndex; }
      last = segment[i];
      if (i === 0) continue;
      const distance = horizontalDistance(segment[i - 1], segment[i]);
      if (distance > 0) edges.push({ a: segment[i - 1], b: segment[i], start: total, end: total + distance, segmentIndex });
      total += distance;
    }
  }
  if (!first || !last) fail('The route has no points.');
  const index = { edges, first, last, firstSegment, total };
  routeIndexes.set(track, index);
  return index;
}

function bearingBetween(a: GeoPoint, b: GeoPoint): number {
  const latitudeA = a.lat * DEG;
  const latitudeB = b.lat * DEG;
  const longitudeDelta = (b.lon - a.lon) * DEG;
  const y = Math.sin(longitudeDelta) * Math.cos(latitudeB);
  const x = Math.cos(latitudeA) * Math.sin(latitudeB) - Math.sin(latitudeA) * Math.cos(latitudeB) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Clamp to route endpoints. At a gap boundary the next segment starts immediately. */
export function pointAtDistance(track: Track, distance: number): { point: GeoPoint; bearing: number; segmentIndex: number } {
  finiteNumber(distance, 'Route distance');
  const index = routeIndex(track);
  if (!index.edges.length) return { point: { ...index.first }, bearing: 0, segmentIndex: index.firstSegment };
  const target = Math.max(0, Math.min(index.total, distance));
  let low = 0;
  let high = index.edges.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (index.edges[mid].end <= target) low = mid + 1;
    else high = mid;
  }
  const edge = index.edges[low];
  const t = Math.max(0, Math.min(1, (target - edge.start) / (edge.end - edge.start)));
  const point: GeoPoint = {
    lat: edge.a.lat + (edge.b.lat - edge.a.lat) * t,
    lon: edge.a.lon + (edge.b.lon - edge.a.lon) * t,
  };
  if (edge.a.elevation !== undefined && edge.b.elevation !== undefined) {
    point.elevation = edge.a.elevation + (edge.b.elevation - edge.a.elevation) * t;
  } else if (t === 0 && edge.a.elevation !== undefined) point.elevation = edge.a.elevation;
  else if (t === 1 && edge.b.elevation !== undefined) point.elevation = edge.b.elevation;
  if (edge.a.time && edge.b.time) {
    const start = Date.parse(edge.a.time);
    const end = Date.parse(edge.b.time);
    if (Number.isFinite(start) && Number.isFinite(end)) point.time = new Date(start + (end - start) * t).toISOString();
  }
  return { point, bearing: bearingBetween(edge.a, edge.b), segmentIndex: edge.segmentIndex };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxLength = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) fail(`${label} must be nonempty text (${maxLength} characters maximum).`);
  return value.trim();
}

/** Validate untrusted JSON and return a fresh, normalized terrain object. */
export function validateTerrain(value: unknown): TerrainData {
  const input = record(value, 'Terrain');
  const id = requiredString(input.id, 'Terrain ID', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) fail('Terrain ID may only contain letters, numbers, dots, hyphens and underscores.');
  const name = requiredString(input.name, 'Terrain name', 200);
  const rawBounds = record(input.bounds, 'Terrain bounds');
  const bounds: GeoBounds = {
    west: finiteNumber(rawBounds.west, 'West bound'),
    south: finiteNumber(rawBounds.south, 'South bound'),
    east: finiteNumber(rawBounds.east, 'East bound'),
    north: finiteNumber(rawBounds.north, 'North bound'),
  };
  coordinates({ lat: bounds.south, lon: bounds.west });
  coordinates({ lat: bounds.north, lon: bounds.east });
  if (bounds.west >= bounds.east || bounds.south >= bounds.north) fail('Terrain bounds must have positive width and height and cannot cross the antimeridian.');
  validateDomain(bounds, MAX_TERRAIN_DOMAIN_METERS);
  const cols = finiteNumber(input.cols, 'Terrain columns');
  const rows = finiteNumber(input.rows, 'Terrain rows');
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > MAX_TERRAIN_SIDE || rows > MAX_TERRAIN_SIDE) {
    fail('Terrain dimensions must be integers between 2 and 512.');
  }
  if (!Array.isArray(input.heights) || input.heights.length !== rows * cols) fail('Terrain height count does not match its dimensions.');
  let actualMin = Infinity;
  let actualMax = -Infinity;
  const heights = Array.from(input.heights, (height: unknown) => {
    const number = finiteNumber(height, 'Terrain elevation');
    if (number < -12_000 || number > 10_000) fail('Terrain elevation is outside the supported range.');
    actualMin = Math.min(actualMin, number);
    actualMax = Math.max(actualMax, number);
    return number;
  });
  const min = finiteNumber(input.min, 'Minimum elevation');
  const max = finiteNumber(input.max, 'Maximum elevation');
  if (min > max || Math.abs(min - actualMin) > 0.01 || Math.abs(max - actualMax) > 0.01) fail('Terrain minimum/maximum do not match its height samples.');
  const attribution = requiredString(input.attribution, 'Terrain attribution');
  const license = requiredString(input.license, 'Terrain license');
  if (!Array.isArray(input.sourceUrls) || !input.sourceUrls.length || input.sourceUrls.length > 32) fail('Terrain must include between 1 and 32 source URLs.');
  const sourceUrls = input.sourceUrls.map((source: unknown) => {
    const text = requiredString(source, 'Source URL');
    let url: URL;
    try { url = new URL(text); } catch { return fail('A terrain source URL is invalid.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('Terrain source URLs must use HTTP(S) without credentials.');
    return text;
  });
  return { id, name, bounds, cols, rows, heights, min: actualMin, max: actualMax, attribution, sourceUrls, license };
}

/** Bilinear interpolation on a validated south→north terrain grid; no extrapolation. */
export function terrainElevation(data: TerrainData, lat: number, lon: number): number {
  coordinates({ lat, lon });
  const { west, south, east, north } = data.bounds;
  if (lat < south || lat > north || lon < west || lon > east) fail('This point lies outside the selected terrain.');
  const x = (lon - west) / (east - west) * (data.cols - 1);
  const y = (lat - south) / (north - south) * (data.rows - 1);
  const x0 = Math.min(data.cols - 2, Math.floor(x));
  const y0 = Math.min(data.rows - 2, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const sw = data.heights[y0 * data.cols + x0];
  const se = data.heights[y0 * data.cols + x0 + 1];
  const nw = data.heights[(y0 + 1) * data.cols + x0];
  const ne = data.heights[(y0 + 1) * data.cols + x0 + 1];
  return (sw * (1 - tx) + se * tx) * (1 - ty) + (nw * (1 - tx) + ne * tx) * ty;
}
