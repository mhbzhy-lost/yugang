"""让 RS Camera 与 V8 LLLite 共用同一个二维构图变换。

安装：将本文件复制到 ComfyUI/custom_nodes/yugang_pose_layout/__init__.py。
只处理固定远景缩放与两人分离；不添加模型 patch，不重复施加姿态。
"""
from dataclasses import replace
import json
import logging
import torch
import torch.nn.functional as F


class YugangPoseLayout:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "character_pipe": ("RS_MC_CHARACTER_PIPE",),
            "pose_image": ("IMAGE",),
            "owner_a": ("MASK",), "owner_b": ("MASK",),
            "base_prompt": ("STRING", {"forceInput": True}),
            "framing": (["normal", "wide"],),
            "spacing": (["together", "apart"],),
            "canvas_aspect": ("FLOAT", {"default": 1.7777778, "min": .1, "max": 10.}),
        }}

    RETURN_TYPES = ("RS_MC_CHARACTER_PIPE", "STRING", "IMAGE", "STRING")
    RETURN_NAMES = ("character_pipe", "prompt", "pose_image", "layout_info")
    FUNCTION = "apply"
    CATEGORY = "Yugang/Draw"

    def apply(self, character_pipe, pose_image, owner_a, owner_b,
              base_prompt, framing, spacing, canvas_aspect):
        if len(character_pipe.characters) != 2 or character_pipe.pose3d_json is not None:
            raise ValueError("Pose layout requires two characters and one external pose patch")
        if framing not in ("normal", "wide") or spacing not in ("together", "apart"):
            raise ValueError("Invalid pose layout mode")
        if pose_image.ndim != 4 or pose_image.shape[0] != 1 or pose_image.shape[-1] != 3:
            raise ValueError("Pose layout requires one RGB pose image")
        if not torch.isfinite(pose_image).all():
            raise ValueError("Pose image contains nonfinite values")
        h, w = pose_image.shape[1:3]
        def warp(image, scale=1., dx=0., dy=0.):
            # 与 Camera 的归一化中心缩放相同；dx/dy 是缩放前平移。
            theta = image.new_tensor([[[1 / scale, 0., -2 * dx], [0., 1 / scale, -2 * dy]]])
            grid = F.affine_grid(theta, image.shape, align_corners=False)
            return F.grid_sample(image, grid, mode="bilinear", padding_mode="zeros", align_corners=False)
        rgb = pose_image.movedim(-1, 1)
        owners = [owner_a, owner_b]
        boxes = [c.bbox for c in character_pipe.characters]
        if any(b is None for b in boxes):
            raise ValueError("Pose layout requires character boxes")
        left, top = min(b[0] for b in boxes), min(b[1] for b in boxes)
        right, bottom = max(b[2] for b in boxes), max(b[3] for b in boxes)
        if right <= left or bottom <= top:
            raise ValueError("Pose layout has an empty character envelope")
        cx, cy = (left + right) / 2, (top + bottom) / 2
        # 恢复普通景别的主体尺度，再由 Camera 统一拉远，保持接触姿态的相对位置。
        fit = min(.62 / (right - left), .85 / (bottom - top))
        rgb = warp(rgb, scale=fit, dx=.5 - cx, dy=.5 - cy)
        owners = [warp(mask.unsqueeze(1).to(rgb), scale=fit, dx=.5 - cx, dy=.5 - cy)[:, 0] for mask in owners]
        def point(x, y):
            return .5 + fit * (x - cx), .5 + fit * (y - cy)
        fitted = []
        for c in character_pipe.characters:
            x, y = point(c.x, c.y)
            x0, y0 = point(c.bbox[0], c.bbox[1])
            x1, y1 = point(c.bbox[2], c.bbox[3])
            fitted.append(replace(c, x=x, y=y, bbox=(x0, y0, x1, y1)))
        character_pipe = replace(character_pipe, characters=tuple(fitted))
        shifts = [0., 0.]
        if spacing == "apart":
            parts, characters = [], []
            for index, (c, mask) in enumerate(zip(character_pipe.characters, owners)):
                if tuple(mask.shape) != (1, h, w) or not torch.isfinite(mask).all():
                    raise ValueError("Owner mask must match the pose canvas")
                if c.region_mask is not None:
                    raise ValueError("Pose layout expects rectangular RS regions")
                dx = (.29 if index == 0 else .71) - c.x
                shifts[index] = dx
                if c.bbox is None:
                    raise ValueError("Pose layout requires character boxes")
                x0, y0, x1, y1 = c.bbox
                characters.append(replace(c, x=c.x + dx, bbox=(x0 + dx, y0, x1 + dx, y1)))
                parts.append(warp(rgb * mask.unsqueeze(1).to(rgb), dx=dx))
            rgb = torch.maximum(parts[0], parts[1])
            character_pipe = replace(character_pipe, characters=tuple(characters))
        scale = 1.
        prompt = base_prompt
        if framing == "wide":
            # 直接调用已安装 RS Camera，保留其真实 caption 与区域变换语义。
            import nodes
            camera = nodes.NODE_CLASS_MAPPINGS["RSCameraControl"]()
            result = camera.apply(azimuth=0., elevation=0., distance=1., roll=0.,
                strength=1.2, weighting="weighted", prompt_syntax="ComfyUI", enabled=True,
                scope="scene_and_characters", building_pipe=character_pipe,
                base_prompt=base_prompt, layout_sync="distance_and_roll", canvas_aspect=canvas_aspect)
            character_pipe, prompt, _ = result["result"]
            scale = .5  # RS framing(distance=1)：2 ** (2 * (.5 - 1))。
            rgb = warp(rgb, scale=scale)
        info = {"framing": framing, "spacing": spacing, "scale": scale,
                "normal_fit_scale": fit, "normal_source_center": [cx, cy],
                "character_dx": shifts, "pose_and_regions_share_transform": True,
                "external_pose_only": True}
        logging.info("Yugang pose layout %s", json.dumps(info))
        return character_pipe, prompt, rgb.movedim(1, -1), json.dumps(info)


NODE_CLASS_MAPPINGS = {"YugangPoseLayout": YugangPoseLayout}
NODE_DISPLAY_NAME_MAPPINGS = {"YugangPoseLayout": "鱼缸姿态与 Camera 同步"}
