"""Optional lightweight QA contact sheet. Open source .blend first, then run this."""
import bpy
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parent
scene=bpy.context.scene
for obj in list(bpy.data.objects):
    obj.hide_set(False)
    obj.hide_render=obj.name.startswith(('BroadleafLow','PineLow'))
    if obj.name.startswith('Broadleaf') and 'Low' not in obj.name:obj.location.x=-3.3
    if obj.name.startswith('Pine') and 'Low' not in obj.name:obj.location.x=3.3
    if obj.name=='Boulder':obj.location=(-.9,-3.0,0)
    if obj.name=='TimberStep':obj.location=(2,-3.0,0)
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.025))
mat=bpy.data.materials.new('Preview_ground');mat.diffuse_color=(.29,.31,.25,1);bpy.context.object.data.materials.append(mat)
world=bpy.data.worlds.new('Preview_world');world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(.64,.71,.77,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.6
scene.world=world
bpy.ops.object.light_add(type='AREA',location=(-5,-8,15))
bpy.context.object.data.energy=1600;bpy.context.object.data.shape='DISK';bpy.context.object.data.size=9
bpy.context.object.rotation_euler=(Vector((0,0,3))-bpy.context.object.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(12,-24,12))
cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,4))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=15.2;scene.camera=cam
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=12;scene.cycles.use_denoising=False
scene.render.resolution_x=900;scene.render.resolution_y=720;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
scene.render.image_settings.file_format='PNG';scene.render.filepath=str(ROOT/'asset-preview.png')
bpy.ops.render.render(write_still=True)
