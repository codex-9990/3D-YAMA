// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseGPX } from '../src/core';
import { decodeElevation, importPhoto, MAX_PROJECT_BYTES, readProject, trackToGPX, type Project } from '../src/io';

const project = (): Project => ({
  version: 1,
  track: {
    name: 'Trail <mountain> & "view"',
    segments: [
      [{ lat: 35, lon: 135, elevation: 100, time: '2026-01-01T00:00:00Z' }, { lat: 35.001, lon: 135, elevation: 110, time: '2026-01-01T00:10:00Z' }],
      [{ lat: 35.01, lon: 135, elevation: 120 }, { lat: 35.011, lon: 135, elevation: 105 }],
    ],
  },
  terrain: {
    id: 'local-test', name: 'Test terrain', bounds: { west: 134.99, south: 34.99, east: 135.02, north: 35.02 },
    cols: 2, rows: 2, heights: [100, 110, 120, 130], min: 100, max: 130,
    attribution: 'Test attribution', sourceUrls: ['https://example.com/terrain'], license: 'CC0',
  },
  photos: [{ id: 'photo-0', name: 'View.jpg', lat: 35, lon: 135, distance: 0, url: 'data:image/jpeg;base64,/9j/2Q==' }],
  peaks: [{ name: 'Test peak', lat: 35.01, lon: 135, elevation: 120 }],
});

function read(value: unknown): Project { return readProject(JSON.stringify(value)); }

describe('GPX writing', () => {
  it('escapes the route name, preserves segments, elevation and timestamps', () => {
    const track = project().track;
    const xml = trackToGPX(track);
    expect(xml).toContain('Trail &lt;mountain&gt; &amp; &quot;view&quot;');
    expect(parseGPX(xml)).toEqual(track);
  });
  it('round-trips absent elevations without inventing them', () => {
    const track = project().track;
    for (const segment of track.segments) for (const point of segment) { delete point.elevation; delete point.time; }
    expect(parseGPX(trackToGPX(track))).toEqual(track);
  });
});

describe('project import', () => {
  it('round-trips a project, including route gaps, provenance, times and local photos', () => {
    const input = project();
    expect(read(input)).toEqual(input);
  });
  it('regenerates untrusted photo IDs', () => {
    const input = project();
    input.photos[0].id = '<script>bad</script>';
    expect(read(input).photos[0].id).toBe('photo-0');
  });
  it.each(['', '{invalid}', 'null', '[]', '{}'])('rejects malformed or unsupported JSON %s', text => {
    expect(() => readProject(text)).toThrow();
  });
  it.each([
    { version: 2 }, { photos: null }, { photos: {} }, { peaks: null }, { track: null },
    { track: { name: 'bad', segments: 'not an array' } },
    { track: { name: 42, segments: [] } },
    { track: { name: 'bad', segments: [null] } },
    { terrain: {} },
  ])('rejects invalid top-level fields %#', patch => {
    expect(() => read({ ...project(), ...patch })).toThrow();
  });
  it('enforces the maximum project file size before parsing', () => {
    expect(() => readProject(' '.repeat(MAX_PROJECT_BYTES + 1))).toThrow(/40 MB/);
  });
  it('rejects excessive photos, peaks, segments and point counts', () => {
    const manyPhotos = project(); manyPhotos.photos = Array.from({ length: 21 }, () => manyPhotos.photos[0]);
    expect(() => read(manyPhotos)).toThrow();
    const manyPeaks = project(); manyPeaks.peaks = Array.from({ length: 201 }, () => manyPeaks.peaks[0]);
    expect(() => read(manyPeaks)).toThrow();
    const manySegments = project(); manySegments.track.segments = Array.from({ length: 1001 }, () => []);
    expect(() => read(manySegments)).toThrow();
    const manyPoints = project(); manyPoints.track.segments = [Array.from({ length: 50_001 }, () => ({ lat: 35, lon: 135 }))];
    expect(() => read(manyPoints)).toThrow();
  });
  it.each([
    'javascript:alert(1)', 'https://example.com/photo.jpg', 'file:///tmp/photo.jpg', 'blob:https://example.com/id',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/jpeg;base64,AA==" onerror="alert(1)', 'data:image/jpeg,not-base64',
    'data:image/png;base64,AA==\n',
  ])('rejects nonlocal or executable photo URLs %s', url => {
    const value = project(); value.photos[0].url = url;
    expect(() => read(value)).toThrow();
  });
  it.each([
    { lat: null }, { lat: '35' }, { lat: 91 }, { lon: 181 }, { distance: -1 }, { distance: '0' },
    { name: 42 }, { name: 'n'.repeat(201) }, { url: 42 }, { url: 'data:image/jpeg;base64,' + 'A'.repeat(2_000_000) },
  ])('rejects malformed photo fields %#', patch => {
    const value = project();
    expect(() => read({ ...value, photos: [{ ...value.photos[0], ...patch }] })).toThrow();
  });
  it.each([{ name: 42 }, { name: 'n'.repeat(101) }, { lat: null }, { lat: '35' }, { lat: 91 }, { lon: 181 }])('rejects malformed peak fields %#', patch => {
    const value = project();
    expect(() => read({ ...value, peaks: [{ ...value.peaks[0], ...patch }] })).toThrow();
  });
  it('rejects malformed track coordinate values instead of coercing JSON strings', () => {
    for (const patch of [{ lat: '35' }, { lon: '135' }, { elevation: '100' }, { lat: null }, { lon: 181 }]) {
      const value = project();
      const point = { ...value.track.segments[0][0], ...patch };
      const track = { ...value.track, segments: [[point, value.track.segments[0][1]]] };
      expect(() => read({ ...value, track })).toThrow();
    }
  });
});

describe('GSI DEM decoding', () => {
  it('decodes positive and negative signed centimeter values and nodata', () => {
    expect(decodeElevation(0, 0, 0)).toBe(0);
    expect(decodeElevation(0, 0, 1)).toBe(0.01);
    expect(decodeElevation(0, 48, 57)).toBe(123.45);
    expect(decodeElevation(255, 255, 255)).toBe(-0.01);
    expect(decodeElevation(255, 207, 199)).toBe(-123.45);
    expect(decodeElevation(128, 0, 0)).toBeNull();
    expect(decodeElevation(128, 0, 1)).toBe(-83886.07);
    expect(decodeElevation(127, 255, 255)).toBe(83886.07);
  });
});

describe('photo import guards', () => {
  it('rejects SVG and oversized images before decoding', async () => {
    await expect(importPhoto(new File(['<svg/>'], 'test.svg', { type: 'image/svg+xml' }))).rejects.toThrow();
    const large = new File([new Uint8Array(12 * 1024 * 1024 + 1)], 'big.jpg', { type: 'image/jpeg' });
    await expect(importPhoto(large)).rejects.toThrow();
  });
});
