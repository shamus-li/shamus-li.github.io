#!/usr/bin/env python3
"""Convert a generative relight atlas into a stable low-frequency lighting atlas."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np  # ty: ignore[unresolved-import]
from PIL import Image, ImageFilter  # ty: ignore[unresolved-import]


def fit_rgba(image: Image.Image, width: int, height: int) -> Image.Image:
    fitted = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    scale = min(width / image.width, height / image.height)
    size = (round(image.width * scale), round(image.height * scale))
    resized = image.resize(size, Image.Resampling.LANCZOS)
    fitted.alpha_composite(resized, ((width - size[0]) // 2, (height - size[1]) // 2))
    return fitted


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722


def blur_gray(array: np.ndarray, radius: float) -> np.ndarray:
    scale = max(float(np.max(array)), 1.0)
    image = Image.fromarray(np.uint8(np.clip(array / scale, 0.0, 1.0) * 255.0), mode="L")
    blurred = image.filter(ImageFilter.GaussianBlur(radius=radius))
    return np.asarray(blurred, dtype=np.float32) * (scale / 255.0)


def lighting_cell(source: Image.Image, relit: Image.Image, strength: float, blur_radius: float) -> Image.Image:
    source_arr = np.asarray(source.convert("RGBA"), dtype=np.float32)
    source_rgb = source_arr[:, :, :3] / 255.0
    source_alpha = source_arr[:, :, 3:4] / 255.0
    relit_rgb = np.asarray(relit.convert("RGB"), dtype=np.float32) / 255.0

    source_luma = blur_gray(luminance(source_rgb), radius=blur_radius * 0.55)
    relit_luma = blur_gray(luminance(relit_rgb), radius=blur_radius)
    ratio = relit_luma / np.maximum(source_luma, 0.08)
    ratio = blur_gray(np.clip(ratio, 0.68, 1.36), radius=blur_radius * 0.7)
    ratio = 1.0 + (ratio - 1.0) * strength
    ratio = np.clip(ratio, 0.82, 1.18)[:, :, None]

    rgb = np.clip(source_rgb * ratio, 0.0, 1.0)
    rgba = np.dstack([rgb, source_alpha])
    return Image.fromarray(np.uint8(np.round(rgba * 255.0)), mode="RGBA")


def postprocess_atlas(args: argparse.Namespace) -> None:
    metadata: dict[str, Any] = json.loads(args.metadata.read_text())
    cell_width = int(metadata["cellWidth"])
    cell_height = int(metadata["cellHeight"])
    grid_cols, grid_rows = metadata["grid"]
    source = fit_rgba(Image.open(args.source).convert("RGBA"), cell_width, cell_height)
    atlas = Image.open(args.atlas).convert("RGBA")
    atlas.load()
    output = Image.new("RGBA", atlas.size, (0, 0, 0, 0))

    for cell in metadata["cells"]:
        col = int(cell["col"])
        row = int(cell["row"])
        box = (
            col * cell_width,
            row * cell_height,
            (col + 1) * cell_width,
            (row + 1) * cell_height,
        )
        relit = atlas.crop(box)
        if col == grid_cols // 2 and row == grid_rows // 2:
            stable = source
        else:
            stable = lighting_cell(source, relit, strength=args.strength, blur_radius=args.blur)
        output.paste(stable, box)

    output.save(args.output_atlas, optimize=True)
    metadata["runtime"] = "single-texture-webgl2-bilinear-smoothed-light-field"
    metadata["postprocess"] = {
        "inputAtlas": args.atlas.name,
        "inPlace": args.atlas.resolve() == args.output_atlas.resolve(),
        "method": "low-frequency-grayscale-lighting-ratio",
        "strength": args.strength,
        "blur": args.blur,
        "ratioClamp": [0.82, 1.18],
    }
    args.output_metadata.write_text(json.dumps(metadata, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("static/resources/shamus-picture.png"))
    parser.add_argument("--atlas", type=Path, default=Path("static/resources/relight-atlas/shamus-light-atlas.png"))
    parser.add_argument("--metadata", type=Path, default=Path("static/resources/relight-atlas/shamus-light-atlas.json"))
    parser.add_argument("--output-atlas", type=Path, default=Path("static/resources/relight-atlas/shamus-light-atlas.png"))
    parser.add_argument("--output-metadata", type=Path, default=Path("static/resources/relight-atlas/shamus-light-atlas.json"))
    parser.add_argument("--strength", type=float, default=0.42)
    parser.add_argument("--blur", type=float, default=48.0)
    postprocess_atlas(parser.parse_args())


if __name__ == "__main__":
    main()
