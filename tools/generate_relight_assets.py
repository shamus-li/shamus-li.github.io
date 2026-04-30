#!/usr/bin/env python3
"""Generate static portrait relighting assets.

Run with:
  uv run --python 3.11 --with pillow --with numpy --with mediapipe \
    python tools/generate_relight_assets.py
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np  # ty: ignore[unresolved-import]
from PIL import Image, ImageDraw, ImageFilter  # ty: ignore[unresolved-import]

FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
    379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
    234, 127, 162, 21, 54, 103, 67, 109,
]
FACE_LANDMARKER_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
ATLAS_CELLS = [
    {"name": "top-left", "col": 0, "row": 0, "x": -1.0, "y": 1.0},
    {"name": "top", "col": 1, "row": 0, "x": 0.0, "y": 1.0},
    {"name": "top-right", "col": 2, "row": 0, "x": 1.0, "y": 1.0},
    {"name": "left", "col": 0, "row": 1, "x": -1.0, "y": 0.0},
    {"name": "center", "col": 1, "row": 1, "x": 0.0, "y": 0.0},
    {"name": "right", "col": 2, "row": 1, "x": 1.0, "y": 0.0},
    {"name": "bottom-left", "col": 0, "row": 2, "x": -1.0, "y": -1.0},
    {"name": "bottom", "col": 1, "row": 2, "x": 0.0, "y": -1.0},
    {"name": "bottom-right", "col": 2, "row": 2, "x": 1.0, "y": -1.0},
]
SOURCE_LIGHT = {
    "direction": [0.62, 0.32, 0.716],
    "ambient": 0.52,
    "strength": 0.48,
    "source": "manual-portrait-calibration-camera-right-high",
}
ASSET_VERSION = "full-subject-distance-v2"


def load_rgba(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32)


def detect_face(image: np.ndarray) -> dict[str, Any] | None:
    try:
        import mediapipe as mp  # ty: ignore[unresolved-import]
    except Exception:
        return None
    if not hasattr(mp, "solutions"):
        return detect_face_tasks(image, mp)

    rgb = image[:, :, :3].astype(np.uint8)
    h, w = rgb.shape[:2]
    with mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
    ) as face_mesh:
        result = face_mesh.process(rgb)
    if not result.multi_face_landmarks:
        return None

    landmarks = result.multi_face_landmarks[0].landmark
    pts = np.array([(lm.x * w, lm.y * h, lm.z * w) for lm in landmarks], dtype=np.float32)
    oval = pts[FACE_OVAL, :2]
    min_xy = oval.min(axis=0)
    max_xy = oval.max(axis=0)
    eye_mid = (pts[33, :2] + pts[263, :2]) * 0.5
    nose = pts[1, :2]
    chin = pts[152, :2]
    forehead = pts[10, :2]
    return {
        "source": "mediapipe-face-mesh",
        "oval": oval.tolist(),
        "cx": float(nose[0] * 0.62 + eye_mid[0] * 0.38),
        "cy": float(nose[1] * 0.54 + ((forehead[1] + chin[1]) * 0.5) * 0.46),
        "rx": float((max_xy[0] - min_xy[0]) * 0.58),
        "ry": float((max_xy[1] - min_xy[1]) * 0.62),
    }


def detect_face_tasks(image: np.ndarray, mp: Any) -> dict[str, Any] | None:
    try:
        from mediapipe.tasks.python import vision  # ty: ignore[unresolved-import]
    except Exception:
        return None

    model_path = Path.home() / ".cache" / "shamus-li-site" / "face_landmarker.task"
    if not model_path.exists():
        model_path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(FACE_LANDMARKER_URL, model_path)

    rgb = image[:, :, :3].astype(np.uint8)
    h, w = rgb.shape[:2]
    base_options = mp.tasks.BaseOptions(model_asset_path=str(model_path))
    options = vision.FaceLandmarkerOptions(base_options=base_options, num_faces=1)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        result = landmarker.detect(mp_image)
    if not result.face_landmarks:
        return None

    landmarks = result.face_landmarks[0]
    pts = np.array([(lm.x * w, lm.y * h, lm.z * w) for lm in landmarks], dtype=np.float32)
    oval = pts[FACE_OVAL, :2]
    min_xy = oval.min(axis=0)
    max_xy = oval.max(axis=0)
    eye_mid = (pts[33, :2] + pts[263, :2]) * 0.5
    nose = pts[1, :2]
    chin = pts[152, :2]
    forehead = pts[10, :2]
    return {
        "source": "mediapipe-face-landmarker",
        "oval": oval.tolist(),
        "cx": float(nose[0] * 0.62 + eye_mid[0] * 0.38),
        "cy": float(nose[1] * 0.54 + ((forehead[1] + chin[1]) * 0.5) * 0.46),
        "rx": float((max_xy[0] - min_xy[0]) * 0.58),
        "ry": float((max_xy[1] - min_xy[1]) * 0.62),
    }


def fallback_face(image: np.ndarray) -> dict[str, Any]:
    rgb = image[:, :, :3]
    alpha = image[:, :, 3]
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    skin = (
        (alpha > 180)
        & (r > 90)
        & (g > 45)
        & (b > 28)
        & (r > g * 1.05)
        & (r > b * 1.04)
        & ((np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])) > 24)
    )
    skin[int(image.shape[0] * 0.58) :, :] = False
    ys, xs = np.nonzero(skin)
    if len(xs) < 80:
        h, w = alpha.shape
        return {"source": "fallback-centered", "cx": w * 0.5, "cy": h * 0.34, "rx": w * 0.14, "ry": h * 0.22}
    return {
        "source": "fallback-skin",
        "cx": float(xs.mean()),
        "cy": float(ys.mean()),
        "rx": float((xs.max() - xs.min()) * 0.58),
        "ry": float((ys.max() - ys.min()) * 0.62),
    }


def make_face_mask(face: dict[str, Any], size: tuple[int, int], alpha: np.ndarray) -> np.ndarray:
    w, h = size
    mask_img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask_img)
    if "oval" in face:
        draw.polygon([(float(x), float(y)) for x, y in face["oval"]], fill=255)
    else:
        cx, cy, rx, ry = (float(face[k]) for k in ("cx", "cy", "rx", "ry"))
        draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=255)
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(radius=12))
    mask = np.asarray(mask_img, dtype=np.float32) / 255.0
    return np.clip(mask * (alpha / 255.0), 0.0, 1.0)


def make_subject_mask(alpha: np.ndarray) -> np.ndarray:
    alpha_img = Image.fromarray(np.uint8(np.clip(alpha, 0, 255)), mode="L")
    mask_img = alpha_img.filter(ImageFilter.GaussianBlur(radius=5))
    mask = np.asarray(mask_img, dtype=np.float32) / 255.0
    return np.clip((mask - 0.03) / 0.78, 0.0, 1.0)


def alpha_bounds(alpha: np.ndarray) -> tuple[float, float, float, float]:
    ys, xs = np.nonzero(alpha > 24)
    if len(xs) < 80:
        h, w = alpha.shape
        return w * 0.28, h * 0.12, w * 0.72, h * 0.96
    return float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())


def normal_map(
    face: dict[str, Any],
    width: int,
    height: int,
    subject_mask: np.ndarray,
    face_mask: np.ndarray,
    alpha: np.ndarray,
) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width].astype(np.float32)
    x0, y0, x1, y1 = alpha_bounds(alpha)
    body_cx = (x0 + x1) * 0.5
    body_cy = y0 + (y1 - y0) * 0.56
    body_rx = max(1.0, (x1 - x0) * 0.58)
    body_ry = max(1.0, (y1 - y0) * 0.76)
    body_x = np.clip((x - body_cx) / body_rx, -1.2, 1.2)
    body_y = np.clip((y - body_cy) / body_ry, -1.2, 1.2)
    body_z = np.sqrt(np.maximum(0.18, 1.0 - body_x * body_x * 0.36 - body_y * body_y * 0.42))
    body_normals = np.dstack([body_x * 0.44, -body_y * 0.52, body_z])
    body_normals /= np.maximum(np.linalg.norm(body_normals, axis=2, keepdims=True), 1e-6)

    face_cx, face_cy, face_rx, face_ry = (float(face[k]) for k in ("cx", "cy", "rx", "ry"))
    face_x = np.clip((x - face_cx) / max(1.0, face_rx), -1.2, 1.2)
    face_y = np.clip((y - face_cy) / max(1.0, face_ry), -1.2, 1.2)
    face_z = np.sqrt(np.maximum(0.06, 1.0 - face_x * face_x * 0.72 - face_y * face_y * 0.82))
    face_normals = np.dstack([face_x * 0.88, -face_y * 0.96, face_z])
    face_normals /= np.maximum(np.linalg.norm(face_normals, axis=2, keepdims=True), 1e-6)

    normals = body_normals * (1.0 - face_mask[:, :, None]) + face_normals * face_mask[:, :, None]
    normals /= np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-6)
    flat = np.dstack([np.zeros_like(subject_mask), np.zeros_like(subject_mask), np.ones_like(subject_mask)])
    return flat * (1.0 - subject_mask[:, :, None]) + normals * subject_mask[:, :, None]


def neutral_image(image: np.ndarray) -> np.ndarray:
    return image.copy()


def light_vector(x: float, y: float) -> np.ndarray:
    z = np.sqrt(max(0.22, 1.0 - x * x * 0.42 - y * y * 0.42))
    vec = np.array([x * 0.82, y * 0.78, z], dtype=np.float32)
    return vec / np.linalg.norm(vec)


def detail_layer(image: np.ndarray) -> np.ndarray:
    rgb = np.uint8(np.clip(image[:, :, :3], 0, 255))
    blur = np.asarray(Image.fromarray(rgb, mode="RGB").filter(ImageFilter.GaussianBlur(radius=2.4)), dtype=np.float32)
    return np.clip((rgb.astype(np.float32) + 8.0) / (blur + 8.0), 0.72, 1.34)


def render_atlas_cell(
    image: np.ndarray,
    albedo: np.ndarray,
    normals: np.ndarray,
    mask: np.ndarray,
    x: float,
    y: float,
) -> Image.Image:
    original = image[:, :, :3] / 255.0
    base = albedo[:, :, :3] / 255.0
    alpha = image[:, :, 3:4] / 255.0
    direction = light_vector(x, y)
    diffuse = np.maximum(0.0, np.sum(normals * direction[None, None, :], axis=2))
    wrap = np.maximum(0.0, (np.sum(normals * direction[None, None, :], axis=2) + 0.42) / 1.42)
    shade = 0.25 + 0.82 * np.power(diffuse, 0.72) + 0.16 * np.power(wrap, 1.7)

    half_vec = direction + np.array([0.0, 0.0, 1.0], dtype=np.float32)
    half_vec /= np.linalg.norm(half_vec)
    spec = np.power(np.maximum(0.0, np.sum(normals * half_vec[None, None, :], axis=2)), 46.0) * 0.18
    sculpt = np.clip(1.0 + (normals[:, :, 0] * x + normals[:, :, 1] * y) * 0.16, 0.7, 1.28)
    tint = np.array([1.02 + y * 0.02, 0.99 + x * 0.015, 0.96 - y * 0.035], dtype=np.float32)
    relit = base * shade[:, :, None] * sculpt[:, :, None] * tint[None, None, :]
    relit += spec[:, :, None] * np.array([1.0, 0.92, 0.82], dtype=np.float32)
    relit *= np.power(detail_layer(image), 0.42)

    if x == 0.0 and y == 0.0:
        relit = original

    face_blend = np.clip(mask[:, :, None] * 0.94, 0.0, 0.94)
    rgb = original * (1.0 - face_blend) + np.clip(relit, 0.0, 1.0) * face_blend
    return Image.fromarray(np.uint8(np.clip(np.dstack([rgb, alpha]) * 255.0, 0, 255)), mode="RGBA")


def save_relight_maps(
    source: Path,
    atlas_dir: Path,
    image: np.ndarray,
    albedo: np.ndarray,
    normals: np.ndarray,
    mask: np.ndarray,
    light: dict[str, Any],
) -> None:
    h, w = image.shape[:2]
    atlas_dir.mkdir(parents=True, exist_ok=True)

    albedo_img = Image.fromarray(np.uint8(np.clip(albedo, 0, 255)), mode="RGBA")
    albedo_path = atlas_dir / "shamus-neutral.png"
    albedo_img.save(albedo_path, optimize=True)

    normal_rgb = np.clip((normals * 0.5 + 0.5) * 255.0, 0, 255)
    normal_rgba = np.dstack([normal_rgb, np.clip(mask * 255.0, 0, 255)])
    normal_path = atlas_dir / "shamus-normal-mask.png"
    Image.fromarray(np.uint8(normal_rgba), mode="RGBA").save(normal_path, optimize=True)

    detail = detail_layer(image)
    detail_rgba = np.dstack([detail, image[:, :, 3:4] / 255.0])
    detail_path = atlas_dir / "shamus-detail.png"
    Image.fromarray(np.uint8(np.clip(detail_rgba * 255.0, 0, 255)), mode="RGBA").save(detail_path, optimize=True)

    direction = light["direction"]
    metadata = {
        "source": str(source),
        "width": w,
        "height": h,
        "neutral": albedo_path.name,
        "normalMask": normal_path.name,
        "detail": detail_path.name,
        "initialLight": {
            "x": float(np.clip(direction[0], -1.0, 1.0)),
            "y": float(np.clip(direction[1], -1.0, 1.0)),
        },
        "sourceLight": light,
        "version": ASSET_VERSION,
        "runtime": "webgl2-neutral-normal-source-compensated-relight",
        "method": (
            "Use original portrait pixels as the neutral base and a calibrated source-light "
            "direction so WebGL compensation matches the baked camera-right portrait light."
        ),
    }
    (atlas_dir / "shamus-relight-maps.json").write_text(json.dumps(metadata, indent=2) + "\n")


def save_light_atlas(
    source: Path,
    atlas_dir: Path,
    image: np.ndarray,
    albedo: np.ndarray,
    normals: np.ndarray,
    mask: np.ndarray,
    light: dict[str, Any],
) -> None:
    h, w = image.shape[:2]
    atlas_dir.mkdir(parents=True, exist_ok=True)
    atlas = Image.new("RGBA", (w * 3, h * 3), (0, 0, 0, 0))
    for cell in ATLAS_CELLS:
        relit = render_atlas_cell(image, albedo, normals, mask, float(cell["x"]), float(cell["y"]))
        atlas.paste(relit, (int(cell["col"]) * w, int(cell["row"]) * h))

    atlas_path = atlas_dir / "shamus-light-atlas.png"
    atlas.save(atlas_path, optimize=True)
    direction = light["direction"]
    metadata = {
        "source": str(source),
        "atlas": atlas_path.name,
        "cellWidth": w,
        "cellHeight": h,
        "grid": [3, 3],
        "initialLight": {
            "x": float(np.clip(direction[0], -1.0, 1.0)),
            "y": float(np.clip(direction[1], -1.0, 1.0)),
        },
        "runtime": "single-texture-webgl2-bilinear-light-atlas",
        "cells": ATLAS_CELLS,
        "replacementNotes": (
            "For neural relighting, generate these nine cells with a diffusion relighter "
            "such as IC-Light, SynthLight, or Holo-Relighting and repack them into this atlas."
        ),
    }
    (atlas_dir / "shamus-light-atlas.json").write_text(json.dumps(metadata, indent=2) + "\n")


def save_assets(source: Path, atlas_dir: Path, debug_dir: Path | None) -> None:
    image = load_rgba(source)
    h, w = image.shape[:2]
    face = detect_face(image) or fallback_face(image)
    face_mask = make_face_mask(face, (w, h), image[:, :, 3])
    subject_mask = make_subject_mask(image[:, :, 3])
    normals = normal_map(face, w, h, subject_mask, face_mask, image[:, :, 3])
    light = SOURCE_LIGHT.copy()
    mask = subject_mask
    albedo = neutral_image(image)

    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        Image.fromarray(np.uint8(np.clip((normals * 0.5 + 0.5) * 255.0, 0, 255))).save(debug_dir / "shamus-normal.png")
        Image.fromarray(np.uint8(np.clip(mask * 255.0, 0, 255)), mode="L").save(debug_dir / "shamus-mask.png")
        Image.fromarray(np.uint8(np.clip(face_mask * 255.0, 0, 255)), mode="L").save(debug_dir / "shamus-face-mask.png")
        Image.fromarray(np.uint8(np.clip(image[:, :, 3], 0, 255)), mode="L").save(debug_dir / "shamus-alpha.png")
        Image.fromarray(np.uint8(np.clip(albedo, 0, 255)), mode="RGBA").save(debug_dir / "shamus-albedo.webp", quality=92)
        metadata = {
            "source": str(source),
            "width": w,
            "height": h,
            "face": {k: face[k] for k in ("source", "cx", "cy", "rx", "ry") if k in face},
            "originalLight": light,
            "neutral": "original-rgba",
        }
        (debug_dir / "shamus-light.json").write_text(json.dumps(metadata, indent=2) + "\n")
    save_relight_maps(source, atlas_dir, image, albedo, normals, mask, light)
    save_light_atlas(source, atlas_dir, image, albedo, normals, mask, light)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("static/resources/shamus-picture.webp"))
    parser.add_argument("--atlas-dir", type=Path, default=Path("static/resources/relight-atlas"))
    parser.add_argument("--debug-dir", type=Path)
    args = parser.parse_args()
    save_assets(args.source, args.atlas_dir, args.debug_dir)


if __name__ == "__main__":
    main()
