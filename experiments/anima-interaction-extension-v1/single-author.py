# SPDX-License-Identifier: GPL-3.0-only
"""single-author.py —— S1：deepseek 单人草垛侧坐（CPU 授权，0 GPU）。画布 1280x720。
产 task-single.json 供单人轻形态（KSampler+链式 LoRA，无 RS）。
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
CAMERA = {'center': [.5, .55], 'height_h': 1.0, 'pitch': 0, 'roll': 0}


def seed(stage):
    return int.from_bytes(hashlib.sha256(f'DC|S1|20261112|{stage}'.encode()).digest()[:4], 'big')


def main():
    rs = G._rs()
    person = G.mkperson(1, [0, 0, 0], [0, 0, 0], {})
    residuals = {}
    pp = G.control_points(person)
    pelvis = pp['pelvis']
    for side in ('left', 'right'):
        sx = .13 if side == 'left' else -.13
        knee = pelvis + [sx, -.03, .33]
        targets = {side + '_knee': knee, side + '_ankle': knee + [0, -.42, .05]}
        residuals[f'{side}.sit'] = contacts.solve_chain(person, [side + '_hip', side + '_knee'], targets, G)
    residuals['lap_l'] = contacts.solve_chain(person, ['left_shoulder', 'left_elbow'],
                                              {'left_wrist': pelvis + [.14, .06, .28]}, G)
    residuals['lap_r'] = contacts.solve_chain(person, ['right_shoulder', 'right_elbow'],
                                              {'right_wrist': pelvis + [-.14, .06, .28]}, G)
    person['joints'].setdefault('neck', [0., 0., 0.])[0] += 10
    person['joints'].setdefault('head', [0., 0., 0.])[0] += 12
    _, fwd = contacts.head_lip(person, G)
    if fwd[2] < .3:
        raise SystemExit(f'head not facing camera enough: {fwd.tolist()}')
    tail = FP.TAIL_DEEPSEEK
    base = G.build_scene([person], {'position': [0, 1, 5], 'target': [0, 1, 0], 'fov': 38})
    base['width'], base['height'] = W, H
    camera, extension = geometry.fit_camera(base, CAMERA, rs['pose3d'], rs['mhr'], tail)
    scene = G.build_scene([person], camera)
    scene['width'], scene['height'] = W, H
    arrays, info = geometry.project_scene(scene, extension, rs['pose3d'], rs['mhr'])
    box = G.box_from_mask(arrays['owner_a'], W, H)
    (OUT / 'inputs-single').mkdir(exist_ok=True)
    for name in ('pose_image', 'owner_a'):
        Image.fromarray(arrays[name]).save(OUT / 'inputs-single' / f'{name}.png')
    task = {
        'scene_json': json.dumps(scene, ensure_ascii=False, indent=2),
        'camera_extension': json.dumps(extension, ensure_ascii=False),
        'box': box,
        'w': W, 'h': H, 'seed_initial': seed('initial'), 'seed_pass': seed('pass'),
        'face_forward': fwd.tolist(), 'sit_residuals': residuals,
    }
    (OUT / 'task-single.json').write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'single_task_ready', 'box': box,
                      'point_error_px': info['point_reprojection_error_px'],
                      'face_forward_z': round(fwd[2], 3), 'seed_initial': task['seed_initial']}))


if __name__ == '__main__':
    main()
