#!/usr/bin/env python3
"""Prepare the public, offline Suma demo from the three named public-source files.

Usage: python3 scripts/prepare-suma-data.py /path/to/source-data
Only writes public/data. Does not fetch data or read personal GPX/photo files.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public' / 'data'
GSI_DOC = 'https://maps.gsi.go.jp/development/ichiran.html#dem'
GSI_LICENSE = 'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html'
OSM_LICENSE = 'https://opendatacommons.org/licenses/odbl/1-0/'
OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright'
GSI_CREDIT = '地理院タイル（標高タイル）を加工して作成'
OSM_CREDIT = '© OpenStreetMap contributors'
DISCLAIMER = ('公開地図から作成した表示確認用の概略ルートです。実際に歩いた記録ではありません。'
              '通行可否・危険箇所・現況は未確認です。登山中のナビゲーションや安全判断には使用しないでください。')


def haversine(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(h)))


def write_json(name, data, compact=False):
    (OUTPUT/name).write_text(json.dumps(data, ensure_ascii=False, allow_nan=False,
        separators=(',', ':') if compact else None, indent=None if compact else 2) + '\n', encoding='utf-8')


def prepare(source):
    names = ['suma-mountain-dem.json', 'suma-mountain-routes.geojson', 'suma-mountain.geojson']
    inputs = {name: json.loads((source/name).read_text()) for name in names}
    dem, routes, osm = (inputs[name] for name in names)
    assert dem['row_order'] == 'south_to_north'
    assert dem['column_order'] == 'west_to_east'
    assert len(dem['elevations']) == dem['rows']
    assert all(len(row) == dem['columns'] for row in dem['elevations'])

    # Preserve every ground sample in the continuous, complete northern rectangle.
    # South/coastal no-data is excluded; no interpolation, zero filling or smoothing.
    first_row = 1 + max(i for i, row in enumerate(dem['elevations']) if None in row)
    rows = dem['rows'] - first_row
    cols = dem['columns']
    heights = [h for row in dem['elevations'][first_row:] for h in row]
    assert rows > 100 and cols > 100
    assert all(isinstance(h, (int, float)) and math.isfinite(h) for h in heights)
    assert len(heights) == rows*cols
    bounds = {'west': dem['longitude_start'], 'south': dem['latitude_start']+first_row*dem['latitude_step'],
              'east': dem['longitude_start']+(cols-1)*dem['longitude_step'],
              'north': dem['latitude_start']+(dem['rows']-1)*dem['latitude_step']}

    def inside(point):
        x, y = point
        return bounds['west'] <= x <= bounds['east'] and bounds['south'] <= y <= bounds['north']

    def elevation(point):
        assert inside(point)
        x = (point[0]-bounds['west'])/(bounds['east']-bounds['west'])*(cols-1)
        y = (point[1]-bounds['south'])/(bounds['north']-bounds['south'])*(rows-1)
        i, j = min(cols-2, int(x)), min(rows-2, int(y))
        u, v = x-i, y-j
        return (heights[j*cols+i]*(1-u)+heights[j*cols+i+1]*u)*(1-v) + (heights[(j+1)*cols+i]*(1-u)+heights[(j+1)*cols+i+1]*u)*v

    terrain = {'id': 'suma', 'name': '須磨アルプス・鉢伏山〜鉄拐山', 'bounds': bounds,
        'cols': cols, 'rows': rows, 'heights': heights, 'min': min(heights), 'max': max(heights),
        'attribution': GSI_CREDIT, 'sourceUrls': [GSI_DOC, dem['decode_documentation']],
        'license': 'Public Data License 1.0 (GSI content terms)', 'licenseUrl': GSI_LICENSE,
        'rowOrder': 'south_to_north', 'columnOrder': 'west_to_east', 'elevationUnit': 'm',
        'horizontalCrs': 'EPSG:4326', 'approximateGridSpacingMeters': 10,
        'noDataTreatment': 'Complete northern rectangle retained. No missing heights or invented fill values.'}
    write_json('terrain.json', terrain, compact=True)

    features = {f['id']: f for f in osm['features']}
    ridge = next(f for f in routes['features'] if f['id'] == 'hachibuse_to_hatafuri')
    parts = [ridge['geometry']['coordinates'], features['way/627560211']['geometry']['coordinates'],
             list(reversed(features['way/165600418']['geometry']['coordinates']))]
    coordinates = list(parts[0])
    for part in parts[1:]:
        assert coordinates[-1] == part[0], 'Never bridge disconnected paths'
        coordinates.extend(part[1:])
    assert all(inside(p) for p in coordinates)
    assert len(set(map(tuple, coordinates))) == len(coordinates)
    edge_sources = {}
    for f in osm['features']:
        if f['geometry']['type'] != 'LineString' or f['properties'].get('highway') not in ('path','footway','steps'):
            continue
        if f['properties'].get('access') in ('no','private') or f['properties'].get('foot') == 'no':
            continue
        c = f['geometry']['coordinates']
        for a, b in zip(c, c[1:]):
            edge_sources.setdefault(frozenset((tuple(a), tuple(b))), []).append(f['id'])
    segment_sources = []
    for a, b in zip(coordinates, coordinates[1:]):
        key = frozenset((tuple(a), tuple(b)))
        assert key in edge_sources, 'Every sample edge must occur in an existing OSM footpath'
        segment_sources.append(edge_sources[key])
    distances = [haversine(a, b) for a,b in zip(coordinates, coordinates[1:])]
    assert sum(distances) > 200
    assert 0 < max(distances) < 100
    used_ways = sorted(set(x for xs in segment_sources for x in xs))
    for way in used_ways:
        props = features[way]['properties']
        assert props.get('bridge', 'no') == 'no' and props.get('tunnel', 'no') == 'no'
        assert not props.get('clipped_to_bbox'), 'No clipping-created edges in sample route'
    sampled_elevations = [round(elevation(p),2) for p in coordinates]

    # GPX positions are public OSM geometry, not a personal recorded track.
    namespace = 'http://www.topografix.com/GPX/1/1'
    ET.register_namespace('', namespace)
    tag = lambda s: '{'+namespace+'}'+s
    gpx = ET.Element(tag('gpx'), {'version': '1.1', 'creator': '3D-YAMA public sample builder'})
    metadata = ET.SubElement(gpx, tag('metadata'))
    route_name = '須磨サンプル：鉢伏山 → 旗振山 → 鉄拐山'
    ET.SubElement(metadata, tag('name')).text = route_name
    ET.SubElement(metadata, tag('desc')).text = DISCLAIMER + ' 標高は国土地理院DEMから補間した地表高です。'
    copy = ET.SubElement(metadata, tag('copyright'), {'author': 'OpenStreetMap contributors'})
    ET.SubElement(copy, tag('license')).text = OSM_LICENSE
    for url, title in [(OSM_COPYRIGHT, OSM_CREDIT), (GSI_DOC, GSI_CREDIT), (GSI_LICENSE, 'GSI content terms')]:
        link = ET.SubElement(metadata, tag('link'), {'href': url})
        ET.SubElement(link, tag('text')).text = title
    ET.SubElement(metadata, tag('bounds'), {'minlat': str(min(p[1] for p in coordinates)),
        'minlon': str(min(p[0] for p in coordinates)), 'maxlat': str(max(p[1] for p in coordinates)),
        'maxlon': str(max(p[0] for p in coordinates))})
    track = ET.SubElement(gpx, tag('trk'))
    ET.SubElement(track, tag('name')).text = route_name
    ET.SubElement(track, tag('desc')).text = 'OSMの連続する登山道形状を接続。' + DISCLAIMER
    ET.SubElement(track, tag('src')).text = OSM_CREDIT + ' / ' + GSI_CREDIT
    segment = ET.SubElement(track, tag('trkseg'))
    for (lon, lat), ele in zip(coordinates, sampled_elevations):
        point = ET.SubElement(segment, tag('trkpt'), {'lat': f'{lat:.7f}', 'lon': f'{lon:.7f}'})
        ET.SubElement(point, tag('ele')).text = f'{ele:.2f}'
    ET.indent(gpx, space='  ')
    ET.ElementTree(gpx).write(OUTPUT/'sample-route.gpx', encoding='utf-8', xml_declaration=True)

    peaks = []
    for f in osm['features']:
        if f['properties'].get('category') != 'peak' or f['geometry']['type'] != 'Point':
            continue
        point = f['geometry']['coordinates']
        if not inside(point):
            continue
        props = f['properties']
        peaks.append({'id': f['id'], 'name': props['name'], 'lon': point[0], 'lat': point[1],
                      'elevation': round(elevation(point),2), 'elevationSource': 'GSI DEM bilinear ground sample; approximate',
                      'osmElevation': float(props['ele']) if 'ele' in props else None,
                      'sourceUrl': 'https://www.openstreetmap.org/'+f['id'],
                      'attribution': OSM_CREDIT, 'license': 'ODbL-1.0'})
    peaks.sort(key=lambda p: p['lat'])
    write_json('sample-peaks.json', peaks)
    public_features = [features[way] for way in used_ways] + [features[p['id']] for p in peaks]
    # Public geometry source subset retained for reproducibility and ODbL access.
    write_json('sample-osm-source.geojson', {'type': 'FeatureCollection', 'metadata': osm['metadata'], 'features': public_features})

    provenance = {'schemaVersion': 1, 'id': 'suma', 'preparedDate': '2026-10-04',
        'description': 'Small, offline public-data demo. No private tracks, photographs, logs, account data or personal notes.',
        'terrain': {
            'file': 'terrain.json', 'sourceName': dem['source'], 'sourceUrls': [GSI_DOC, dem['decode_documentation']],
            'tileTemplate': 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/15/{x}/{y}.png',
            'sourceRetrievalDate': None, 'sourceRetrievalDateNote': 'Not recorded in supplied DEM; do not infer it from file modification time.',
            'sourceSurveyDate': None, 'license': terrain['license'], 'licenseUrl': GSI_LICENSE,
            'attribution': GSI_CREDIT, 'originalBounds': dem['bbox'], 'outputBounds': bounds,
            'processing': ['Reuse publicly sourced GSI DEM5A PNG zoom-15 samples from the supplied DEM.',
                           f'Crop source rows {first_row}–{dem["rows"]-1}, inclusive; preserve every column and exact stored elevation.',
                           'Flatten rows south to north, with columns west to east.',
                           'No zero filling, synthetic terrain, smoothing, or replacement of missing values.'],
            'removedSourceRows': first_row, 'retainedMissingValues': 0, 'cols': cols, 'rows': rows,
            'vertexCount': len(heights), 'minMeters': min(heights), 'maxMeters': max(heights),
            'approximateGridSpacingMeters': 10, 'verticalDatum': 'Native GSI ground-elevation data; rigorous datum/survey-date verification not performed.',
            'limitations': ['Ground elevations omit structures, bridge decks, stair tread heights and vegetation.',
                           'About 10 m sampling cannot resolve small terrain or trail features.',
                           'Some mesh elevations and OSM tagged summit elevations differ; neither is field-surveyed here.']},
        'route': {
            'file': 'sample-route.gpx', 'name': route_name,
            'sourceUrl': routes['metadata']['source_url'], 'sourceRetrievalDate': routes['metadata']['retrieval_date'],
            'attribution': OSM_CREDIT, 'license': 'ODbL-1.0', 'licenseUrl': OSM_LICENSE, 'copyrightUrl': OSM_COPYRIGHT,
            'sourceWayIds': [int(s.split('/')[1]) for s in used_ways],
            'processing': ['Take supplied hachibuse_to_hatafuri route.',
                           'Join way/627560211 at the identical Hatafuri endpoint.',
                           'Join reversed way/165600418 at the identical trail endpoint.',
                           'Remove only duplicate shared endpoints; do not resample or fabricate horizontal geometry.',
                           'GPX elevation is bilinear interpolation of the cropped GSI ground grid, rounded to 0.01 m; it is not a GPS observation.'],
            'lengthMetersApprox': round(sum(distances),2), 'pointCount': len(coordinates),
            'maxSegmentMeters': round(max(distances),2), 'sampleBounds': {
                'west': min(p[0] for p in coordinates), 'south': min(p[1] for p in coordinates),
                'east': max(p[0] for p in coordinates), 'north': max(p[1] for p in coordinates)},
            'allPointsWithinTerrain': True, 'everySegmentMatchesSourceTrailEdge': True,
            'artificialConnectorCount': 0, 'approximate': True, 'recordedGpsTrack': False,
            'bridgeOrTunnelEdgesIncluded': False, 'currentAccessVerified': False, 'navigationDisclaimer': DISCLAIMER,
            'containsTimestamps': False},
        'peaks': {'file': 'sample-peaks.json', 'sourceUrl': osm['metadata']['source_url'],
                  'sourceRetrievalDate': osm['metadata']['retrieval_date'], 'count': len(peaks),
                  'attribution': OSM_CREDIT, 'license': 'ODbL-1.0', 'licenseUrl': OSM_LICENSE,
                  'elevationExplanation': 'elevation is approximate GSI ground sample for display placement; osmElevation preserves the public OSM tag when available. Names/coordinates are OSM features.'},
        'retainedOsmGeometry': {'file': 'sample-osm-source.geojson', 'purpose': 'Machine-readable route-edge and peak source subset for checking and reuse.',
                              'license': 'ODbL-1.0', 'licenseUrl': OSM_LICENSE, 'attribution': OSM_CREDIT},
        'inputChecksumsSha256': {name: hashlib.sha256((source/name).read_bytes()).hexdigest() for name in names},
        'licenseVerification': {'checkedDate': '2026-10-04', 'urls': [GSI_LICENSE, GSI_DOC, OSM_COPYRIGHT, OSM_LICENSE],
                               'notes': ['GSI content terms apply PDL 1.0 unless specifically stated otherwise. Source and processing credits retained.',
                                         'GSI tile index lists DEM tiles under content usable with attribution outside basic survey products.',
                                         'OSM-derived sample route, names and geometry remain under ODbL 1.0, independent of the application code license.']},
        'validation': {'finiteHeights': True, 'rectangularGrid': True, 'rowOrder': 'south_to_north',
                       'columnOrder': 'west_to_east', 'allPeaksWithinTerrain': True,
                       'routeLongerThan200Meters': True, 'maxRouteSegmentUnder100Meters': True,
                       'allRouteSegmentsInSource': True},
        'files': {name: {'sha256': hashlib.sha256((OUTPUT/name).read_bytes()).hexdigest(), 'bytes': (OUTPUT/name).stat().st_size}
                  for name in ['terrain.json','sample-route.gpx','sample-peaks.json','sample-osm-source.geojson']}}
    write_json('provenance.json', provenance)
    print(json.dumps({'bounds': bounds, 'cols': cols, 'rows': rows, 'vertices': len(heights),
        'min': min(heights), 'max': max(heights), 'routeMeters': round(sum(distances),2),
        'routePoints': len(coordinates), 'maxSegmentMeters': round(max(distances),2), 'peakCount': len(peaks)}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_directory', type=Path)
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    prepare(args.source_directory)
