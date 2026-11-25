# SPDX-License-Identifier: GPL-3.0-only
"""One CPU projection implementation, shared verbatim by authoring and ComfyUI.

Only reference conditions are rendered/warped here. Generated images are never
inputs. The underlying RS rasterizer and MHR rig remain frozen and unmodified.
"""
from __future__ import annotations

import hashlib
import json
import math

import numpy as np
from PIL import Image, ImageDraw


def digest(array):
    a = np.ascontiguousarray(array)
    return hashlib.sha256(a.tobytes()).hexdigest()


def camera_basis(camera):
    pos = np.asarray(camera['position'], dtype=float)
    forward = np.asarray(camera['target'], dtype=float) - pos
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0., 1., 0.])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return np.asarray([right, up, forward]), pos


def intrinsic(camera, width, height):
    f = height / (2 * math.tan(math.radians(camera['fov']) / 2))
    return np.array([[f, 0, width / 2], [0, -f, height / 2], [0, 0, 1.]])


def transform_points(points, matrix):
    points = np.asarray(points, dtype=float)
    homogeneous = np.column_stack([points[:, :2], np.ones(len(points))]) @ np.asarray(matrix).T
    return homogeneous[:, :2] / homogeneous[:, 2:3]


def roll_matrix(degrees, width, height, translation=(0., 0.)):
    t = math.radians(degrees)
    c, s = math.cos(t), math.sin(t)
    # Image y points down: positive rotation slopes the horizon down to the right.
    r = np.array([[c, -s, 0.], [s, c, 0.], [0., 0., 1.]])
    before = np.array([[1., 0., -width / 2], [0., 1., -height / 2], [0., 0., 1.]])
    after = np.array([[1., 0., width / 2 + translation[0]],
                      [0., 1., height / 2 + translation[1]], [0., 0., 1.]])
    return after @ r @ before


def horizon(camera, matrix, width, height):
    basis, _ = camera_basis(camera)
    # n.camera dot ray.camera = 0 is the ground-plane vanishing line.
    normal = basis @ np.array([0., 1., 0.])
    line = np.linalg.inv(np.asarray(matrix) @ intrinsic(camera, width, height)).T @ normal
    line /= np.linalg.norm(line[:2])
    yy, xx = np.mgrid[:height, :width]
    value = line[0] * (xx + .5) + line[1] * (yy + .5) + line[2]
    # Positive image y is below the horizon, including negative roll cases.
    ground = value * (1. if line[1] > 0 else -1.) >= 0
    ends = []
    if abs(line[1]) > 1e-10:
        for x in (0., float(width - 1)):
            y = -(line[0] * x + line[2]) / line[1]
            if 0 <= y < height:
                ends.append([x, float(y)])
    if abs(line[0]) > 1e-10:
        for y in (0., float(height - 1)):
            x = -(line[1] * y + line[2]) / line[0]
            if 0 <= x < width:
                ends.append([float(x), y])
    angle = math.degrees(math.atan2(-line[0], line[1]))
    angle = (angle + 90) % 180 - 90
    return ground, {'line': line.tolist(), 'endpoints': ends[:2], 'angle_degrees': angle}


def world_tail(people, tail, mhr, pose3d):
    if not tail:
        return []
    _, _, controls = mhr.mannequin(people[0])
    body = people[0]
    rotation = pose3d.rotation(body['rotation'])
    size = body['scale'] * np.array([body['bulk'], 1., body['bulk']])
    return [(controls['pelvis'] + np.array(s['off']) * size @ rotation.T,
             float(s['r']) * body['scale'] * body['bulk'])
            for s in tail['segments'] + tail['fluke']]


def fit_camera(scene, config, pose3d, mhr, tail=None):
    """Fit distance only; height/pitch never re-aim at the subject centroid."""
    w, h = scene['width'], scene['height']
    vertices = np.concatenate([mhr.mannequin(p)[0] for p in scene['people']])
    H = float(vertices[:, 1].max() - vertices[:, 1].min())
    tail_points = world_tail(scene['people'], tail, mhr, pose3d)
    extra = []
    for p, r in tail_points:
        extra.extend([p + [dx * r, dy * r, 0] for dx in (-1, 1) for dy in (-1, 1)])
    points = np.concatenate([vertices, np.asarray(extra)]) if extra else vertices
    pitch = math.radians(config['pitch'])
    rotation = roll_matrix(config['roll'], w, h)

    def evaluate(distance):
        pos = np.array([0., config['height_h'] * H, distance])
        forward = np.array([0., math.sin(pitch), -math.cos(pitch)])
        camera = {'position': pos.tolist(), 'target': (pos + forward).tolist(), 'fov': 38.}
        projected = pose3d.project(points, camera, w, h)
        if (projected[:, 2] <= .05).any():
            return float('inf'), None, camera
        rolled = transform_points(projected, rotation)
        box = np.array([rolled.min(axis=0), rolled.max(axis=0)])
        return float((box[1, 1] - box[0, 1]) / h), box, camera

    lo, hi = 1., 30.
    for _ in range(45):
        mid = (lo + hi) / 2
        if evaluate(mid)[0] > .4:
            lo = mid
        else:
            hi = mid
    height, box, camera = evaluate((lo + hi) / 2)
    if box is None:
        raise ValueError('Cannot place both people in front of the camera')
    center = (box[0] + box[1]) / 2
    target = np.array(config['center']) * [w, h]
    matrix = roll_matrix(config['roll'], w, h, target - center)
    moved = box + target - center
    margin = np.minimum(moved[0] / [w, h], 1 - moved[1] / [w, h])
    width = float((moved[1, 0] - moved[0, 0]) / w)
    if width > .4 + 1e-6 or margin.min() < .03 - 1e-6:
        raise ValueError(f'Physical framing cannot meet width/margin: width={width}, margin={margin}')
    return camera, {'matrix': matrix.tolist(), 'roll': config['roll'], 'center': config['center'],
                    'world_height': H, 'camera_height_h': config['height_h'], 'pitch': config['pitch'],
                    'reference_box': moved.tolist(), 'height_fraction': height, 'width_fraction': width,
                    'margin': margin.tolist(), 'tail': tail}


def warp(array, matrix, binary=False):
    inv = np.linalg.inv(matrix)
    h, w = array.shape[:2]
    image = Image.fromarray(np.asarray(array, dtype=np.uint8))
    out = image.transform((w, h), Image.Transform.AFFINE, tuple(inv[:2].reshape(-1)),
                          resample=Image.Resampling.NEAREST if binary else Image.Resampling.BILINEAR,
                          fillcolor=0)
    return np.asarray(out)


def reprojection_error(scene, matrix, pose3d, mhr):
    points = np.concatenate([mhr.mannequin(p)[0][::128] for p in scene['people']])
    basis, pos = camera_basis(scene['camera'])
    view = (points - pos) @ basis.T
    direct = view @ (np.asarray(matrix) @ intrinsic(scene['camera'], scene['width'], scene['height'])).T
    direct = direct[:, :2] / direct[:, 2:3]
    via_rs = transform_points(pose3d.project(points, scene['camera'], scene['width'], scene['height']), matrix)
    return float(np.linalg.norm(direct - via_rs, axis=1).max())


def boundary_error(raw, warped, matrix):
    mask = raw.astype(bool)
    interior = mask.copy()
    interior[1:-1, 1:-1] &= mask[:-2, 1:-1] & mask[2:, 1:-1] & mask[1:-1, :-2] & mask[1:-1, 2:]
    yy, xx = np.nonzero(mask & ~interior)
    if len(xx) == 0:
        raise ValueError('No owner boundary to verify')
    take = np.linspace(0, len(xx) - 1, min(256, len(xx)), dtype=int)
    xy = transform_points(np.column_stack([xx[take] + .5, yy[take] + .5]), matrix)
    height, width = mask.shape
    errors = []
    for x, y in xy:
        if not (2 <= x < width - 2 and 2 <= y < height - 2):
            continue  # Explicitly outside the retained reference window.
        candidates = [(math.hypot(ix + .5 - x, iy + .5 - y))
                      for iy in range(int(y) - 1, int(y) + 2) for ix in range(int(x) - 1, int(x) + 2)
                      if warped[iy, ix] > 0]
        errors.append(min(candidates, default=float('inf')))
    if not errors:
        raise ValueError('No retained owner boundary samples')
    return {'sample_count': len(errors), 'maximum_error_px': max(errors)}


def project_scene(scene, extension, pose3d, mhr):
    """Render the *reference* scene, then apply one shared optical transform."""
    w, h = int(scene['width']), int(scene['height'])
    if (w, h) not in ((1024, 768), (2048, 1536), (1280, 720), (2560, 1440), (3840, 2160)) or not 1 <= len(scene['people']) <= 2:
        raise ValueError('Study camera canvas not in allowlist or people count not in 1..2')
    matrix = np.asarray(extension['matrix'], dtype=float)
    if matrix.shape != (3, 3) or not np.isfinite(matrix).all() or not np.allclose(matrix[2], [0, 0, 1]):
        raise ValueError('Invalid camera optical transform')
    if not np.allclose(matrix[:2, :2].T @ matrix[:2, :2], np.eye(2), atol=1e-8):
        raise ValueError('Optical transform may rotate/translate, not distort perspective')
    clean = pose3d.read_scene(json.dumps(scene))
    full, visible, rgb = pose3d._rasterize(clean, shaded=True)
    tail = Image.new('L', (w, h), 0)
    painter = ImageDraw.Draw(tail)
    f = intrinsic(clean['camera'], w, h)[0, 0]
    for point, radius in world_tail(clean['people'], extension.get('tail'), mhr, pose3d):
        x, y, z = pose3d.project(np.array([point]), clean['camera'], w, h)[0]
        if z > .05:
            r = max(1., radius * f / z)
            painter.ellipse((x - r, y - r, x + r, y + r), fill=255)
    tail = np.asarray(tail) > 0
    full[0] |= tail
    visible[0] |= tail & ~visible[1] if len(visible) > 1 else tail
    arrays = {'pose_image': warp(rgb, matrix)}
    for i, name in enumerate(('owner_a', 'owner_b')[:len(visible)]):
        arrays[name] = warp(visible[i].astype(np.uint8) * 255, matrix, True)
        arrays[name + '_full'] = warp(full[i].astype(np.uint8) * 255, matrix, True)
        if not arrays[name].any():
            raise ValueError(f'Projected {name} is empty')
    ground, line = horizon(clean['camera'], matrix, w, h)
    arrays['ground'] = ground.astype(np.uint8) * 255
    arrays['sky'] = (~ground).astype(np.uint8) * 255
    yy, xx = np.mgrid[:h, :w]
    # Continuous night-sky / meadow tones, no text, person reference or ground
    # line is ever injected into the LLLite body condition.
    t = yy / (h - 1)
    sky = np.stack([9 + 16 * t, 13 + 20 * t, 37 + 33 * t], axis=-1)
    earth = np.stack([15 + 8 * t, 29 + 13 * t, 22 + 7 * t], axis=-1)
    arrays['layout_plate'] = np.where(ground[..., None], earth, sky).astype(np.uint8)
    union = np.zeros((h, w), dtype=bool)
    for key in ('owner_a', 'owner_b'):
        if key in arrays:
            union |= arrays[key] > 0
    ys, xs = np.nonzero(union)
    box = [[int(xs.min()), int(ys.min())], [int(xs.max()) + 1, int(ys.max()) + 1]]
    basis, pos = camera_basis(clean['camera'])
    info = {'matrix': matrix.tolist(), 'K': intrinsic(clean['camera'], w, h).tolist(),
            'R': basis.tolist(), 't': (-basis @ pos).tolist(), 'horizon': line,
            'union_box': box, 'array_sha256': {k: digest(v) for k, v in arrays.items()},
            'condition_only': True, 'visual_acceptance': 'user_only'}
    expected = float(extension.get('roll', 0))
    info['horizon_angle_error'] = abs((line['angle_degrees'] - expected + 90) % 180 - 90)
    info['point_reprojection_error_px'] = reprojection_error(clean, matrix, pose3d, mhr)
    info['owner_boundary'] = [boundary_error(visible[i], arrays[name], matrix)
                              for i, name in enumerate(('owner_a', 'owner_b')[:len(visible)])]
    if info['point_reprojection_error_px'] > 1.5 or max(v['maximum_error_px'] for v in info['owner_boundary']) > 1.5:
        raise ValueError('Reference point / owner boundary exceeds projection tolerance')
    if info['horizon_angle_error'] > .5:
        raise ValueError('Ground horizon does not follow the optical camera roll')
    if extension.get('center') is not None:
        center = (np.array(box[0]) + box[1]) / 2 / [w, h]
        info['center_error'] = abs(center - extension['center']).tolist()
        if max(info['center_error']) > .025:
            raise ValueError(f'Rendered owner center mismatch: {info["center_error"]}')
    return arrays, info
