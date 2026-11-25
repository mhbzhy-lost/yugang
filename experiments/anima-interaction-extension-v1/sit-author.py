# SPDX-License-Identifier: GPL-3.0-only
"""sit-author.py —— DC-SIT1：乡下草垛并坐牵手续件（CPU 授权，0 GPU）。
产出 task-sit.json 供 wf-dispatch.py 消费。画布 1280x720。
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import contacts  # noqa: E402
import geometry  # noqa: E402

import os  # noqa: E402
STRUCTURE = Path(os.environ.get('YUGANG_STRUCTURE_DIR', str(Path.home() / 'yugang-anima-interaction-run-20261111-e970eb55/anima-interaction-v1/stages/contact-camera-extension-20261112/sources/old-structure')))
OUT = HERE
os.environ['YUGANG_RS_SRC'] = str(STRUCTURE.parent / 'rs')
os.environ['YUGANG_RS_STAGE'] = str(OUT / 'sources' / 'rs-stage')
sys.path.insert(0, str(STRUCTURE))

import geometry_core as G  # noqa: E402
import frozen_poses as FP  # noqa: E402

W, H = 1280, 720
SEAT = 0.56
CAMERA = {'center': [.5, .55], 'height_h': 1.0, 'pitch': 0, 'roll': 0}

FLOOR_POS = 'masterpiece, best quality, absurdres, score_7, score_8, score_9, '
FLOOR_NEG = ('low quality, worst quality, score_1, score_2, score_3, early, old, '
             'monochrome, lips, shiny skin')
PUBLIC = (FLOOR_POS + 'countryside village, rustic wooden barn, old stone well, haystack, '
          'sunny day, outdoors, sitting on a haystack, wide angle, medium shot, '
          '2girls, adult women, original outfits')
SLOT_A = ('aigirls, aigirls（deepseek）, 1girl, solo, blue hair, gradient hair, very long hair, wavy hair, '
          'ahoge, blue eyes, fins, cetacean tail, maid headdress, blue ribbon, sitting on a haystack, '
          'legs dangling, holding hands with the other girl, head turned toward her, laughing, facing viewer')
SLOT_B = ('claude_girl, 1girl, solo, orange hair, very long hair, wavy hair, bangs, orange eyes, hair flower, '
          'hair bow, black bow, sitting beside her on the haystack, legs dangling, holding hands, '
          'head turned toward the other girl, laughing')


def seed(stage):
    return int.from_bytes(hashlib.sha256(f'DC|DC-SIT1|20261112|{stage}'.encode()).digest()[:4], 'big')


def make_world(yaw_sign):
    people = [G.mkperson(1, [-.30, 0, 0], [0, 0, 0], {}),
              G.mkperson(2, [.30, 0, 0], [0, 0, 0], {})]
    residuals = {}
    for i, p in enumerate(people):
        pp = G.control_points(p)
        pelvis = pp['pelvis']
        for side in ('left', 'right'):
            sx = .13 if side == 'left' else -.13
            knee = pelvis + [sx, -.03, .33]
            targets = {side + '_knee': knee,
                       side + '_ankle': knee + [0, -.42, .05]}
            residuals[f'{i}.{side}.sit'] = contacts.solve_chain(p, [side + '_hip', side + '_knee'], targets, G)
    chests = [G.control_points(p)['chest'] for p in people]
    clasp = np.array([(chests[0][0] + chests[1][0]) / 2, min(chests[0][1], chests[1][1]) + .02, .18])
    people[0]['joints'].update(FP.hand_interlock_joints('A', 'left'))
    residuals['0.clasp'] = contacts.solve_chain(people[0], ['left_shoulder', 'left_elbow'],
                                                {'left_wrist': clasp + [0, 0, .005]}, G)
    people[1]['joints'].update(FP.hand_interlock_joints('B', 'right'))
    residuals['1.clasp'] = contacts.solve_chain(people[1], ['right_shoulder', 'right_elbow'],
                                                {'right_wrist': clasp - [0, 0, .005]}, G)
    pelv = [G.control_points(p)['pelvis'] for p in people]
    residuals['0.lap'] = contacts.solve_chain(people[0], ['right_shoulder', 'right_elbow'],
                                              {'right_wrist': pelv[0] + [.18, .05, .30]}, G)
    residuals['1.lap'] = contacts.solve_chain(people[1], ['left_shoulder', 'left_elbow'],
                                              {'left_wrist': pelv[1] + [-.18, .05, .30]}, G)
    for p, s in ((people[0], yaw_sign), (people[1], -yaw_sign)):  # heads toward each other
        for bone in ('neck', 'head'):
            p['joints'].setdefault(bone, [0., 0., 0.])[0] += s * 22
    pa, pb = [G.control_points(p) for p in people]
    edges = [{'kind': 'interlaced_hands', 'owners': ['A', 'B'], 'parts': ['left_wrist', 'right_wrist'],
              'world': [pa['left_wrist'].tolist(), pb['right_wrist'].tolist()], 'limit_h': .04}]
    for e in edges:
        e['distance'] = float(np.linalg.norm(np.array(e['world'][0]) - np.array(e['world'][1])))
        e['distance_h'] = e['distance'] / 1.6
        if e['distance_h'] > e['limit_h']:
            raise ValueError(f'clasp unresolved: residual={residuals} edge={e}')
    faces = []
    for p in people:
        _, fwd = contacts.head_lip(p, G)
        faces.append(fwd.tolist())
    fa, fb = faces
    if not (fa[0] > .1 and fb[0] < -.1 and min(fa[2], fb[2]) >= .2):
        raise ValueError(f'head orientation failed: {faces}')
    return {'kind': 'SIT1', 'people': people, 'contacts': edges, 'head': {'forward': faces},
            'authoring_residuals': residuals, 'yaw_sign': yaw_sign}


def main():
    rs = G._rs()
    world = None
    for sign in (1, -1):
        try:
            world = make_world(sign)
            break
        except ValueError as e:
            print(json.dumps({'attempt': sign, 'rejected': str(e)[:160]}))
    if world is None:
        raise SystemExit('SIT1 authoring failed both signs')
    tail = FP.TAIL_DEEPSEEK
    base = G.build_scene(world['people'], {'position': [0, 1, 5], 'target': [0, 1, 0], 'fov': 38})
    base['width'], base['height'] = W, H
    camera, extension = geometry.fit_camera(base, CAMERA, rs['pose3d'], rs['mhr'], tail)
    scene = G.build_scene(world['people'], camera)
    scene['width'], scene['height'] = W, H
    arrays, info = geometry.project_scene(scene, extension, rs['pose3d'], rs['mhr'])
    boxes = {k: G.box_from_mask(arrays[k], W, H) for k in ('owner_a', 'owner_b')}
    (OUT / 'inputs-sit').mkdir(exist_ok=True)
    for name in ('pose_image', 'owner_a', 'owner_b'):
        Image.fromarray(arrays[name]).save(OUT / 'inputs-sit' / f'{name}.png')
    scene_2x = json.loads(json.dumps(scene))
    scene_2x['width'], scene_2x['height'] = W * 2, H * 2
    task = {
        'scene_json': json.dumps(scene, ensure_ascii=False, indent=2),
        'scene_json_2x': json.dumps(scene_2x, ensure_ascii=False, indent=2),
        'camera_extension': json.dumps(extension, ensure_ascii=False),
        'slot_a': SLOT_A, 'slot_b': SLOT_B, 'public': PUBLIC, 'negative': FLOOR_NEG,
        'lora_a': 'aigrilsV1.0.safetensors', 'lora_b': 'claude_girl_anima_lora_clean.safetensors',
        'box_a': boxes['owner_a'], 'box_b': boxes['owner_b'],
        'w': W, 'h': H, 'seed_initial': seed('initial'), 'seed_pass': seed('pass'),
        'prefix': 'pipeline-sit1', 'label': 'DC-SIT1 village haystack',
    }
    (OUT / 'task-sit.json').write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'sit_task_ready', 'boxes': boxes,
                      'projection': {'point_error_px': info['point_reprojection_error_px'],
                                     'height_fraction': round(extension['height_fraction'], 4)},
                      'faces': world['head']['forward'], 'seed_initial': task['seed_initial']}))


if __name__ == '__main__':
    main()
