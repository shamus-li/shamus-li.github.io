#!/usr/bin/env python3
"""Generate the portrait light atlas with FLUX.1 Kontext.

Run with:
  uv run --python 3.11 \
    --with torch --with diffusers --with transformers --with accelerate \
    --with huggingface-hub --with sentencepiece --with protobuf --with pillow --with numpy \
    python tools/generate_flux_kontext_atlas.py
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import numpy as np  # ty: ignore[unresolved-import]
import torch  # ty: ignore[unresolved-import]
from diffusers import FluxKontextPipeline  # ty: ignore[unresolved-import]
from PIL import Image, ImageFilter  # ty: ignore[unresolved-import]

FLUX_KONTEXT_MODEL = "fuliucansheng/FLUX.1-Kontext-dev-diffusers"
LIGHT_CELLS = [
    {"name": "top-left", "col": 0, "row": 0, "x": -1.0, "y": 1.0, "text": "from the upper left"},
    {"name": "top", "col": 1, "row": 0, "x": 0.0, "y": 1.0, "text": "from directly above"},
    {"name": "top-right", "col": 2, "row": 0, "x": 1.0, "y": 1.0, "text": "from the upper right"},
    {"name": "left", "col": 0, "row": 1, "x": -1.0, "y": 0.0, "text": "from the left side"},
    {"name": "center", "col": 1, "row": 1, "x": 0.0, "y": 0.0, "text": "from the front"},
    {"name": "right", "col": 2, "row": 1, "x": 1.0, "y": 0.0, "text": "from the right side"},
    {"name": "bottom-left", "col": 0, "row": 2, "x": -1.0, "y": -1.0, "text": "from the lower left"},
    {"name": "bottom", "col": 1, "row": 2, "x": 0.0, "y": -1.0, "text": "from below"},
    {"name": "bottom-right", "col": 2, "row": 2, "x": 1.0, "y": -1.0, "text": "from the lower right"},
]


def select_device() -> torch.device:
    if torch.backends.mps.is_available():
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def fit_rgba(image: Image.Image, width: int, height: int) -> Image.Image:
    fitted = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    scale = min(width / image.width, height / image.height)
    size = (round(image.width * scale), round(image.height * scale))
    resized = image.resize(size, Image.Resampling.LANCZOS)
    fitted.alpha_composite(resized, ((width - size[0]) // 2, (height - size[1]) // 2))
    return fitted


def composite_for_editing(rgba: Image.Image) -> Image.Image:
    background = Image.new("RGB", rgba.size, (12, 13, 23))
    background.paste(rgba.convert("RGB"), mask=rgba.getchannel("A"))
    return background


def alpha_mask(rgba: Image.Image) -> Image.Image:
    return rgba.getchannel("A").filter(ImageFilter.GaussianBlur(radius=0.35))


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722


def blur_array(array: np.ndarray, radius: float) -> np.ndarray:
    if array.ndim == 2:
        scale = max(float(np.max(array)), 1.0)
        data = np.uint8(np.clip(array / scale, 0.0, 1.0) * 255.0)
        image = Image.fromarray(data, mode="L").filter(ImageFilter.GaussianBlur(radius=radius))
        return np.asarray(image, dtype=np.float32) * (scale / 255.0)
    channels = [blur_array(array[:, :, i], radius) for i in range(array.shape[2])]
    return np.stack(channels, axis=2)


def transfer_lighting(source: Image.Image, generated: Image.Image, mask: Image.Image, strength: float) -> Image.Image:
    source_arr = np.asarray(source.convert("RGBA"), dtype=np.float32)
    source_rgb = source_arr[:, :, :3] / 255.0
    generated_rgb = np.asarray(generated.resize(source.size, Image.Resampling.LANCZOS).convert("RGB"), dtype=np.float32) / 255.0
    alpha = np.asarray(mask, dtype=np.float32)[:, :, None] / 255.0

    source_luma = blur_array(luminance(source_rgb), radius=12.0)
    generated_luma = blur_array(luminance(generated_rgb), radius=22.0)
    ratio = np.clip(generated_luma / np.maximum(source_luma, 0.08), 0.38, 2.05)
    ratio = blur_array(ratio, radius=8.5)[:, :, None]
    ratio = 1.0 + (ratio - 1.0) * strength

    source_color = blur_array(source_rgb, radius=18.0)
    generated_color = blur_array(generated_rgb, radius=26.0)
    tint = np.clip(generated_color / np.maximum(source_color, 0.08), 0.68, 1.32)
    tint = 1.0 + (tint - 1.0) * (strength * 0.16)

    relit = np.clip(source_rgb * ratio * tint, 0.0, 1.0)
    face_blend = np.clip(alpha * 0.98, 0.0, 0.98)
    rgb = source_rgb * (1.0 - face_blend) + relit * face_blend
    return Image.fromarray(np.uint8(np.dstack([rgb, source_arr[:, :, 3:4] / 255.0]) * 255.0), mode="RGBA")


class FluxKontextAtlasGenerator:
    def __init__(self, model: str) -> None:
        self.device = select_device()
        self.dtype = torch.bfloat16 if self.device.type in {"cuda", "mps"} else torch.float32
        self.pipe = FluxKontextPipeline.from_pretrained(model, torch_dtype=self.dtype)
        self.pipe.to(self.device)
        self.pipe.set_progress_bar_config(disable=False)

    @torch.inference_mode()
    def relight(
        self,
        image: Image.Image,
        prompt: str,
        seed: int,
        width: int,
        height: int,
        steps: int,
        guidance: float,
        true_cfg: float,
    ) -> Image.Image:
        generator = torch.Generator(device=self.device).manual_seed(seed)
        result = self.pipe(
            image=image,
            prompt=prompt,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=guidance,
            true_cfg_scale=true_cfg,
            generator=generator,
            max_area=width * height,
        ).images[0]
        if self.device.type == "mps":
            torch.mps.empty_cache()
        return result


def cell_prompt(base_prompt: str, cell: dict[str, Any]) -> str:
    return (
        f"{base_prompt}. Relight the portrait with realistic studio light {cell['text']}. "
        "Keep the same person, same pose, same expression, same glasses, same shirt, same framing. "
        "Only change illumination and shadows."
    )


def build_atlas(args: argparse.Namespace) -> None:
    width = args.width - (args.width % 16)
    height = args.height - (args.height % 16)
    output_width = args.output_width or Image.open(args.source).width
    output_height = args.output_height or Image.open(args.source).height
    output_source = fit_rgba(Image.open(args.source).convert("RGBA"), output_width, output_height)
    edit_source = fit_rgba(Image.open(args.source).convert("RGBA"), width, height)
    edit_image = composite_for_editing(edit_source)
    output_mask = alpha_mask(output_source)
    generator = FluxKontextAtlasGenerator(args.model)
    atlas = Image.new("RGBA", (output_width * 3, output_height * 3), (0, 0, 0, 0))
    preview_dir = args.atlas_dir / "flux-previews"
    if args.keep_previews:
        preview_dir.mkdir(parents=True, exist_ok=True)

    for index, cell in enumerate(LIGHT_CELLS):
        if cell["name"] == "center" and args.original_center:
            relit = output_source
        else:
            generated = generator.relight(
                image=edit_image,
                prompt=cell_prompt(args.prompt, cell),
                seed=args.seed + index,
                width=width,
                height=height,
                steps=args.steps,
                guidance=args.guidance,
                true_cfg=args.true_cfg,
            )
            if args.keep_previews:
                generated.save(preview_dir / f"{index:02d}-{cell['name']}-flux.png")
            relit = transfer_lighting(output_source, generated, output_mask, strength=args.transfer_strength)
        atlas.paste(relit, (int(cell["col"]) * output_width, int(cell["row"]) * output_height))

    args.atlas_dir.mkdir(parents=True, exist_ok=True)
    atlas_path = args.atlas_dir / "shamus-light-atlas.png"
    atlas.save(atlas_path, optimize=True)
    metadata = {
        "source": str(args.source),
        "atlas": atlas_path.name,
        "cellWidth": output_width,
        "cellHeight": output_height,
        "grid": [3, 3],
        "initialLight": {"x": 0.0, "y": 0.0},
        "runtime": "single-texture-webgl2-bilinear-flux-kontext-atlas",
        "generator": {
            "model": args.model,
            "prompt": args.prompt,
            "steps": args.steps,
            "workingWidth": width,
            "workingHeight": height,
            "guidance": args.guidance,
            "trueCfg": args.true_cfg,
            "transferStrength": args.transfer_strength,
            "seed": args.seed,
        },
        "cells": LIGHT_CELLS,
    }
    (args.atlas_dir / "shamus-light-atlas.json").write_text(json.dumps(metadata, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("static/resources/shamus-picture.png"))
    parser.add_argument("--atlas-dir", type=Path, default=Path("static/resources/relight-atlas"))
    parser.add_argument("--model", default=FLUX_KONTEXT_MODEL)
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--output-width", type=int)
    parser.add_argument("--output-height", type=int)
    parser.add_argument("--steps", type=int, default=18)
    parser.add_argument("--guidance", type=float, default=2.5)
    parser.add_argument("--true-cfg", type=float, default=1.0)
    parser.add_argument("--transfer-strength", type=float, default=0.86)
    parser.add_argument("--seed", type=int, default=4660)
    parser.add_argument("--keep-previews", action="store_true")
    parser.add_argument("--original-center", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument(
        "--prompt",
        default="A realistic portrait photograph of the same man against a dark studio background",
    )
    build_atlas(parser.parse_args())


if __name__ == "__main__":
    main()
