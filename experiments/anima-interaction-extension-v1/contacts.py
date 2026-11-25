# SPDX-License-Identifier: GPL-3.0-only
"""CPU-only MHR joint authoring; no diffusion images, scoring or learned solver."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import maximum_filter
from scipy.optimize import least_squares

sys.path.insert(0, str(Path(__file__).resolve().parent))
import geometry


def head_lip(person, G):
    """Head forward is posed-vs-bind rotation, not the direction of the feet."""
    rs = G._rs()
    mhr, pose3d = rs['mhr'], rs['pose3d']
    a = mhr.asset()
    angles = {a['controls'][k]: list(v) for k, v in person['joints'].items()}
    for rule in a['proceduralRotations']:
        angles[a['names'][rule['bone']]] = [sum(angles.get(a['names'][j], [0, 0, 0])[ax] * w
                                                  for j, ax, w in terms) for terms in rule['axes']]
    idx = a['names'].index(a['controls']['head'])
    posed = mhr.global_matrices(angles)[idx, :3, :3]
    bind = mhr.global_matrices({})[idx, :3, :3]
    forward = pose3d.rotation(person['rotation']) @ posed @ np.linalg.inv(bind) @ np.array([0., 0., 1.])
    forward /= np.linalg.norm(forward)
    point = G.control_points(person)['head'] + .10 * forward - np.array([0., .03, 0.])
    return point, forward


def solve_chain(person, controls, targets, G):
    """Bounded numeric FK fit against declared world targets, never model output."""
    dofs = [(c, axis) for c in controls for axis in range(3)]
    start = np.array([person['joints'].get(c, [0, 0, 0])[axis] for c, axis in dofs], float)
    initial = copy.deepcopy(person)
    def apply(x):
        for (c, axis), value in zip(dofs, x):
            person['joints'].setdefault(c, [0., 0., 0.])[axis] = float(value)
    def residual(x):
        apply(x)
        points = G.control_points(person)
        errors = np.concatenate([(points[c] - target) for c, target in targets.items()])
        return np.r_[errors, (x - start) * 1e-6]
    result = least_squares(residual, np.clip(start, -149, 149), bounds=(-150, 150),
                           max_nfev=400, ftol=1e-10, xtol=1e-10, gtol=1e-10)
    apply(result.x)
    points = G.control_points(person)
    return {c: float(np.linalg.norm(points[c] - target)) for c, target in targets.items()}


def make_world(kind, G, FP):
    if kind in ('C1', 'C2'):
        template = FP.ACTION_TEMPLATES['KISS']
        people = [G.mkperson(i + 1, template['body'][slot]['position'], template['body'][slot]['rotation'],
                             template['joints'][slot]) for i, slot in enumerate(('A', 'B'))]
    elif kind == 'C3':
        # The MHR bone-local X axis is yaw here (verified from FK), not Y.
        # Distribute the turn across torso/neck/head rather than twisting one joint.
        people = [G.mkperson(1, [-.12, 0, -.2], [0, 5, 0], {'head': [30, 0, 0]}),
                  G.mkperson(2, [0, 0, 0], [0, 100, 0],
                             {'chest': [35, 0, 0], 'neck': [50, 0, 0], 'head': [35, 0, 0]})]
    elif kind == 'RUN':
        people = [G.mkperson(1, [-.35, 0, 0], [0, 0, 0], {'chest': [5, 0, 0]}),
                  G.mkperson(2, [.35, .03, -.08], [0, 0, 0], {'chest': [7, 0, 0]})]
    else:
        raise ValueError(kind)
    residuals = {}
    if kind.startswith('C'):
        a, b = (head_lip(p, G)[0] for p in people)
        # Root translations close the documented lip proxies without deforming the rig.
        people[0]['position'] = (np.array(people[0]['position']) + (b - a) / 2).tolist()
        people[1]['position'] = (np.array(people[1]['position']) - (b - a) / 2).tolist()
        points = [G.control_points(p) for p in people]
        clasp = (points[0]['chest'] + points[1]['chest']) / 2
        clasp[1] = {'C1': 1.14, 'C2': .99, 'C3': 1.14}[kind]
        clasp[2] = max(points[0]['chest'][2], points[1]['chest'][2]) + (.12 if kind == 'C3' else .19)
        wraps = [points[1]['pelvis'] + [0, .14, -.055], points[0]['pelvis'] + [0, .14, -.055]]
        for i, (slot, clasp_side, wrap_side) in enumerate((('A', 'right', 'left'), ('B', 'left', 'right'))):
            p = people[i]
            p['joints'].update(FP.hand_interlock_joints(slot, clasp_side))
            residuals[f'{slot}.clasp'] = solve_chain(p, [clasp_side + '_shoulder', clasp_side + '_elbow'],
                                                      {clasp_side + '_wrist': clasp + [0, 0, .006 * (2 * i - 1)]}, G)
            target = wraps[i]
            if kind == 'C3' and i == 1:
                pa = G.control_points(people[0])
                target = (pa['left_elbow'] + pa['left_wrist']) / 2
            residuals[f'{slot}.wrap'] = solve_chain(p, [wrap_side + '_shoulder', wrap_side + '_elbow'],
                                                     {wrap_side + '_wrist': target}, G)
        if kind == 'C2':
            r = G._rs()['pose3d'].rotation([0, 20, 0])
            for p in people:
                p['position'] = (np.array(p['position']) @ r.T).tolist()
                p['rotation'][1] += 20
        pa, pb = [G.control_points(p) for p in people]
        la, fa = head_lip(people[0], G)
        lb, fb = head_lip(people[1], G)
        edges = [{'kind': 'lips', 'owners': ['A', 'B'], 'parts': ['head_lip_proxy', 'head_lip_proxy'],
                  'world': [la.tolist(), lb.tolist()], 'limit_h': .025},
                 {'kind': 'interlaced_hands', 'owners': ['A', 'B'], 'parts': ['right_wrist', 'left_wrist'],
                  'world': [pa['right_wrist'].tolist(), pb['left_wrist'].tolist()], 'limit_h': .04}]
        for i, (owner, part, pts, target) in enumerate((('A', 'left_wrist', pa, wraps[0]),
                                                        ('B', 'right_wrist', pb, wraps[1]))):
            if kind == 'C3' and i == 1:
                target = (pa['left_elbow'] + pa['left_wrist']) / 2
            if kind == 'C2':
                target = np.array(target) @ r.T
            edges.append({'kind': 'embrace', 'owners': [owner, 'B' if owner == 'A' else 'A'],
                          'parts': [part, 'waist_or_encircling_forearm'],
                          'world': [pts[part].tolist(), np.asarray(target).tolist()], 'limit_h': .10})
        head_info = {'proxy': 'head + .10 * posed_head_forward - .03 * world_up',
                     'head_forward': [fa.tolist(), fb.tolist()], 'not_precise_lip_geometry': True}
    else:
        for i, p in enumerate(people):
            origin = np.array(p['position'])
            for side, sign in (('left', 1 if i == 0 else -1), ('right', -1 if i == 0 else 1)):
                x = .12 if side == 'left' else -.12
                targets = {side + '_knee': origin + [x, .62, .26 * sign],
                           side + '_ankle': origin + [x, .16 if sign > 0 else .28, .44 * sign]}
                residuals[f'{i}.{side}.stride'] = solve_chain(p, [side + '_hip', side + '_knee'], targets, G)
            clasp_side = 'left' if i == 0 else 'right'
            p['joints'].update(FP.hand_interlock_joints('A' if i == 0 else 'B', clasp_side))
            residuals[f'{i}.clasp'] = solve_chain(p, [clasp_side + '_shoulder', clasp_side + '_elbow'],
                                                   {clasp_side + '_wrist': np.array([0., 1., .19 + i * .012])}, G)
            free_side = 'right' if i == 0 else 'left'
            residuals[f'{i}.swing'] = solve_chain(p, [free_side + '_shoulder', free_side + '_elbow'],
                                                   {free_side + '_wrist': origin + [(-.3 if i == 0 else .3), 1.12, -.15]}, G)
        pa, pb = [G.control_points(p) for p in people]
        edges = [{'kind': 'interlaced_hands', 'owners': ['A', 'B'], 'parts': ['left_wrist', 'right_wrist'],
                  'world': [pa['left_wrist'].tolist(), pb['right_wrist'].tolist()], 'limit_h': .04}]
        head_info = {}
    height = 1.6
    for edge in edges:
        edge['distance'] = float(np.linalg.norm(np.array(edge['world'][0]) - edge['world'][1]))
        edge['distance_h'] = edge['distance'] / height
        if edge['distance_h'] > edge['limit_h']:
            raise ValueError(f'{kind} unresolved reference contact: {edge}')
    if kind == 'C3':
        forward = G._rs()['pose3d'].rotation(people[1]['rotation']) @ np.array([0., 0., 1.])
        rear = float((np.array(people[0]['position']) - people[1]['position']) @ forward)
        if rear >= 0:
            raise ValueError(f'C3 authoring did not place A behind B: signed offset {rear}')
    return {'kind': kind, 'people': people, 'contacts': edges, 'head': head_info,
            'authoring_residuals': residuals, 'finger_interlock_guaranteed': False,
            'authoring_only_no_generated_images': True}


def contact_masks(world, scene, extension, pose3d):
    w, h = scene['width'], scene['height']
    core = Image.new('L', (w, h), 0)
    painter = ImageDraw.Draw(core)
    contacts = copy.deepcopy(world['contacts'])
    for edge in contacts:
        raw = pose3d.project(np.array(edge['world']), scene['camera'], w, h)
        xy = geometry.transform_points(raw, extension['matrix'])
        edge['projected'] = xy.tolist()
        edge['in_frame'] = bool((raw[:, 2] > .05).all() and (xy >= [0, 0]).all() and (xy < [w, h]).all())
        if not edge['in_frame']:
            raise ValueError(f'Required contact outside frame: {world["kind"]} {edge["kind"]}')
        radius = {'lips': 20, 'interlaced_hands': 30, 'embrace': 24}[edge['kind']]
        painter.line([tuple(x) for x in xy], fill=255, width=radius * 2)
        for x, y in xy:
            painter.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
    support = maximum_filter(np.array(core), size=97, mode='constant')
    context = maximum_filter(support, size=193, mode='constant')
    return {'repair_core': np.array(core), 'support': support, 'context': context,
            'gray': np.array(core)}, contacts


def prepare(structure_root, out, spec_path):
    os.environ['YUGANG_RS_SRC'] = str(structure_root.parent / 'rs')
    os.environ['YUGANG_RS_STAGE'] = str(Path(out) / 'sources' / 'rs-stage')
    sys.path.insert(0, str(structure_root))
    import geometry_core as G
    import frozen_poses as FP
    rs = G._rs()
    spec = json.loads(Path(spec_path).read_text(encoding='utf-8'))
    out = Path(out)
    (out / 'inputs').mkdir(parents=True, exist_ok=True)
    worlds = {kind: make_world(kind, G, FP) for kind in ('C1', 'C2', 'C3', 'RUN')}
    index = {'schema': spec['schema'], 'cases': {}, 'worlds': {}}
    for pair in spec['pairs']:
        tail = FP.TAIL_DEEPSEEK if pair == 'DC' else None
        for kind, world in worlds.items():
            world_id = pair + '-' + kind
            index['worlds'][world_id] = world
            cases = {kind: None} if kind.startswith('C') else spec['camera_cases']
            for case, config in cases.items():
                case_id = pair + '-' + case
                path = out / 'inputs' / case_id
                path.mkdir()
                if config is None:
                    subset = G.framed_subset('C')
                    points = [v for p in world['people'] for k, v in G.control_points(p).items() if k in subset]
                    cam = G.fit_camera(points, 'C')['camera']
                    extension = {'matrix': np.eye(3).tolist(), 'roll': 0, 'center': None, 'tail': tail}
                else:
                    base = G.build_scene(world['people'], {'position': [0, 1, 5], 'target': [0, 1, 0], 'fov': 38})
                    cam, extension = geometry.fit_camera(base, config, rs['pose3d'], rs['mhr'], tail)
                scene = G.build_scene(world['people'], cam)
                arrays, info = geometry.project_scene(scene, extension, rs['pose3d'], rs['mhr'])
                masks, contacts = contact_masks(world, scene, extension, rs['pose3d'])
                arrays.update(masks)
                for name, array in arrays.items():
                    Image.fromarray(array).save(path / (name + '.png'))
                for name, value in (('scene', scene), ('camera-extension', extension), ('projection', info),
                                    ('contacts', {'edges': contacts, 'head': world['head'], 'world_id': world_id})):
                    (path / (name + '.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
                files = {f.name: {'path': 'inputs/' + case_id + '/' + f.name,
                                 'sha256': __import__('hashlib').sha256(f.read_bytes()).hexdigest()}
                         for f in path.iterdir() if f.is_file()}
                index['cases'][case_id] = {'world_id': world_id, 'files': files, 'projection': info,
                                          'contacts': contacts, 'boxes': {k: G.box_from_mask(arrays[k], 1024, 768)
                                                                          for k in ('owner_a', 'owner_b')}}
                print(json.dumps({'case': case_id, 'status': 'reference_conditions_ready'}, ensure_ascii=False), flush=True)
    (out / 'conditions.json').write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
    (out / 'checks').mkdir(exist_ok=True)
    (out / 'checks/projection.json').write_text(json.dumps({
        'cases': {k: v['projection'] for k, v in index['cases'].items()},
        'source_sha256': __import__('hashlib').sha256(Path(geometry.__file__).read_bytes()).hexdigest(),
    }, indent=2), encoding='utf-8')
    (out / 'checks/contacts.json').write_text(json.dumps({
        'worlds': index['worlds'], 'cases': {k: v['contacts'] for k, v in index['cases'].items()},
    }, indent=2), encoding='utf-8')
    return index


def audit(structure_root, out):
    os.environ['YUGANG_RS_SRC'] = str(structure_root.parent / 'rs')
    os.environ['YUGANG_RS_STAGE'] = str(Path(out) / 'sources' / 'rs-stage')
    sys.path.insert(0, str(structure_root))
    import geometry_core as G
    rs = G._rs()
    out = Path(out)
    index = json.loads((out / 'conditions.json').read_text(encoding='utf-8'))
    projection = {'cases': {}, 'source_sha256': __import__('hashlib').sha256(Path(geometry.__file__).read_bytes()).hexdigest()}
    for case_id, entry in index['cases'].items():
        path = out / 'inputs' / case_id
        scene = json.loads((path / 'scene.json').read_text(encoding='utf-8'))
        extension = json.loads((path / 'camera-extension.json').read_text(encoding='utf-8'))
        arrays, info = geometry.project_scene(scene, extension, rs['pose3d'], rs['mhr'])
        if info['array_sha256'] != entry['projection']['array_sha256']:
            raise ValueError(f'Reference arrays changed during independent projection audit: {case_id}')
        for name, array in arrays.items():
            if geometry.digest(np.array(Image.open(path / (name + '.png')))) != geometry.digest(array):
                raise ValueError(f'Saved condition differs from recomputed array: {case_id}/{name}')
        projection['cases'][case_id] = info
        print(json.dumps({'case': case_id, 'point_error_px': info['point_reprojection_error_px'],
                          'boundary_max_px': max(x['maximum_error_px'] for x in info['owner_boundary'])}), flush=True)
    (out / 'checks').mkdir(exist_ok=True)
    (out / 'checks/projection.json').write_text(json.dumps(projection, indent=2), encoding='utf-8')
    contact_audit = {'worlds': {}, 'cases': {k: v['contacts'] for k, v in index['cases'].items()}}
    for world_id, world in index['worlds'].items():
        item = {'authoring_residuals': world['authoring_residuals'], 'contacts': world['contacts']}
        if world['kind'] == 'C3':
            a, b = world['people']
            forward = rs['pose3d'].rotation(b['rotation']) @ np.array([0., 0., 1.])
            item['A_relative_to_B_body_forward'] = float((np.array(a['position']) - b['position']) @ forward)
            item['rear_body_layout'] = item['A_relative_to_B_body_forward'] < 0
        contact_audit['worlds'][world_id] = item
    (out / 'checks/contacts.json').write_text(json.dumps(contact_audit, indent=2), encoding='utf-8')
    return projection


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--structure-root', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--spec')
    parser.add_argument('--audit-only', action='store_true')
    args = parser.parse_args()
    if args.audit_only:
        audit(Path(args.structure_root), Path(args.out))
    else:
        if not args.spec:
            parser.error('--spec is required to prepare reference conditions')
        prepare(Path(args.structure_root), Path(args.out), args.spec)
