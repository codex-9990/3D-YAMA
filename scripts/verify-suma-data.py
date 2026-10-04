#!/usr/bin/env python3
"""Offline verification of the distributed public Suma sample, without source checkout."""
import hashlib
import json
import math
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1] / 'public' / 'data'
terrain = json.loads((ROOT/'terrain.json').read_text())
provenance = json.loads((ROOT/'provenance.json').read_text())
peaks = json.loads((ROOT/'sample-peaks.json').read_text())
source = json.loads((ROOT/'sample-osm-source.geojson').read_text())
b = terrain['bounds']
assert -180 <= b['west'] < b['east'] <= 180 and -90 <= b['south'] < b['north'] <= 90
assert terrain['rowOrder'] == 'south_to_north' and terrain['columnOrder'] == 'west_to_east'
assert terrain['cols'] == 141 and terrain['rows'] == 123
heights = terrain['heights']
assert len(heights) == terrain['cols'] * terrain['rows']
assert all(type(h) in (int, float) and math.isfinite(h) for h in heights)
assert min(heights) == terrain['min'] and max(heights) == terrain['max']
assert terrain['max'] - terrain['min'] > 200

inside = lambda p: b['west'] <= p[0] <= b['east'] and b['south'] <= p[1] <= b['north']
ns = {'g': 'http://www.topografix.com/GPX/1/1'}
gpx = ET.parse(ROOT/'sample-route.gpx').getroot()
segments = gpx.findall('g:trk/g:trkseg', ns)
assert len(segments) == 1
points = segments[0].findall('g:trkpt', ns)
coords = [(float(p.get('lon')),float(p.get('lat'))) for p in points]
assert len(points) > 2 and all(inside(p) for p in coords)
assert len(set(coords)) == len(coords)
assert not gpx.findall('.//g:time', ns), 'A public generated sample has no fake timestamps'
assert all(math.isfinite(float(p.find('g:ele',ns).text)) for p in points)

edges = set()
for f in source['features']:
    if f['geometry']['type'] != 'LineString':
        continue
    props = f['properties']
    assert props.get('highway') in ('footway','path','steps')
    assert props.get('access') not in ('no','private')
    assert props.get('foot') != 'no'
    assert props.get('bridge','no') == props.get('tunnel','no') == 'no'
    c = f['geometry']['coordinates']
    edges.update(frozenset((tuple(a),tuple(z))) for a,z in zip(c,c[1:]))
assert all(frozenset((a,z)) in edges for a,z in zip(coords,coords[1:])), 'No fabricated joins'

def distance(a,z):
    lon1,lat1,lon2,lat2 = map(math.radians,(*a,*z))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 12742017.6 * math.asin(min(1,math.sqrt(h)))

lengths = [distance(a,z) for a,z in zip(coords,coords[1:])]
assert sum(lengths) > 200 and 0 < max(lengths) < 100
assert abs(sum(lengths)-provenance['route']['lengthMetersApprox']) < 0.01
assert len(coords) == provenance['route']['pointCount']
assert all(inside((p['lon'],p['lat'])) for p in peaks)
assert {p['name'] for p in peaks} == {'鉢伏山','旗振山','鉄拐山'}
assert all((p['lon'],p['lat']) in coords for p in peaks)
for filename, expected in provenance['files'].items():
    content = (ROOT/filename).read_bytes()
    assert len(content) == expected['bytes']
    assert hashlib.sha256(content).hexdigest() == expected['sha256']
print(json.dumps({'status':'pass', 'terrainVertices':len(heights), 'terrainMinM':min(heights),
                  'terrainMaxM':max(heights), 'routePoints':len(coords),
                  'routeMeters':round(sum(lengths),2), 'maxSegmentMeters':round(max(lengths),2),
                  'peaks':len(peaks), 'allRouteEdgesMatchSource':True,
                  'allDataFilesMatchProvenance':True}, ensure_ascii=False, indent=2))
