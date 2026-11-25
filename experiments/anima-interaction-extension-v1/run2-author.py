# SPDX-License-Identifier: GPL-3.0-only
"""DC-RUN2 authoring: DeepSeek leads Claude hand-in-hand across a night field,
running right-and-away, heads turned toward the camera, DeepSeek's free arm
pointing at the sky. CPU-only; no diffusion inputs, no generated images."""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, maximum_filter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import contacts  # noqa: E402
import geometry  # noqa: E402

STRUCTURE = Path(os.environ.get('YUGANG_STRUCTURE_DIR', str(Path.home() / 'yugang-anima-interaction-run-20261111-e970eb55/anima-interaction-v1/stages/contact-camera-extension-20261112/sources/old-structure')))
OUT = Path(os.environ.get('YUGANG_OUT_DIR', str(Path.home() / 'yugang-anima-interaction-run-20261111-e970eb55/anima-interaction-v1/stages/run2-20261112')))
os.environ['YUGANG_RS_SRC'] = str(STRUCTURE.parent / 'rs')
os.environ['YUGANG_RS_STAGE'] = str(OUT / 'sources' / 'rs-stage')
sys.path.insert(0, str(STRUCTURE))

import geometry_core as G  # noqa: E402
import frozen_poses as FP  # noqa: E402

BODY_YAW = 100.0          # run right-and-slightly-away from the +Z camera
HEAD_TOTAL = 45.0         # split chest/neck/head so faces stay readable
CASE = 'DC-D5'
CAMERA = {'center': [.28, .62], 'height_h': .25, 'pitch': 8, 'roll': 0}


def make_run2(G_, FP_, yaw_sign):
    people = [G_.mkperson(1, [-.22, 0, .32], [0, 0, 0], {}),
              G_.mkperson(2, [.22, .02, -.18], [0, 0, 0], {})]
    for p in people:  # distribute the look-toward-camera turn before arm solves
        p['joints'].setdefault('chest', [0., 0., 0.])[0] += yaw_sign * HEAD_TOTAL / 4.5
    residuals = {}
    for i, p in enumerate(people):
        origin = np.array(p['position'])
        for side, sign in (('left', 1 if i == 0 else -1), ('right', -1 if i == 0 else 1)):
            x = .12 if side == 'left' else -.12
            targets = {side + '_knee': origin + [x, .62, .26 * sign],
                       side + '_ankle': origin + [x, .16 if sign > 0 else .28, .44 * sign]}
            residuals[f'{i}.{side}.stride'] = solve(p, [side + '_hip', side + '_knee'], targets, G_)
    points = [G_.control_points(p) for p in people]
    clasp = (points[0]['chest'] + points[1]['chest']) / 2
    clasp[1] = 1.02
    for i, (p, side, slot) in enumerate(((people[0], 'left', 'A'), (people[1], 'right', 'B'))):
        p['joints'].update(FP_.hand_interlock_joints(slot, side))
        residuals[f'{i}.clasp'] = solve(p, [side + '_shoulder', side + '_elbow'],
                                        {side + '_wrist': clasp + [0, 0, .006 * (2 * i - 1)]}, G_)
    a0 = np.array(people[0]['position'])
    residuals['0.point'] = solve(people[0], ['right_shoulder', 'right_elbow'],
                                 {'right_wrist': a0 + [-.18, 1.78, .55]}, G_)
    b0 = np.array(people[1]['position'])
    residuals['1.swing'] = solve(people[1], ['left_shoulder', 'left_elbow'],
                                 {'left_wrist': b0 + [.30, 1.12, -.15]}, G_)
    for p in people:  # neck/head share the remaining turn after arms are solved
        for bone, share in (('neck', .5), ('head', .5)):
            p['joints'].setdefault(bone, [0., 0., 0.])[0] += yaw_sign * HEAD_TOTAL * share
    r = G_._rs()['pose3d'].rotation([0, BODY_YAW, 0])
    for p in people:
        p['position'] = (np.array(p['position']) @ r.T).tolist()
        p['rotation'][1] += BODY_YAW
    pa, pb = [G_.control_points(p) for p in people]
    edges = [{'kind': 'interlaced_hands', 'owners': ['A', 'B'], 'parts': ['left_wrist', 'right_wrist'],
              'world': [pa['left_wrist'].tolist(), pb['right_wrist'].tolist()], 'limit_h': .04}]
    height = 1.6
    for edge in edges:
        edge['distance'] = float(np.linalg.norm(np.array(edge['world'][0]) - np.array(edge['world'][1])))
        edge['distance_h'] = edge['distance'] / height
        if edge['distance_h'] > edge['limit_h']:
            raise ValueError(f'RUN2 unresolved reference contact: {edge}')
    travel = r @ np.array([0., 0., 1.])
    lead = float((np.array(people[0]['position']) - np.array(people[1]['position'])) @ travel)
    if lead <= 0:
        raise ValueError(f'RUN2 DeepSeek is not leading along travel: {lead}')
    faces = []
    for p in people:
        _, forward = contacts.head_lip(p, G_)
        faces.append(float(forward @ np.array([0., 0., 1.])))
    return {'kind': 'RUN2', 'people': people, 'contacts': edges, 'head': {'face_toward_camera_dot': faces},
            'authoring_residuals': residuals, 'lead_offset': lead, 'finger_interlock_guaranteed': False,
            'authoring_only_no_generated_images': True}


def solve(person, controls, targets, G_):
    return contacts.solve_chain(person, controls, targets, G_)


def main():
    rs = G._rs()
    world = None
    for sign in (1, -1):
        try:
            candidate = make_run2(G, FP, sign)
            if min(candidate['head']['face_toward_camera_dot']) >= .15:
                world = candidate
                world['head']['yaw_sign'] = sign
                break
        except ValueError as error:
            print(json.dumps({'attempt': sign, 'rejected': str(error)[:160]}), flush=True)
    if world is None:
        raise SystemExit('RUN2 authoring failed for both yaw signs')
    tail = FP.TAIL_DEEPSEEK
    base = G.build_scene(world['people'], {'position': [0, 1, 5], 'target': [0, 1, 0], 'fov': 38})
    camera, extension = geometry.fit_camera(base, CAMERA, rs['pose3d'], rs['mhr'], tail)
    scene = G.build_scene(world['people'], camera)
    arrays, info = geometry.project_scene(scene, extension, rs['pose3d'], rs['mhr'])
    masks, contact_edges = contacts.contact_masks(world, scene, extension, rs['pose3d'])
    arrays.update(masks)
    union = (arrays['owner_a'] > 0) | (arrays['owner_b'] > 0)
    grown = maximum_filter(union.astype(np.uint8), size=25, mode='constant')
    feather = gaussian_filter(grown.astype(float), sigma=6)
    feather = np.clip(feather / max(feather.max(), 1e-9), 0, 1)
    arrays['char_noise_mask'] = (feather * 255).astype(np.uint8)
    path = OUT / 'inputs' / CASE
    path.mkdir(parents=True, exist_ok=True)
    for name, array in arrays.items():
        Image.fromarray(array).save(path / (name + '.png'))
    for name, value in (('scene', scene), ('camera-extension', extension), ('projection', info),
                        ('contacts', {'edges': contact_edges, 'head': world['head'], 'world_id': 'DC-RUN2'})):
        (path / (name + '.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    files = {f.name: {'path': f'inputs/{CASE}/{f.name}',
                      'sha256': hashlib.sha256(f.read_bytes()).hexdigest()}
             for f in sorted(path.iterdir()) if f.is_file()}
    index = {'schema': 'anima-contact-camera-extension.v1/run2', 'case': CASE, 'world_id': 'DC-RUN2',
             'world': world, 'files': files, 'projection': info,
             'contacts': contact_edges,
             'boxes': {k: G.box_from_mask(arrays[k], 1024, 768) for k in ('owner_a', 'owner_b')},
             'camera_config': CAMERA, 'body_yaw_deg': BODY_YAW, 'head_turn_total_deg': HEAD_TOTAL}
    (OUT / 'conditions-run2.json').write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
    (OUT / 'checks').mkdir(exist_ok=True)
    (OUT / 'checks/run2-authoring.json').write_text(json.dumps(
        {'lead_offset': world['lead_offset'], 'face_toward_camera_dot': world['head']['face_toward_camera_dot'],
         'yaw_sign': world['head']['yaw_sign'], 'clasp_distance_h': world['contacts'][0]['distance_h'],
         'projection': info, 'char_mask': {'nonzero_fraction': float(union.mean()),
                                           'grown_fraction': float(grown.mean())}}, indent=2), encoding='utf-8')
    print(json.dumps({'case': CASE, 'status': 'run2_reference_conditions_ready',
                      'files': len(files), 'lead_offset': round(world['lead_offset'], 4),
                      'face_dot': [round(x, 3) for x in world['head']['face_toward_camera_dot']],
                      'clasp_distance_h': round(world['contacts'][0]['distance_h'], 5)}))


if __name__ == '__main__':
    main()
