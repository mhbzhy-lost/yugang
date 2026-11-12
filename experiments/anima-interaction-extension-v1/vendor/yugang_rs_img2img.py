# SPDX-License-Identifier: GPL-3.0-only
"""Yugang experiment: masked img2img entry on the frozen RS sampler.

Repair-stage node for the anima-interaction-v1 study (R3). It reuses
``RSMultiCharacterSampler`` unchanged for character prompts, owner masks,
precision regional-LoRA routing, metadata and generation_info, and adds only
the missing local-repair inputs:

* an encoded ``LATENT`` start (or original crop ``IMAGE`` + ``VAE``) instead
  of the zero-latent txt2img branch;
* an independent gray ``noise_mask`` (pixel space) and a real ``denoise``
  value; both are passed through ``comfy.sample.sample``.

Hard failures keep the frozen study contract:

* pose is OFF at the repair stage. A fresh MODEL without Anima LLLite
  patches is required, and a pipe still carrying an active 3D pose scene is
  refused, so the old panoramic scene can never be re-rendered onto the
  crop canvas (``ALLOW_PIPE_POSE = False`` also disables the pipe path).
* a gray (non-binary) ``noise_mask`` requires the core DifferentialDiffusion
  ``denoise_mask_function`` hook on the MODEL. Without it this node refuses
  to run instead of silently falling back to hard-mask blending.

Owner attribution masks (binary, from the character pipe regions) and the
gray repaint-strength map stay strictly separated: the former keep flowing
through ``character_masks`` / ``RegionalLoras`` exactly as in the parent
sampler (RS ``prepare_mask`` binarizing attribution masks is intended), the
latter only ever reaches the sampler as the latent ``noise_mask``.
"""
import json

import torch

from .characters import CharacterPipe, PIPE_TYPE
from .nodes import RSMultiCharacterSampler


def _validate_denoise(denoise):
    if isinstance(denoise, bool) or not isinstance(denoise, (int, float)):
        raise ValueError("denoise must be a finite number from 0.01 to 1.")
    denoise = float(denoise)
    if not (denoise == denoise) or not 0.01 <= denoise <= 1.:
        raise ValueError("denoise must be a finite number from 0.01 to 1.")
    return denoise


def _latent_spatial(samples):
    """Return (h, w) of a single-frame Anima/SD latent, 4D or 5D."""
    if samples.ndim == 5:
        if samples.shape[0] != 1 or samples.shape[2] != 1:
            raise ValueError("Only batch-1 single-frame latents are supported at the repair stage.")
        return int(samples.shape[3]), int(samples.shape[4])
    if samples.ndim == 4:
        if samples.shape[0] != 1:
            raise ValueError("Only batch-1 latents are supported at the repair stage.")
        return int(samples.shape[2]), int(samples.shape[3])
    raise ValueError("Latent must be a 4D or 5D tensor.")


class YugangRSMaskedImg2Img(RSMultiCharacterSampler):
    """Joint two-character masked img2img inside one crop canvas.

    Both characters are solved in the same crop by the ordinary RS regional
    routing; this is not a per-character detailer loop and not a global-LoRA
    shortcut. The crop-space character pipe (boxes/region masks normalized to
    the crop canvas) is built by the runner; ``YugangMaskCropTransform``
    supplies the matching owner/gray masks in crop coordinates.
    """

    # Never render a stored 3D pose scene inside the repair crop.
    ALLOW_PIPE_POSE = False

    @classmethod
    def INPUT_TYPES(cls):
        from comfy.samplers import KSampler
        return {"required": {
            "model": ("MODEL",), "clip": ("CLIP",), "vae": ("VAE",),
            "character_pipe": ("RS_MC_CHARACTER_PIPE,NAI_CONTEXT",),
            "prompt": ("STRING", {"default": "masterpiece, best quality, 2girls", "multiline": True}),
            "negative_prompt": ("STRING", {"default": "low quality, bad anatomy, text, watermark", "multiline": True}),
            "width": ("INT", {"default": 768, "min": 64, "max": 4096, "step": 16,
                "tooltip": "Crop canvas width; must equal the input latent/image width (x8 for latents). No silent resize."}),
            "height": ("INT", {"default": 768, "min": 64, "max": 4096, "step": 16}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
            "steps": ("INT", {"default": 30, "min": 2, "max": 100}),
            "cfg": ("FLOAT", {"default": 4., "min": 1., "max": 20., "step": .1}),
            "sampler_name": (list(KSampler.SAMPLERS), {"default": "euler_ancestral"}),
            "scheduler": (list(KSampler.SCHEDULERS), {"default": "sgm_uniform"}),
            "denoise": ("FLOAT", {"default": .45, "min": .01, "max": 1., "step": .01,
                "tooltip": "Real img2img denoise for the whole crop; the gray noise_mask shapes where inside the canvas it applies."}),
        }, "optional": {
            "image": ("IMAGE",),
            "latent": ("LATENT",),
            "noise_mask": ("MASK",),
            "prompt_syntax": (["ComfyUI", "NovelAI"], {"default": "ComfyUI"}),
            "region_feather": ("FLOAT", {"default": .04, "min": 0., "max": .25, "step": .01}),
            "initial_common_prior": ("FLOAT", {"default": .05, "min": 0., "max": 1., "step": .01}),
            "common_after_step3_boost": ("FLOAT", {"default": .1, "min": 0., "max": 1., "step": .05}),
            "initial_character_gain": ("FLOAT", {"default": 1.7, "min": 1., "max": 3., "step": .1}),
            "initial_spatial_separation": ("FLOAT", {"default": .9, "min": 0., "max": .99, "step": .05}),
            "boundary_hold_steps": ("INT", {"default": 3, "min": 1, "max": 30}),
            "boundary_decrement": ("FLOAT", {"default": .2, "min": .01, "max": 1., "step": .01}),
            "layout_method": (["regional", "auto"], {"default": "regional",
                "tooltip": "Repair stage is frozen to regional routing; MOSS native layout is not part of this experiment."}),
        }, "hidden": {"workflow_prompt": "PROMPT", "unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ("IMAGE", "LATENT", PIPE_TYPE, "STRING")
    RETURN_NAMES = ("image", "latent", "character_pipe", "generation_info")
    FUNCTION = "generate"
    CATEGORY = "RS MultiCharacter"
    OUTPUT_NODE = False
    DESCRIPTION = "Experiment (anima-interaction-v1 R3): joint two-character masked img2img in one crop, reusing RS regional prompt/owner-mask/precision-LoRA routing. Requires a fresh pose-free MODEL, an explicit denoise and a pixel-space noise_mask; gray masks require core DifferentialDiffusion."

    # ------------------------------------------------------------------ prep

    def _prepare_start(self, model, vae, character_pipe, image, latent,
                       noise_mask, denoise, width, height):
        """Validate repair-stage inputs and build (latent, noise_mask, denoise)."""
        from .anima_pose_control import validate_model_patches

        if image is not None and latent is not None:
            raise ValueError("Connect either image or latent as the repair start, not both.")
        if image is None and latent is None:
            raise ValueError("Connect the crop image or its encoded latent as the repair start.")

        # Pose must be explicitly off: fresh MODEL, no LLLite patches, no
        # pipe scene that could be re-rendered onto the crop canvas.
        if model.model_options.get('rs_3d_pose') is not None:
            raise ValueError("Repair stage requires a MODEL without the RS 3D pose plan. Load the base model again for R1/R2/R3.")
        if validate_model_patches(model, 'Anima'):
            raise ValueError("Repair stage requires a fresh MODEL without Anima LLLite pose patches. Do not reuse the initial-sampling MODEL.")
        if character_pipe.pose3d_json is not None:
            from .pose_pipe import pipe_pose_settings
            plan = pipe_pose_settings(character_pipe.pose3d_json)
            if plan['mode'] == 'auto' and plan['strength'] > 0:
                raise ValueError("The pipe still carries an active 3D pose scene in full-canvas coordinates. Rebuild the crop pipe with pose disabled or masks_only; the old panoramic scene must not be re-rendered onto the crop.")
        if any(c.reference is not None and c.reference.strength > 0 for c in character_pipe.characters):
            raise ValueError("Disconnect character image references for the repair stage.")
        if (model.model_options.get('rs_anima_ref_frame_plan') is not None
                or model.model_options.get('rs_image_reference') is not None):
            raise ValueError("Disconnect reference-frame/image-reference adapters for the repair stage.")

        # Start latent: encoded input or direct LATENT dict.
        start_kind = "latent"
        if latent is not None:
            if not isinstance(latent, dict) or "samples" not in latent:
                raise ValueError("The latent input must be a ComfyUI LATENT dict with 'samples'.")
            samples = latent["samples"]
        else:
            start_kind = "image+vae"
            if image.ndim == 5 and image.shape[1] == 1:
                image = image.flatten(0, 1)
            if image.ndim != 4 or image.shape[0] != 1 or image.shape[3] != 3:
                raise ValueError("The crop image must be one batch-1 RGB IMAGE ([1,H,W,3]).")
            if not torch.isfinite(image).all():
                raise ValueError("The crop image contains nonfinite values.")
            if int(image.shape[2]) != width or int(image.shape[1]) != height:
                raise ValueError(f"Crop image is {int(image.shape[2])}x{int(image.shape[1])} but the node declares {width}x{height}. Refusing to resize silently.")
            samples = vae.encode(image)
            if not torch.isfinite(samples).all():
                raise ValueError("VAE encoding produced nonfinite values; check the VAE.")
        latent_h, latent_w = _latent_spatial(samples)
        # The frozen RS Anima path is x8 spatial (see RSMultiCharacterSampler).
        if latent_w * 8 != width or latent_h * 8 != height:
            raise ValueError(f"Latent spatial size {latent_w}x{latent_h} does not match the declared crop canvas {width}x{height} at x8. Refusing to resize silently.")

        # Gray strength mask: separate channel from the binary owner masks.
        mask_source = None
        if noise_mask is None:
            if latent is not None and latent.get("noise_mask") is not None:
                noise_mask = latent["noise_mask"]
                mask_source = "latent_dict"
        else:
            mask_source = "input"
            if latent is not None and latent.get("noise_mask") is not None:
                mask_source = "input_over_latent_dict"
        if noise_mask is None:
            raise ValueError("The repair stage requires an explicit noise_mask (uniform binary for R1-style, gray support for R2/R3). Full-canvas repaints are not part of the frozen design.")
        if noise_mask.ndim == 4:
            if noise_mask.shape[1] != 1:
                raise ValueError("A 4D noise_mask must have a single channel ([B,1,H,W]).")
            noise_mask = noise_mask[:, 0]
        if noise_mask.ndim != 3 or noise_mask.shape[0] != 1:
            raise ValueError("noise_mask must be a batch-1 pixel-space MASK ([1,H,W]).")
        if int(noise_mask.shape[2]) != width or int(noise_mask.shape[1]) != height:
            raise ValueError(f"noise_mask is {int(noise_mask.shape[2])}x{int(noise_mask.shape[1])} but the crop canvas is {width}x{height}. Refusing to resize silently; use YugangMaskCropTransform with the same crop.")
        if not torch.isfinite(noise_mask).all():
            raise ValueError("noise_mask contains nonfinite values.")
        mask_min, mask_max = float(noise_mask.min()), float(noise_mask.max())
        if mask_min < 0. or mask_max > 1.:
            raise ValueError(f"noise_mask values must stay in [0,1]; got [{mask_min}, {mask_max}].")
        mask_mode = "binary" if bool(((noise_mask == 0.) | (noise_mask == 1.)).all()) else "gray"

        denoise_mask_function = model.model_options.get("denoise_mask_function")
        dd_present = denoise_mask_function is not None
        if mask_mode == "gray" and not dd_present:
            raise ValueError("A gray noise_mask requires core DifferentialDiffusion on the MODEL (set_model_denoise_mask_function). Connect it explicitly; refusing to silently fall back to hard-mask blending.")

        # Match core SetLatentNoiseMask: pixel-space mask as (-1, 1, H, W).
        noise_mask = noise_mask.reshape((-1, 1, noise_mask.shape[-2], noise_mask.shape[-1]))

        info = {
            "node": "YugangRSMaskedImg2Img",
            "stage": "repair",
            "start_kind": start_kind,
            "requested_denoise": float(denoise),
            "input_latent_shape": [int(v) for v in samples.shape],
            "declared_canvas": [int(width), int(height)],
            "noise_mask": {
                "source": mask_source,
                "pixel_shape": [1, int(height), int(width)],
                "mode": mask_mode,
                "min": mask_min,
                "max": mask_max,
            },
            "differential_diffusion_hook": dd_present,
            "pose_disabled": True,
            "pipe_pose3d_present": character_pipe.pose3d_json is not None,
            "lllite_patches_on_model": False,
        }
        return samples, noise_mask, denoise, info

    # --------------------------------------------------------------- run

    def generate(self, model, clip, vae, character_pipe, prompt, negative_prompt,
                 width=768, height=768, seed=0, steps=30, cfg=4.,
                 sampler_name="euler_ancestral", scheduler="sgm_uniform", denoise=.45,
                 image=None, latent=None, noise_mask=None, prompt_syntax="ComfyUI",
                 region_feather=.04, initial_common_prior=.05, common_after_step3_boost=.1,
                 initial_character_gain=1.7, initial_spatial_separation=.9,
                 boundary_hold_steps=3, boundary_decrement=.2, layout_method="regional",
                 workflow_prompt=None, unique_id=None):
        if not isinstance(character_pipe, CharacterPipe):
            raise ValueError("Connect an RS character pipe rebuilt for the crop canvas.")
        if layout_method not in ("regional", "auto"):
            raise ValueError("Repair stage supports regional (or auto→regional on a pose-free MODEL) only.")
        denoise = _validate_denoise(denoise)

        samples, prepared_mask, denoise, info = self._prepare_start(
            model, vae, character_pipe, image, latent, noise_mask, denoise, width, height)
        # Consumed by the overridden _initial_latent during super().generate.
        self._yugang_start = {"latent": samples, "noise_mask": prepared_mask, "denoise": denoise}
        try:
            result = super().generate(
                model, clip, vae, character_pipe, prompt, negative_prompt,
                width=width, height=height, seed=seed, steps=steps, cfg=cfg,
                sampler_name=sampler_name, scheduler=scheduler,
                autosave=False, prompt_syntax=prompt_syntax,
                region_feather=region_feather, initial_common_prior=initial_common_prior,
                common_after_step3_boost=common_after_step3_boost,
                initial_character_gain=initial_character_gain,
                initial_spatial_separation=initial_spatial_separation,
                boundary_hold_steps=boundary_hold_steps,
                boundary_decrement=boundary_decrement,
                layout_method=layout_method,
                workflow_prompt=workflow_prompt, unique_id=unique_id)
        finally:
            self._yugang_start = None

        images, out_latent, enriched, summary_json = result["result"]
        summary = json.loads(summary_json)
        audit = summary.get("routing_audit", {})
        info["effective"] = {
            "width": width, "height": height, "denoise": denoise,
            "layout_method": audit.get("layout_method"),
            "lora_application": audit.get("lora_application"),
        }
        summary["yugang_img2img"] = info
        result["result"] = (images, out_latent, enriched, json.dumps(summary, ensure_ascii=False))
        result["ui"]["text"].append(
            f"Yugang img2img: start {info['start_kind']} · denoise {denoise} · mask {info['noise_mask']['mode']}"
            f" · DD hook {'yes' if info['differential_diffusion_hook'] else 'no'} · pose disabled")
        return result

    def _initial_latent(self, work, vae, family, settings):
        """Replace the zero-latent start with the prepared repair inputs."""
        start = getattr(self, "_yugang_start", None)
        if start is None:
            raise RuntimeError("YugangRSMaskedImg2Img lost its prepared start latent; refusing to fall back to zero-latent txt2img.")
        return start["latent"], start["noise_mask"], start["denoise"]
