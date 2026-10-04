"""Original procedural Japanese trail assets. Run with Blender 4.3+:
blender -b --factory-startup -t 2 --python assets/blender/generate_trail_assets.py
No external textures, assets, dependencies, or measured-site claims.
"""
from pathlib import Path
import json, math, random
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'models'
SOURCE = ROOT / 'assets' / 'blender'
RNG = random.Random(40273)
TAU = 2 * math.pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for block in list(bpy.data.materials):
    bpy.data.materials.remove(block)


def material(name, roughness, double=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (.24, .32, .17, 1)
    p = mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = 0
    p.inputs['Specular IOR Level'].default_value = .2
    vc = mat.node_tree.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Color'
    mat.node_tree.links.new(vc.outputs['Color'], p.inputs['Base Color'])
    mat.use_backface_culling = not double
    return mat

BARK = material('Weathered_bark_vertex_color', .96)
LEAF = material('Broadleaf_foliage_vertex_color', .86, True)
PINE = material('Pine_needles_vertex_color', .90, True)
STONE = material('Pale_weathered_stone_vertex_color', .98)
TIMBER = material('Weathered_timber_vertex_color', .96)


def color(base, variance=.13):
    f = RNG.uniform(1-variance, 1+variance)
    return tuple(max(.002, min(.95, v*f)) for v in base) + (1,)


class Mesh:
    def __init__(self):
        self.vertices, self.faces, self.colors, self.smooth = [], [], [], []

    def add(self, verts, faces, colors, smooth=False):
        offset = len(self.vertices)
        self.vertices.extend([tuple(v) for v in verts])
        self.faces.extend([tuple(i+offset for i in f) for f in faces])
        if len(colors) == 4 and isinstance(colors[0], (int, float)):
            self.colors.extend([colors] * len(verts))
        else:
            self.colors.extend(colors)
        self.smooth.extend([smooth] * len(faces))

    def object(self, name, mat, collection):
        data = bpy.data.meshes.new(name + '_Geometry')
        data.from_pydata(self.vertices, [], self.faces)
        data.update()
        attr = data.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='POINT')
        for idx, col in enumerate(self.colors):
            attr.data[idx].color = col
        for p, smooth in zip(data.polygons, self.smooth):
            p.use_smooth = smooth
        obj = bpy.data.objects.new(name, data)
        collection.objects.link(obj)
        obj.data.materials.append(mat)
        obj['original_procedural_asset'] = True
        obj['units'] = 'meters; base at ground origin; glTF export is Y-up'
        return obj


def frame(direction):
    n = Vector(direction).normalized()
    axis = Vector((0, 0, 1)) if abs(n.z) < .92 else Vector((1, 0, 0))
    u = n.cross(axis).normalized()
    return u, n.cross(u).normalized(), n


def tube(mesh, points, radii, sides, base=(.21, .17, .115), ribs=True):
    verts, cols, faces = [], [], []
    phase = RNG.random() * TAU
    for i, point in enumerate(points):
        p = Vector(point)
        direction = Vector(points[min(i+1, len(points)-1)]) - Vector(points[max(i-1, 0)])
        u, v, _ = frame(direction)
        for j in range(sides):
            angle = TAU*j/sides + phase
            ridge = 1 + (.07 if j % 2 else -.055) if ribs else 1
            radius = radii[i] * ridge * (1 + .025*math.sin(i*3+j*8))
            verts.append(p + radius*(u*math.cos(angle)+v*math.sin(angle)))
            # Fine circumferential contrast continues as long bark ridges.
            shade = (.88 if j % 2 == 0 else 1.08) * RNG.uniform(.96, 1.04)
            cols.append(tuple(c*shade for c in base) + (1,))
    for i in range(len(points)-1):
        for j in range(sides):
            a, b = i*sides+j, i*sides+(j+1)%sides
            c, d = a+sides, b+sides
            faces.extend([(a, b, d), (a, d, c)])
    faces.extend([tuple(reversed(range(sides))), tuple((len(points)-1)*sides+j for j in range(sides))])
    mesh.add(verts, faces, cols, True)


def broadleaf(mesh, center, length, yaw, tilt, base):
    direction = Vector((math.cos(yaw)*math.cos(tilt), math.sin(yaw)*math.cos(tilt), math.sin(tilt)))
    width = Vector((-math.sin(yaw), math.cos(yaw), RNG.uniform(-.25,.25))).normalized()*length*.23
    root = Vector(center) - direction*length*.5
    tip = root + direction*length
    mid = root + direction*length*.48
    verts = [root, mid-width, tip+Vector((0,0,length*.055)), mid+width+Vector((0,0,length*.04))]
    dark = tuple(x*.76 for x in base[:3]) + (1,)
    light = tuple(x*1.12 for x in base[:3]) + (1,)
    mesh.add(verts, [(0,1,2),(0,2,3)], [dark,base,base,light], True)


def leaf_cluster(mesh, center, n=16, spread=.39):
    for k in range(n):
        yaw = RNG.random()*TAU
        radius = spread*math.sqrt(RNG.random())
        p = Vector(center)+Vector((math.cos(yaw)*radius, math.sin(yaw)*radius, RNG.uniform(-.24,.22)))
        length = RNG.uniform(.26,.41)
        base = color((.062,.153,.037) if k%4 else (.092,.203,.052), .30)
        broadleaf(mesh, p, length, yaw+RNG.uniform(-.7,.7), RNG.uniform(-.62,.75), base)


def broadleaf_tree(collection):
    bark, leaves = Mesh(), Mesh()
    trunk = [Vector((.09*math.sin(i*.8), .06*math.sin(i*.47), i*.48)) for i in range(15)]
    tube(bark, trunk, [.27*(1-i/16)**1.1+.014 for i in range(15)], 12)
    # Asymmetric visible buttress roots, emerging into the forest floor.
    for j in range(7):
        a = j*TAU/7+RNG.uniform(-.12,.12)
        tube(bark, [(0,0,.20),(.30*math.cos(a),.30*math.sin(a),.11),(.65*math.cos(a),.65*math.sin(a),.018)], [.13,.075,.005], 6)
    for i in range(13):
        angle = i*2.399963 + RNG.uniform(-.26,.26)
        z = 2.45 + i*.255
        start = Vector((.09*math.sin(z/.48*.8), .06*math.sin(z/.48*.47),z))
        reach = RNG.uniform(1.6,2.4)*(1-.27*max(0,(z-4.7)/1.6))
        outward = Vector((math.cos(angle),math.sin(angle),0))
        end = start + outward*reach + Vector((0,0,RNG.uniform(1.20,2.03)))
        bend = start.lerp(end,.48) + Vector((0,0,-.12))
        tube(bark, [start,bend,end], [.112*(1-i*.033),.052,.014], 7)
        for j in range(4):
            t = .40+j*.19
            base = bend.lerp(end, max(0,(t-.48)/.52)) if t>.48 else start.lerp(bend,t/.48)
            a = angle + (-1 if j%2 else 1)*RNG.uniform(.55,1.15)
            tip = base+Vector((math.cos(a)*RNG.uniform(.42,.80),math.sin(a)*RNG.uniform(.42,.80),RNG.uniform(.20,.55)))
            tube(bark,[base,base.lerp(tip,.55),tip],[.033,.019,.0035],5)
            leaf_cluster(leaves,tip,36,.42)
            if j in (1,3):
                shoot = tip + Vector((-.20*math.sin(a),.20*math.cos(a),.31))
                tube(bark,[tip,shoot],[.010,.0018],4)
                leaf_cluster(leaves,shoot,24,.30)
    leaf_cluster(leaves, (.1,-.12,6.91),44,.44)
    return [bark.object('BroadleafBark', BARK, collection), leaves.object('BroadleafLeaves',LEAF,collection)]


def needle_tuft(mesh, center, spread=.42):
    center = Vector(center)
    # Individual faceted needles form uneven fans, with true empty gaps.
    for i in range(29):
        a = RNG.random()*TAU
        r = RNG.uniform(.05,spread)
        p = center + Vector((math.cos(a)*r, math.sin(a)*r, RNG.uniform(-.07,.07)))
        _, side, n = frame((math.cos(a)*.9, math.sin(a)*.9, RNG.uniform(.35,1.15)))
        length = RNG.uniform(.24,.43)
        width = side*RNG.uniform(.020,.033)
        tip = p+n*length
        ridge = p+n*length*.36+Vector((0,0,.018))
        base = color((.042,.109,.043),.33)
        lighter = tuple(c*1.22 for c in base[:3])+(1,)
        mesh.add([p-width,p+width,tip,ridge],[(0,3,2),(3,1,2)],[base,base,lighter,lighter], True)


def pine_tree(collection):
    bark, needles = Mesh(), Mesh()
    trunk = [Vector((.045*i+.16*math.sin(i*.60),.08*math.sin(i*.71),i*.62)) for i in range(14)]
    tube(bark,trunk,[.28*(1-i/14)**1.0+.009 for i in range(14)],14,(.225,.14,.087))
    for j in range(5):
        a = TAU*j/5
        tube(bark,[(0,0,.24),(.25*math.cos(a),.25*math.sin(a),.12),(.63*math.cos(a),.63*math.sin(a),.015)],[.12,.065,.004],6,(.20,.135,.085))
    for i in range(11):
        z = 3.12+i*.43
        a = i*2.39996+.6
        start = trunk[min(12,int(z/.62))].copy(); start.z=z
        # Broad lateral/upswept limbs form broken parasol pads, never stacked cones.
        reach = RNG.uniform(1.45,2.22) if i<7 else RNG.uniform(1.04,1.65)
        direction=Vector((math.cos(a),math.sin(a),0))
        middle=start+direction*reach*.56+Vector((0,0,-.05))
        end=start+direction*reach+Vector((0,0,.46))
        tube(bark,[start,middle,end],[.12*(1-i*.055),.05,.014],7,(.24,.147,.086))
        for j in range(4):
            base=middle.lerp(end,.2+j*.22)
            yaw=a+(-1 if j%2 else 1)*RNG.uniform(.6,1.45)
            tip=base+Vector((math.cos(yaw)*.6,math.sin(yaw)*.6,RNG.uniform(.15,.45)))
            tube(bark,[base,tip],[.03,.003],5,(.20,.145,.087))
            needle_tuft(needles,tip)
            needle_tuft(needles,tip+Vector((.17*math.cos(yaw),.17*math.sin(yaw),.15)),.31)
    for j in range(6):
        a=j*TAU/6
        needle_tuft(needles,trunk[-1]+Vector((.42*math.cos(a),.42*math.sin(a),.08)),.38)
    return [bark.object('PineBark',BARK,collection),needles.object('PineNeedles',PINE,collection)]


def low_lobe(mesh, center, radii, base):
    # An irregular 8-sided ring makes a non-spherical, 16-triangle lobe.
    verts=[Vector(center)+Vector((0,0,radii[2]))]
    for j in range(8):
        a=j*TAU/8
        verts.append(Vector(center)+Vector((math.cos(a)*radii[0]*RNG.uniform(.86,1.09),math.sin(a)*radii[1]*RNG.uniform(.86,1.09),radii[2]*RNG.uniform(-.20,.20))))
    verts.append(Vector(center)-Vector((0,0,radii[2]*.61)))
    faces=[]
    for j in range(8):
        a=1+j;b=1+(j+1)%8
        faces.extend([(0,a,b),(9,b,a)])
    mesh.add(verts,faces,[color(base,.25) for _ in verts],True)


def low_tree(collection,pine=False):
    bark,foliage=Mesh(),Mesh()
    if pine:
        points=[(0,0,0),(.3,.03,3.5),(.46,-.05,6.1),(.69,.04,8.1)]
        name='PineLow'; mat=PINE; base=(.043,.12,.049)
        radii=[.28,.19,.10,.008]
    else:
        points=[(0,0,0),(.09,.04,2.6),(-.04,-.06,4.9),(.09,.01,6.7)]
        name='BroadleafLow'; mat=LEAF; base=(.06,.15,.037)
        radii=[.28,.20,.10,.008]
    tube(bark,points,radii,6)
    for i in range(12):
        a=i*2.399963
        z=(3.7+i*.36) if pine else (4.05+i*.20)
        reach=(1.70-i*.055) if pine else (1.6-(max(0,i-7)*.1))
        center=(math.cos(a)*reach+.3 if pine else math.cos(a)*reach,math.sin(a)*reach,z)
        if i%2==0:
            tube(bark,[(.2 if pine else 0,0,z-.7),center],[.085,.008],3)
        low_lobe(foliage,center,(.80,.75,.27) if pine else (.85,.8,.72),base)
    low_lobe(foliage,(.60,0,8.22) if pine else (.05,0,6.86),(.78,.72,.30) if pine else (.8,.72,.50),base)
    return [bark.object(name+'Bark',BARK,collection),foliage.object(name+('Needles' if pine else 'Leaves'),mat,collection)]


def boulder(collection):
    # Eroded stratified/fissured irregular rock, 320 triangles, no sphere scaling artifact.
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3,radius=1)
    obj=bpy.context.object; obj.name='Boulder'; obj.data.name='Boulder_Geometry'
    for c in list(obj.users_collection):c.objects.unlink(obj)
    collection.objects.link(obj)
    for v in obj.data.vertices:
        p=v.co.copy(); angle=math.atan2(p.y,p.x)
        warp=1+.10*math.sin(angle*5+p.z*4)+.065*math.sin(p.x*14+p.y*10)
        v.co.x=p.x*warp*.96
        v.co.y=p.y*warp*.72
        v.co.z=max(0,(p.z+.74)*.57)
        if v.co.z>.78:v.co.z=.78+(v.co.z-.78)*.48
    attr=obj.data.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='POINT')
    for v in obj.data.vertices:
        p=v.co; seam=.055*math.sin(p.z*38+p.x*6+p.y*4)
        shade=.80+.20*max(0,p.z)+seam+RNG.uniform(-.09,.09)
        moss=.68 if p.z<.19 and RNG.random()<.6 else 1
        attr.data[v.index].color=(.51*shade*moss,.47*shade*(.85+.15*moss),.385*shade*moss,1)
    # Preserve facets at creases, with smaller smooth worn surfaces between.
    for p in obj.data.polygons:p.use_smooth=False
    obj.data.materials.append(STONE)
    obj['original_procedural_asset']=True
    return obj


def timber_step(collection):
    mesh=Mesh()
    # Low, deeply weathered transverse beam; X width, Blender Y depth, base Z=0.
    # Five long wavy strips on each face create real ridges without textures.
    nx=9
    ring=[(-.10,0),(.10,0),(.12,.04),(.12,.17),(.085,.205),(-.087,.205),(-.12,.17),(-.12,.04)]
    verts=[];cols=[];faces=[]
    for i in range(nx):
        x=-.76+i*1.52/(nx-1)
        for j,(y,z) in enumerate(ring):
            verts.append((x,y+RNG.uniform(-.009,.009),max(0,z+RNG.uniform(-.008,.008))))
            cols.append(color((.27,.225,.16),.18))
    for i in range(nx-1):
        for j in range(8):
            a=i*8+j;b=i*8+(j+1)%8
            faces.extend([(a,b,b+8),(a,b+8,a+8)])
    faces.extend([tuple(reversed(range(8))),tuple((nx-1)*8+j for j in range(8))])
    mesh.add(verts,faces,cols)
    # Dark narrow splinters and age cracks lie on the top surface.
    for i in range(10):
        x=RNG.uniform(-.70,.30);end=min(.73,x+RNG.uniform(.14,.62));y=RNG.uniform(-.073,.073)
        mesh.add([(x,y,.211),(end,y+.003,.211),(end-.055,y+.007,.212),(x+.025,y+.004,.212)],[(0,1,2),(0,2,3)],(.115,.091,.062,1))
    # Two worn stake heads belong to the reusable illustrative trail component.
    for x in (-.55,.55):
        tube(mesh,[(x,.006,.12),(x+.003,.004,.225)],[.021,.023],8,(.16,.135,.09),False)
    return mesh.object('TimberStep',TIMBER,collection)


def collection(name):
    c=bpy.data.collections.new(name);bpy.context.scene.collection.children.link(c);return c

high=collection('HIGH_original_assets')
low=collection('LOW_distance_assets')
high_objects=broadleaf_tree(high)+pine_tree(high)+[boulder(high),timber_step(high)]
low_objects=low_tree(low)+low_tree(low,True)

# Canonical meter heights remain stable if foliage detail changes.
for prefix, height in [('Broadleaf', 8.0), ('Pine', 8.5)]:
    top = max(v.co.z for o in high_objects if o.name.startswith(prefix) for v in o.data.vertices)
    for obj in high_objects:
        if obj.name.startswith(prefix):
            for v in obj.data.vertices: v.co.z *= height / top

# Roots meet the ground plane; low and high silhouettes share exact top heights.
for obj in high_objects + low_objects:
    for v in obj.data.vertices:
        v.co.z = max(0.0, v.co.z)
for low_prefix, high_prefix in [('BroadleafLow', 'Broadleaf'), ('PineLow', 'Pine')]:
    top = max(v.co.z for o in high_objects if o.name.startswith(high_prefix) for v in o.data.vertices)
    low_top = max(v.co.z for o in low_objects if o.name.startswith(low_prefix) for v in o.data.vertices)
    for obj in low_objects:
        if obj.name.startswith(low_prefix):
            for v in obj.data.vertices: v.co.z *= top / low_top

# Triangulate explicitly and preserve mesh/material identity for stable instancing.
for obj in high_objects+low_objects:
    bpy.context.view_layer.objects.active=obj
    obj.select_set(True)
    mod=obj.modifiers.new('Triangulate_for_GLTF','TRIANGULATE')
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)

OUT.mkdir(exist_ok=True,parents=True)
SOURCE.mkdir(exist_ok=True,parents=True)
for filename,objects in [('trail-assets.glb',high_objects),('trail-assets-low.glb',low_objects)]:
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/filename),export_format='GLB',use_selection=True,export_yup=True,export_texcoords=False,export_normals=True,export_materials='EXPORT',export_extras=True,export_animations=False)

summary={}
for obj in high_objects+low_objects:
    coords=[v.co for v in obj.data.vertices]
    summary[obj.name]={'triangles':len(obj.data.polygons),'vertices':len(coords),'bounds_blender_z_up':{'min':[round(min(v[i] for v in coords),4) for i in range(3)],'max':[round(max(v[i] for v in coords),4) for i in range(3)]},'material':obj.data.materials[0].name}
(SOURCE/'asset-manifest.json').write_text(json.dumps(summary,indent=2)+'\n')

# In the editable source, view one species at a time using the named collections.
for obj in low_objects:obj.hide_set(True)
for obj in high_objects:
    if not obj.name.startswith('Broadleaf'):obj.hide_set(True)
bpy.ops.object.select_all(action='DESELECT')
for obj in high_objects[:2]:obj.hide_set(False);obj.select_set(True)
bpy.context.view_layer.objects.active=high_objects[0]
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'trail-assets.blend'),compress=True)
print('ASSET_MANIFEST',json.dumps(summary))
