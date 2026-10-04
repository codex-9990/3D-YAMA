#!/usr/bin/env python3
"""Rebuild the offline eastern Suma Alps demo from retained public source data.

Usage: python3 scripts/prepare-suma-data.py [source_directory]
The default source directory is public/data. No network or personal file access.
Inputs: sample-osm-source.geojson, four source-dem5a-15-X-Y.png tiles, and
source-seamlessphoto-17-114728-52065.jpg (the retained GSI aerial source).
Only Python's standard library is required. All writes stay in public/data.
"""
import argparse
import hashlib
import json
import math
import struct
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public' / 'data'
GSI_DOC = 'https://maps.gsi.go.jp/development/ichiran.html#dem'
GSI_DECODE = 'https://maps.gsi.go.jp/development/demtile.html'
GSI_LICENSE = 'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html'
OSM_LICENSE = 'https://opendatacommons.org/licenses/odbl/1-0/'
OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright'
GSI_CREDIT = '地理院タイル（標高タイル・空中写真）を加工して作成'
OSM_CREDIT = '© OpenStreetMap contributors'
CITY_ROUTE = 'https://www.city.kobe.lg.jp/i73375/kuyakusho/sumaku/syokaitorikumi/midokoro/sumahaikingmap2ru-to.html'
TOURISM = 'https://www.feel-kobe.jp/column/suma-alps/'
HYOGO = 'https://web.pref.hyogo.lg.jp/ks20/documents/hyogoviewguidebook.pdf'
DISCLAIMER = ('公開地図から作成した表示確認用の概略ルートです。実際に歩いた記録ではありません。'
               '通行可否・危険箇所・現況は未確認です。登山中のナビゲーションや安全判断には使用しないでください。')
# Native GSI DEM5A zoom-15 pixel indices, preserving all 69,360 height samples.
PIXEL_BOUNDS = (7342443, 3332151, 7342731, 3332390)  # west, north, east, south
DEM_TILES = [(28681,13016),(28681,13017),(28682,13016),(28682,13017)]
# Pale exposed ground traced approximately from the public GSI seamlessphoto
# mosaic at z17; origin tile (114726, 52064). The ring is NOT a surveyed boundary.
ROCK_RINGS_PIXELS = [
    [(608,428),(622,412),(648,401),(661,398),(676,402),(688,397),(704,402),(711,409),
     (729,410),(749,400),(754,411),(746,422),(743,438),(731,449),(714,444),(701,435),
     (690,439),(679,450),(670,465),(655,470),(647,458),(633,459),(626,452),(612,446),(608,428)],
    [(616,350),(628,343),(642,343),(654,333),(671,331),(682,338),(671,348),(655,353),
     (644,366),(630,366),(618,359),(616,350)],
    [(690,371),(697,363),(705,371),(714,379),(710,396),(700,402),(694,389),(690,371)],
]


def write_json(name, data, compact=False):
    (OUTPUT/name).write_text(json.dumps(data,ensure_ascii=False,allow_nan=False,
        separators=(',',':') if compact else None,indent=None if compact else 2)+'\n',encoding='utf-8')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def haversine(a,b):
    lon1,lat1,lon2,lat2=map(math.radians,(*a,*b))
    h=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 12742017.6*math.asin(min(1,math.sqrt(h)))


def inverse_pixel(x,y,zoom=15):
    n=256*2**zoom
    return [x/n*360-180,math.degrees(math.atan(math.sinh(math.pi*(1-2*y/n))))]


def read_png_rgb(path):
    """Strict 8-bit RGB/RGBA, non-interlaced PNG decoding with stdlib only."""
    data=path.read_bytes()
    assert data[:8]==b'\x89PNG\r\n\x1a\n'
    i=8;compressed=bytearray();header=None
    while i<len(data):
        length=struct.unpack('>I',data[i:i+4])[0];kind=data[i+4:i+8];chunk=data[i+8:i+8+length]
        assert zlib.crc32(kind+chunk)&0xffffffff==struct.unpack('>I',data[i+8+length:i+12+length])[0]
        if kind==b'IHDR':header=struct.unpack('>IIBBBBB',chunk)
        if kind==b'IDAT':compressed.extend(chunk)
        i+=length+12
        if kind==b'IEND':break
    width,height,depth,color,compression,filter_method,interlace=header
    assert (width,height,depth,compression,filter_method,interlace)==(256,256,8,0,0,0)
    assert color in (2,6)
    channels=3 if color==2 else 4;stride=width*channels
    raw=zlib.decompress(compressed);assert len(raw)==height*(stride+1)
    rows=[];previous=bytearray(stride)
    def paeth(a,b,c):
        p=a+b-c;pa,pb,pc=abs(p-a),abs(p-b),abs(p-c)
        return a if pa<=pb and pa<=pc else b if pb<=pc else c
    for row in range(height):
        start=row*(stride+1);f=raw[start];assert f<=4
        current=bytearray(raw[start+1:start+stride+1])
        for j in range(stride):
            a=current[j-channels] if j>=channels else 0;b=previous[j];c=previous[j-channels] if j>=channels else 0
            pred=(0,a,b,(a+b)//2,paeth(a,b,c))[f]
            current[j]=(current[j]+pred)&255
        rows.append(current);previous=current
    return [[tuple(row[x:x+3]) for x in range(0,stride,channels)] for row in rows]


def decode_dem(rgb):
    r,g,b=rgb;value=r*65536+g*256+b
    assert value!=8388608,'No missing DEM heights may be fabricated'
    return round((value if value<8388608 else value-16777216)/100,2)


def clip_ring(ring,b):
    """Clip the connected source woodland polygon to the display rectangle."""
    points=ring[:-1] if ring[0]==ring[-1] else ring[:]
    for axis,limit,sign in [(0,b['west'],1),(0,b['east'],-1),(1,b['south'],1),(1,b['north'],-1)]:
        result=[]
        for previous,current in zip(points[-1:]+points[:-1],points):
            pi=(previous[axis]-limit)*sign>=0;ci=(current[axis]-limit)*sign>=0
            if pi!=ci:
                t=(limit-previous[axis])/(current[axis]-previous[axis]);point=[previous[k]+t*(current[k]-previous[k]) for k in [0,1]];point[axis]=limit;result.append(point)
            if ci:result.append(current)
        points=result
    return points+[points[0]] if points else []


def prepare(source):
    osm=json.loads((source/'sample-osm-source.geojson').read_text())
    features={f['id']:f for f in osm['features']}
    tiles={pair:read_png_rgb(source/f'source-dem5a-15-{pair[0]}-{pair[1]}.png') for pair in DEM_TILES}
    west,north,east,south=PIXEL_BOUNDS;cols=east-west+1;rows=south-north+1
    heights=[decode_dem(tiles[x//256,y//256][y%256][x%256]) for y in range(south,north-1,-1) for x in range(west,east+1)]
    sw=inverse_pixel(west,south);ne=inverse_pixel(east,north)
    bounds=dict(west=sw[0],south=sw[1],east=ne[0],north=ne[1])
    row_latitudes=[inverse_pixel(west,y)[1] for y in range(south,north-1,-1)]
    latitude_error=max(abs(row_latitudes[i]-(sw[1]+(ne[1]-sw[1])*i/(rows-1)))*111319.49 for i in range(rows))
    grid_spacing=40075016.68557849/(256*2**15)*math.cos(math.radians((sw[1]+ne[1])/2))
    terrain={'id':'suma','name':'須磨アルプス・栂尾山〜横尾山〜馬の背〜東山付近','bounds':bounds,'cols':cols,'rows':rows,
        'heights':heights,'min':min(heights),'max':max(heights),'attribution':GSI_CREDIT,'sourceUrls':[GSI_DOC,GSI_DECODE],
        'license':'Public Data License 1.0 (GSI content terms)','licenseUrl':GSI_LICENSE,'rowOrder':'south_to_north',
        'columnOrder':'west_to_east','elevationUnit':'m','horizontalCrs':'EPSG:4326',
        'sourceResolutionMeters':5,'approximateGridSpacingMeters':round(grid_spacing,3),
        'rowLatitudes':row_latitudes,'gridCoordinateNote':'Native Web Mercator zoom-15 pixel sample rows; latitude bounds are a display approximation. Exact row latitudes are retained.',
        'maxLinearLatitudeErrorMeters':round(latitude_error,5),
        'noDataTreatment':'All native DEM5A samples present. No upsampling, added terrain noise, height modification or missing-value fill.'}
    write_json('terrain.json',terrain,compact=True)
    def inside(p):return bounds['west']<=p[0]<=bounds['east'] and bounds['south']<=p[1]<=bounds['north']
    def elevation(p):
        assert inside(p)
        x=(p[0]-bounds['west'])/(bounds['east']-bounds['west'])*(cols-1);y=(p[1]-bounds['south'])/(bounds['north']-bounds['south'])*(rows-1)
        i,j=min(cols-2,int(x)),min(rows-2,int(y));u,v=x-i,y-j
        return round((heights[j*cols+i]*(1-u)+heights[j*cols+i+1]*u)*(1-v)+(heights[(j+1)*cols+i]*(1-u)+heights[(j+1)*cols+i+1]*u)*v,2)
    main=features['way/201730066']['geometry']['coordinates'];stairs=features['way/369143234']['geometry']['coordinates']
    # The route ends at an existing OSM node near the eastern 253m summit. Do
    # not splice isolated OSM summit points into the mapped trail geometry.
    assert main[52]==[135.114787,34.6658741] and main[-1]==stairs[-1]
    coords=stairs+list(reversed(main[52:]))[1:]
    assert all(inside(p) for p in coords) and len(set(map(tuple,coords)))==len(coords)
    lengths=[haversine(a,b) for a,b in zip(coords,coords[1:])]
    route_name='須磨アルプス：400段階段 → 栂尾山 → 横尾山 → 馬の背 → 東山付近'
    namespace='http://www.topografix.com/GPX/1/1';ET.register_namespace('',namespace);tag=lambda s:'{'+namespace+'}'+s
    gpx=ET.Element(tag('gpx'),version='1.1',creator='3D-YAMA public sample builder')
    metadata=ET.SubElement(gpx,tag('metadata'));ET.SubElement(metadata,tag('name')).text=route_name
    ET.SubElement(metadata,tag('desc')).text=DISCLAIMER+' 標高は国土地理院DEMの地表高です。'
    copy=ET.SubElement(metadata,tag('copyright'),author='OpenStreetMap contributors');ET.SubElement(copy,tag('license')).text=OSM_LICENSE
    for url,title in [(OSM_COPYRIGHT,OSM_CREDIT),(GSI_DOC,GSI_CREDIT),(GSI_LICENSE,'GSI content terms')]:
        link=ET.SubElement(metadata,tag('link'),href=url);ET.SubElement(link,tag('text')).text=title
    track=ET.SubElement(gpx,tag('trk'));ET.SubElement(track,tag('name')).text=route_name
    ET.SubElement(track,tag('desc')).text='OSMの連続する階段・登山道形状を接続。'+DISCLAIMER
    ET.SubElement(track,tag('src')).text=OSM_CREDIT+' / '+GSI_CREDIT;segment=ET.SubElement(track,tag('trkseg'))
    for lon,lat in coords:
        pt=ET.SubElement(segment,tag('trkpt'),lat=f'{lat:.7f}',lon=f'{lon:.7f}');ET.SubElement(pt,tag('ele')).text=f'{elevation([lon,lat]):.2f}'
    ET.indent(gpx,space='  ');ET.ElementTree(gpx).write(OUTPUT/'sample-route.gpx',encoding='utf-8',xml_declaration=True)
    peaks=[]
    for id in ['node/6283028155','node/6283028156']:
        f=features[id];lon,lat=f['geometry']['coordinates'];props=f['properties']
        peaks.append({'id':id,'name':props['name'],'lon':lon,'lat':lat,'elevation':elevation([lon,lat]),
            'elevationSource':'GSI DEM bilinear ground sample; approximate','osmElevation':float(props['ele']),
            'sourceUrl':'https://www.openstreetmap.org/'+id,'attribution':OSM_CREDIT,'license':'ODbL-1.0'})
    write_json('sample-peaks.json',peaks)
    forest_ring=clip_ring(features['way/183677080']['geometry']['coordinates'][0],bounds)
    geometry_features=[]
    def add(id,kind,name,geometry,source_ids,provenance,**extra):
        geometry_features.append({'id':id,'kind':kind,'name':name,'geometry':geometry,'sourceIds':source_ids,
            'sourceUrl':'https://www.openstreetmap.org/'+source_ids[0] if source_ids else GSI_DOC,
            'provenance':provenance,'approximate':True,**extra})
    add('suma-woodland','forest','須磨アルプスの樹林帯',{'type':'Polygon','coordinates':[forest_ring]},['way/183677080'],
        'OSM natural=wood polygon, clipped to terrain extent. Source tag refers to MLIT 2006 woodland-area data; not an individual-tree survey.',
        license='ODbL-1.0',attribution=OSM_CREDIT,clippedToTerrain=True,
        exclusions=['umanose-rock-1','umanose-rock-2','umanose-rock-3'],
        renderingNote='Tree positions, species, heights and crown shapes are procedural illustration within this mapped envelope; exclude trails and rock polygons.')
    for i,ring in enumerate(ROCK_RINGS_PIXELS):
        polygon=[inverse_pixel(114726*256+x,52064*256+y,17) for x,y in ring]
        add(f'umanose-rock-{i+1}','bare_rock','馬の背の露岩（空中写真からの概略範囲）',{'type':'Polygon','coordinates':[polygon]},[],
            'Approximate visual interpretation of pale exposed ground on GSI seamlessphoto z17 tiles; correlated with the OSM 馬の背 point and official Kobe photos. No surveyed outline or artificial elevation offsets.',
            license='Public Data License 1.0 (GSI content terms)',attribution=GSI_CREDIT,
            sourceUrl='https://maps.gsi.go.jp/#17/34.665713/135.111742/&base=seamlessphoto&ls=seamlessphoto&disp=1',
            sourceTileUrls=[f'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/17/{x}/{y}.jpg' for x,y in [(114728,52065)]],
            interpretationAccuracyMeters=15,renderingNote='Rock color and sub-grid facets are visual interpretation; the DEM remains unmodified.')
    step_geometry={'type':'LineString','coordinates':stairs}
    add('togao-400-steps','steps','栂尾山への400段階段',step_geometry,['way/369143234'],
        'Exact OSM highway=steps alignment. Kobe City route item 19 and photo confirm the straight concrete staircase. City describes joining partway, then about 350 steps; no exact tread count is assigned to this mapped way.',
        evidenceUrls=[CITY_ROUTE,'https://www.city.kobe.lg.jp/images/29425/19.jpg'],
        alignmentConfidence='mapped',direction='ascending_start_to_end',directionSource='GSI DEM endpoint elevations',
        startElevation=elevation(stairs[0]),endElevation=elevation(stairs[-1]),surface='concrete',
        stepCount=None,displayWidthMeters=1.35,displayRiserMeters=0.18,dimensionsAreIllustrative=True)
    add('umanose-west-stairs','steps','馬の背西側の階段（位置概略）',{'type':'LineString','coordinates':list(reversed(main[95:106]))},['way/201730066'],
        'Stair existence is visible in the official tourism photo. This short western approach portion of the mapped footway is a photo/map-correlated approximate placement, not an OSM highway=steps tag or measured stair survey.',
        evidenceUrls=[TOURISM,'https://www.feel-kobe.jp/app/wp-content/uploads/suma-alps_023.jpg'],
        alignmentConfidence='photo_correlated_approximate',direction='descending_start_to_end',directionSource='GSI DEM endpoint elevations',
        stepCount=None,displayWidthMeters=0.9,displayRiserMeters=0.2,dimensionsAreIllustrative=True,
        interpretationAccuracyMeters=20,surface='unverified',renderingNote='Do not describe exact tread positions, construction, handrails or dimensions as measured.')
    for id,name,p,focus,source_ids,note in [
        ('landmark-umanose','馬の背',features['node/13946671193']['geometry']['coordinates'],'ridge',['node/13946671193'],'Named OSM cliff point; independently within 25m of the Hyogo Prefecture viewpoint coordinates.'),
        ('landmark-stairs','400段階段',[(stairs[0][0]+stairs[-1][0])/2,(stairs[0][1]+stairs[-1][1])/2],'stairs',['way/369143234'],'Display focus at midpoint of the mapped stair alignment.'),
        ('landmark-forest','樹林の登山道',main[155],'forest',['way/201730066','way/183677080'],'Display focus at an existing trail node inside the mapped woodland; not a named landmark.'),
        ('landmark-higashiyama','東山付近',main[52],'summit',['way/201730066'],'Endpoint at an existing ridge-trail node near the eastern summit in the official course; summit location is approximate, not a named OSM peak node.')]:
        add(id,'landmark',name,{'type':'Point','coordinates':p},source_ids,note,focusKey=focus,elevation=elevation(p))
    for f in geometry_features:
        if f['kind']=='steps':
            c=f['geometry']['coordinates'];f['lengthMetersApprox']=round(sum(haversine(a,b) for a,b in zip(c,c[1:])),2)
    feature_collection={'schemaVersion':1,'coordinateOrder':'longitude,latitude','horizontalCrs':'EPSG:4326',
        'description':'Geolocated scene aids; mapped alignments and aerial interpretations are distinguished from procedural visual detail.',
        'schema':{'kinds':['forest','bare_rock','steps','landmark'],'geometry':'GeoJSON Polygon, LineString or Point; lon/lat coordinates',
            'steps':'centerline in stored coordinate order; direction describes rise/fall; displayWidthMeters/displayRiserMeters are explicitly illustrative',
            'focusKey':'landmark Point only: ridge, stairs, forest, summit'},
        'features':geometry_features,'visualReferences':[
            {'url':CITY_ROUTE,'publisher':'Kobe City, Suma Ward','purpose':'Course sequence, concrete 400-step staircase and exposed ridge description','redistributed':False},
            {'url':TOURISM,'publisher':'Kobe Tourism Bureau / Feel KOBE','purpose':'Granite erosion, wooded surroundings and western approach stairs; photos viewed only, not bundled','redistributed':False},
            {'url':HYOGO,'publisher':'Hyogo Prefecture','purpose':'Independent 馬の背 viewpoint coordinate 34°39′56.7″N,135°06′43.1″E','redistributed':False}],
        'limitations':['No photogrammetry, LiDAR point cloud, current-condition inspection or measured individual-tree/stair survey.',
            'Five-meter source DEM cannot resolve a narrow knife-edge or individual steps; do not claim procedural sub-grid detail is measured.',
            'Aerial interpretation may include shadow/vegetation and its source image date is unverified.',DISCLAIMER]}
    write_json('sample-features.json',feature_collection)
    # Preserve original source files in the output, even when rebuilding elsewhere.
    input_names=['sample-osm-source.geojson','source-seamlessphoto-17-114728-52065.jpg']+[f'source-dem5a-15-{x}-{y}.png' for x,y in DEM_TILES]
    for name in input_names:
        if (source/name).resolve()!=(OUTPUT/name).resolve():(OUTPUT/name).write_bytes((source/name).read_bytes())
    sampled_check=[{'pixel':[x,y],'elevationMeters':decode_dem(tiles[x//256,y//256][y%256][x%256])} for x,y in [(west,south),(east,south),(west,north),(east,north),((west+east)//2,(north+south)//2)]]
    provenance={'schemaVersion':2,'id':'suma','preparedDate':'2026-10-04',
        'description':'Eastern Suma Alps public map sample containing the actual 馬の背 region. No private tracks, personal photographs, account data or activity logs.',
        'replaces':'Earlier 919m 鉢伏山〜旗振山〜鉄拐山 sample did not include 馬の背; it is no longer the bundled demo.',
        'terrain':{'file':'terrain.json','sourceName':'GSI DEM5A PNG elevation tiles','sourceUrls':[GSI_DOC,GSI_DECODE],
            'sourceRetrievalDate':'2026-10-04','sourceSurveyDate':None,'license':terrain['license'],'licenseUrl':GSI_LICENSE,'attribution':GSI_CREDIT,
            'tileTemplate':'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/15/{x}/{y}.png',
            'sourceTiles':[{'x':x,'y':y,'zoom':15,'file':f'source-dem5a-15-{x}-{y}.png','url':f'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/15/{x}/{y}.png'} for x,y in DEM_TILES],
            'nativePixelBounds':{'west':west,'north':north,'east':east,'south':south},'outputBounds':bounds,'cols':cols,'rows':rows,'vertexCount':len(heights),
            'sourceResolutionMeters':5,'approximateGridSpacingMeters':round(grid_spacing,3),'maxLinearLatitudeErrorMeters':round(latitude_error,5),
            'minMeters':min(heights),'maxMeters':max(heights),'retainedMissingValues':0,'sampleChecks':sampled_check,
            'processing':['Decode each native zoom-15 RGB elevation using the published signed-centimeter formula.',
                'Retain every pixel in the selected rectangle, reorder south-to-north and west-to-east. Preserve every decoded height exactly.',
                'No resampling, smoothing, height exaggeration, invented rock relief, upsampling or missing-value filling in this dataset.',
                'The viewer uses regular latitude interpolation; exact native row latitudes and less-than-two-centimeter mapping discrepancy are disclosed.'],
            'limitations':['The source is a nominal 5m DEM; ~3.93m rendered tile samples do not imply finer survey accuracy.',
                'GSI itself linearly processes original DEM into map tiles. Narrow rock pinnacles, stair treads, tree positions and structures are unresolved.',
                'GSI source survey date and vertical accuracy for this tile were not independently audited.']},
        'route':{'file':'sample-route.gpx','name':route_name,'sourceUrl':osm['metadata']['source_url'],'sourceRetrievalDate':osm['metadata']['retrieval_date'],
            'attribution':OSM_CREDIT,'license':'ODbL-1.0','licenseUrl':OSM_LICENSE,'copyrightUrl':OSM_COPYRIGHT,
            'sourceWayIds':[369143234,201730066],'sourceMainWayIndicesInclusive':[52,193],
            'processing':['Use the entire mapped steps way/369143234, then join reversed way/201730066 indices 193 through 52 at the identical shared endpoint.',
                'Remove only the duplicate shared endpoint. Do not snap to separate peak nodes, resample horizontal geometry or invent trail connectors.',
                'GPX elevations are approximate bilinear display samples of the native GSI grid, rounded to 0.01m. They are not GPS observations.'],
            'lengthMetersApprox':round(sum(lengths),2),'pointCount':len(coords),'maxSegmentMeters':round(max(lengths),2),
            'sampleBounds':dict(west=min(p[0] for p in coords),east=max(p[0] for p in coords),south=min(p[1] for p in coords),north=max(p[1] for p in coords)),
            'allPointsWithinTerrain':True,'everySegmentMatchesSourceTrailEdge':True,'artificialConnectorCount':0,
            'approximate':True,'recordedGpsTrack':False,'bridgeOrTunnelEdgesIncluded':False,'currentAccessVerified':False,'containsTimestamps':False,
            'navigationDisclaimer':DISCLAIMER},
        'peaks':{'file':'sample-peaks.json','count':len(peaks),'sourceUrl':osm['metadata']['source_url'],'attribution':OSM_CREDIT,'license':'ODbL-1.0',
            'note':'Two named OSM summit nodes. They need not exactly intersect the mapped trail. 東山付近 is an approximate route-end landmark, not a surveyed summit point.'},
        'sceneFeatures':{'file':'sample-features.json','mappedSteps':1,'photoCorrelatedApproximateSteps':1,'forestPolygons':1,'aerialInterpretedRockPolygons':3,
            'umanosePoint':[135.1117415,34.6657126],'hyogoViewpoint':[135+6/60+43.1/3600,34+39/60+56.7/3600],
            'independentViewpointSeparationMeters':round(haversine([135.1117415,34.6657126],[135+6/60+43.1/3600,34+39/60+56.7/3600]),2),
            'rockInterpretationPixelRings':ROCK_RINGS_PIXELS,'rockInterpretationTileOrigin':{'zoom':17,'x':114726,'y':52064},
            'tourismPhotographsBundled':False,'gsiAerialReferenceFile':'source-seamlessphoto-17-114728-52065.jpg','surveyedStairDimensions':False,'surveyedIndividualTrees':False},
        'retainedOsmGeometry':{'file':'sample-osm-source.geojson','purpose':'Complete source geometry for each used OSM trail, forest and named point.','license':'ODbL-1.0','attribution':OSM_CREDIT},
        'inputChecksumsSha256':{name:sha(source/name) for name in input_names},
        'validation':{'finiteHeights':True,'rectangularGrid':True,'nativeDemHeightsUnmodified':True,'allRouteSegmentsInSource':True,
            'routeWithinTerrain':True,'umanoseWithinTerrain':True,'routeApproachesUmanoseMeters':round(min(haversine(p,[135.1117415,34.6657126]) for p in coords),2)},
        'files':{name:{'sha256':sha(OUTPUT/name),'bytes':(OUTPUT/name).stat().st_size} for name in ['terrain.json','sample-route.gpx','sample-peaks.json','sample-features.json']+input_names}}
    write_json('provenance.json',provenance)
    print(json.dumps({'bounds':bounds,'cols':cols,'rows':rows,'vertices':len(heights),'sourceResolutionMeters':5,
        'tileSampleSpacingMeters':round(grid_spacing,3),'latitudeDisplayErrorMeters':latitude_error,'min':min(heights),'max':max(heights),
        'routeMeters':round(sum(lengths),2),'routePoints':len(coords),'maxSegmentMeters':round(max(lengths),2),'featureCount':len(geometry_features)},ensure_ascii=False,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source_directory',type=Path,nargs='?',default=OUTPUT)
    args=parser.parse_args();OUTPUT.mkdir(parents=True,exist_ok=True);prepare(args.source_directory)
