#!/usr/bin/env python3
"""Generate the portrait light atlas with the hosted FLUX.1 Kontext Space.

This sends the input portrait to Hugging Face's hosted Space API.

Run with:
  uv run --python 3.11 --with gradio-client --with pillow --with numpy \
    python tools/generate_hf_space_kontext_atlas.py
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np  # ty: ignore[unresolved-import]
from gradio_client import Client, handle_file  # ty: ignore[unresolved-import]
from PIL import Image, ImageFilter  # ty: ignore[unresolved-import]

SPACE_ID = "black-forest-labs/FLUX.1-Kontext-Dev"
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
    return np.stack([blur_array(array[:, :, i], radius) for i in range(array.shape[2])], axis=2)


def transfer_lighting(source: Image.Image, generated: Image.Image, mask: Image.Image, strength: float) -> Image.Image:
    source_arr = np.asarray(source.convert("RGBA"), dtype=np.float32)
    source_rgb = source_arr[:, :, :3] / 255.0
    generated_rgb = np.asarray(generated.resize(source.size, Image.Resampling.LANCZOS).convert("RGB"), dtype=np.float32) / 255.0
    alpha = np.asarray(mask, dtype=np.float32)[:, :, None] / 255.0

    source_luma = blur_array(luminance(source_rgb), radius=12.0)
    generated_luma = blur_array(luminance(generated_rgb), radius=22.0)
    ratio = np.clip(generated_luma / np.maximum(source_luma, 0.08), 0.36, 2.18)
    ratio = blur_array(ratio, radius=8.5)[:, :, None]
    ratio = 1.0 + (ratio - 1.0) * strength

    source_color = blur_array(source_rgb, radius=18.0)
    generated_color = blur_array(generated_rgb, radius=26.0)
    tint = np.clip(generated_color / np.maximum(source_color, 0.08), 0.65, 1.36)
    tint = 1.0 + (tint - 1.0) * (strength * 0.18)

    relit = np.clip(source_rgb * ratio * tint, 0.0, 1.0)
    face_blend = np.clip(alpha * 0.985, 0.0, 0.985)
    rgb = source_rgb * (1.0 - face_blend) + relit * face_blend
    return Image.fromarray(np.uint8(np.dstack([rgb, source_arr[:, :, 3:4] / 255.0]) * 255.0), mode="RGBA")


def cell_prompt(base_prompt: str, cell: dict[str, Any]) -> str:
    return (
        f"{base_prompt}. Relight the portrait with realistic studio light {cell['text']}. "
        "Keep the same person, same pose, same expression, same glasses, same shirt, and same framing. "
        "Only change illumination, shadows, and highlights. Natural skin texture."
    )


def generated_path(result: Any) -> str:
    if isinstance(result, tuple):
        result = result[0]
    if isinstance(result, dict) and result.get("path"):
        return str(result["path"])
    if isinstance(result, str):
        return result
    raise TypeError(f"Unsupported Space result: {result!r}")


def build_atlas(args: argparse.Namespace) -> None:
    source = Image.open(args.source).convert("RGBA")
    output_source = fit_rgba(source, source.width, source.height)
    edit_source = fit_rgba(source, args.width, args.height)
    mask = alpha_mask(output_source)
    atlas = Image.new("RGBA", (source.width * 3, source.height * 3), (0, 0, 0, 0))
    args.atlas_dir.mkdir(parents=True, exist_ok=True)
    preview_dir = args.atlas_dir / "kontext-previews"
    if args.keep_previews:
        preview_dir.mkdir(parents=True, exist_ok=True)

    client = Client(args.space)
    with tempfile.TemporaryDirectory(prefix="shamus-kontext-space-") as tmp:
        input_path = Path(tmp) / "input.png"
        composite_for_editing(edit_source).save(input_path)
        for index, cell in enumerate(LIGHT_CELLS):
            preview_path = preview_dir / f"{index:02d}-{cell['name']}-kontext.png"
            if cell["name"] == "center" and args.original_center:
                relit = output_source
            else:
                if preview_path.exists() and args.resume:
                    print(f"Reusing {index + 1}/9 {cell['name']}", flush=True)
                    generated = Image.open(preview_path).convert("RGB")
                else:
                    print(f"Generating {index + 1}/9 {cell['name']}", flush=True)
                    last_error = None
                    for attempt in range(args.retries + 1):
                        try:
                            result = client.predict(
                                handle_file(str(input_path)),
                                cell_prompt(args.prompt, cell),
                                args.seed + index,
                                False,
                                args.guidance,
                                args.steps,
                                api_name="/infer",
                            )
                            generated = Image.open(generated_path(result)).convert("RGB")
                            break
                        except Exception as error:
                            last_error = error
                            if attempt >= args.retries:
                                raise
                            wait = args.retry_wait * (attempt + 1)
                            print(f"Retrying {cell['name']} after {type(error).__name__}: {error}. Waiting {wait}s.", flush=True)
                            time.sleep(wait)
                    else:
                        raise RuntimeError(f"Failed to generate {cell['name']}: {last_error}")
                    if args.keep_previews or args.resume:
                        preview_path.parent.mkdir(parents=True, exist_ok=True)
                        generated.save(preview_path)
                relit = transfer_lighting(output_source, generated, mask, strength=args.transfer_strength)
            atlas.paste(relit, (int(cell["col"]) * source.width, int(cell["row"]) * source.height))

    atlas_path = args.atlas_dir / "shamus-light-atlas.png"
    atlas.save(atlas_path, optimize=True)
    metadata = {
        "source": str(args.source),
        "atlas": atlas_path.name,
        "cellWidth": source.width,
        "cellHeight": source.height,
        "grid": [3, 3],
        "initialLight": {"x": 0.0, "y": 0.0},
        "runtime": "single-texture-webgl2-bilinear-hosted-flux-kontext-atlas",
        "generator": {
            "space": args.space,
            "prompt": args.prompt,
            "steps": args.steps,
            "workingWidth": args.width,
            "workingHeight": args.height,
            "guidance": args.guidance,
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
    parser.add_argument("--space", default=SPACE_ID)
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--steps", type=int, default=28)
    parser.add_argument("--guidance", type=float, default=2.5)
    parser.add_argument("--transfer-strength", type=float, default=0.92)
    parser.add_argument("--seed", type=int, default=4660)
    parser.add_argument("--keep-previews", action="store_true")
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument("--retry-wait", type=float, default=45.0)
    parser.add_argument("--original-center", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument(
        "--prompt",
        default="A realistic portrait photograph of the same man against a dark studio background",
    )
    build_atlas(parser.parse_args())


if __name__ == "__main__":
    main()
