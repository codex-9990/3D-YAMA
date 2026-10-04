#!/usr/bin/env python3
"""Offline checks: native DEM fidelity, real route edges and feature provenance.

Runs without external dependencies or a network connection. Re-decodes the
retained source PNGs to verify ALL height samples, not only extrema/hashes.
"""
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]/'public'/'data'
spec=importlib.util.spec_from_file_location('prepare_suma',Path(__file__).with_name('prepare-suma-data.py'))
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
terrain=json.loads((ROOT/'terrain.json').read_text());provenance=json.loads((ROOT/'provenance.json').read_text())
peaks=json.loads((ROOT/'sample-peaks.json').read_text());source=json.loads((ROOT/'sample-osm-source.geojson').read_text())
scene=json.loads((ROOT/'sample-features.json').read_text());b=terrain['bounds'];heights=terrain['heights']
assert -180<=b['west']<b['east']<=180 and -90<=b['south']<b['north']<=90
assert terrain['rowOrder']=='south_to_north' and terrain['columnOrder']=='west_to_east'
assert terrain['cols']==289 and terrain['rows']==240
assert len(heights)==terrain['cols']*terrain['rows'] and all(type(h) in (int,float) and math.isfinite(h) for h in heights)
assert min(heights)==terrain['min'] and max(heights)==terrain['max'] and max(heights)-min(heights)>200
assert terrain['sourceResolutionMeters']==5 and 3.9<terrain['approximateGridSpacingMeters']<4.0
assert terrain['maxLinearLatitudeErrorMeters']<0.02
assert len(terrain['rowLatitudes'])==terrain['rows'] and all(a<z for a,z in zip(terrain['rowLatitudes'],terrain['rowLatitudes'][1:]))
inside=lambda p:b['west']<=p[0]<=b['east'] and b['south']<=p[1]<=b['north']

# Native height values are retained, rather than interpolated synthetic relief.
tiles={pair:builder.read_png_rgb(ROOT/f'source-dem5a-15-{pair[0]}-{pair[1]}.png') for pair in builder.DEM_TILES}
w,n,e,s=builder.PIXEL_BOUNDS
for row,y in enumerate(range(s,n-1,-1)):
    assert terrain['rowLatitudes'][row]==builder.inverse_pixel(w,y)[1]
    for col,x in enumerate(range(w,e+1)):
        assert heights[row*terrain['cols']+col]==builder.decode_dem(tiles[x//256,y//256][y%256][x%256])
assert [b['west'],b['south']]==builder.inverse_pixel(w,s)
assert [b['east'],b['north']]==builder.inverse_pixel(e,n)

ns={'g':'http://www.topografix.com/GPX/1/1'};gpx=ET.parse(ROOT/'sample-route.gpx').getroot();segments=gpx.findall('g:trk/g:trkseg',ns)
assert len(segments)==1
points=segments[0].findall('g:trkpt',ns);coords=[(float(p.get('lon')),float(p.get('lat'))) for p in points]
assert len(points)==143 and all(inside(p) for p in coords) and len(set(coords))==len(coords)
assert not gpx.findall('.//g:time',ns),'Public generated track must not contain invented activity timestamps'
assert all(math.isfinite(float(p.find('g:ele',ns).text)) for p in points)

edges=set();source_by_id={f['id']:f for f in source['features']}
for f in source['features']:
    if f['geometry']['type']!='LineString':continue
    props=f['properties'];assert props.get('highway') in ('footway','path','steps')
    assert props.get('access') not in ('no','private') and props.get('foot')!='no'
    assert props.get('bridge','no')==props.get('tunnel','no')=='no'
    c=f['geometry']['coordinates'];edges.update(frozenset((tuple(a),tuple(z))) for a,z in zip(c,c[1:]))
assert all(frozenset((a,z)) in edges for a,z in zip(coords,coords[1:])),'No fabricated trail joins'
lengths=[builder.haversine(a,z) for a,z in zip(coords,coords[1:])]
assert 1500<sum(lengths)<1650 and 125<max(lengths)<127 # authentic 2-node mapped staircase
assert abs(sum(lengths)-provenance['route']['lengthMetersApprox'])<0.01
assert len(coords)==provenance['route']['pointCount']
assert all(inside((p['lon'],p['lat'])) for p in peaks)
assert {p['name'] for p in peaks}=={'栂尾山','横尾山'}
# Peaks are independent map features, never artificially added to the track.
assert all(min(builder.haversine(c,[p['lon'],p['lat']]) for c in coords)<10 for p in peaks)


def geometry_positions(geometry):
    t=geometry['type'];c=geometry['coordinates']
    return [c] if t=='Point' else c if t=='LineString' else [p for ring in c for p in ring]


def point_in_ring(p,ring):
    x,y=p;inside_polygon=False
    for a,z in zip(ring,ring[1:]):
        if (a[1]>y)!=(z[1]>y) and x<(z[0]-a[0])*(y-a[1])/(z[1]-a[1])+a[0]:inside_polygon=not inside_polygon
    return inside_polygon


sf={f['id']:f for f in scene['features']}
assert scene['schemaVersion']==1 and len(sf)==10
assert {f['kind'] for f in sf.values()}=={'forest','bare_rock','steps','landmark'}
for f in sf.values():
    assert f['sourceUrl'].startswith('https://') and f['provenance'] and f['approximate'] is True
    assert all(inside(p) for p in geometry_positions(f['geometry']))
    assert all(id in source_by_id for id in f['sourceIds'])
    if f['geometry']['type']=='Polygon':
        assert all(len(r)>=4 and r[0]==r[-1] for r in f['geometry']['coordinates'])
    if f['kind']=='steps':
        assert f['stepCount'] is None and f['dimensionsAreIllustrative'] is True
        cs=f['geometry']['coordinates'];assert all(frozenset((tuple(a),tuple(z))) in edges for a,z in zip(cs,cs[1:]))
    if f['kind']=='bare_rock':
        assert f['interpretationAccuracyMeters']>=10 and 'approximate' in f['provenance'].lower()
        assert f['sourceTileUrls'] and f['renderingNote']
assert sf['togao-400-steps']['geometry']==source_by_id['way/369143234']['geometry']
assert sf['togao-400-steps']['endElevation']>sf['togao-400-steps']['startElevation']
assert sf['togao-400-steps']['alignmentConfidence']=='mapped'
assert sf['umanose-west-stairs']['alignmentConfidence']=='photo_correlated_approximate'
assert 'not an OSM highway=steps' in sf['umanose-west-stairs']['provenance']
assert sf['landmark-umanose']['geometry']==source_by_id['node/13946671193']['geometry']
umanose=sf['landmark-umanose']['geometry']['coordinates']
assert min(builder.haversine(c,umanose) for c in coords)<10
assert point_in_ring(umanose,sf['umanose-rock-1']['geometry']['coordinates'][0])
forest_focus=sf['landmark-forest']['geometry']['coordinates']
assert tuple(forest_focus) in coords and point_in_ring(forest_focus,sf['suma-woodland']['geometry']['coordinates'][0])
assert not any(point_in_ring(forest_focus,f['geometry']['coordinates'][0]) for f in sf.values() if f['kind']=='bare_rock')
assert 0<provenance['sceneFeatures']['independentViewpointSeparationMeters']<25
assert all(r['redistributed'] is False for r in scene['visualReferences'])
assert provenance['sceneFeatures']['surveyedStairDimensions'] is False
assert provenance['sceneFeatures']['surveyedIndividualTrees'] is False
for filename,expected in provenance['files'].items():
    content=(ROOT/filename).read_bytes();assert len(content)==expected['bytes']
    assert hashlib.sha256(content).hexdigest()==expected['sha256']
print(json.dumps({'status':'pass','terrainVertices':len(heights),'sourceResolutionMeters':5,
    'allNativeDemHeightsUnmodified':True,'terrainMinM':min(heights),'terrainMaxM':max(heights),
    'routePoints':len(coords),'routeMeters':round(sum(lengths),2),'maxSegmentMeters':round(max(lengths),2),
    'peaks':len(peaks),'sceneFeatures':len(sf),'mappedStairSegments':1,'photoCorrelatedApproximateStairSegments':1,
    'allRouteEdgesMatchSource':True,'umanoseInsideTerrainAndRockArea':True,'forestFocusInsideWoodland':True,
    'allDataFilesMatchProvenance':True},ensure_ascii=False,indent=2))
