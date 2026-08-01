#!/usr/bin/env python3
"""Generate a browser-ready portrait light field with NVIDIA UniRelight."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

MODEL_SIZE = (848, 480)
LOADER_SIZE = (864, 486)
INFERENCE_FRAMES = 57
AZIMUTH_SLOTS = 28
INFERENCE_STEPS = 35
ELEVATIONS_DEG = (-15.0, 5.0, 25.0, 45.0)
FRONT_ARC_STEPS = 7
DEFAULT_LIGHT = (-0.32525, 0.0738)
AZIMUTH_RESPONSE = 2.4
ELEVATION_RESPONSE = 5.0
OUTPUT_WIDTHS = {"standard": 720, "high": 1440}
FRONT_ARC_AZIMUTH_INDICES = (
    *range(FRONT_ARC_STEPS + 1),
    *range(AZIMUTH_SLOTS - FRONT_ARC_STEPS, AZIMUTH_SLOTS),
)
FRAME_STEP = (INFERENCE_FRAMES - 1) // AZIMUTH_SLOTS
INFERENCE_FINGERPRINT_FILE = "inference-fingerprint.sha256"
LUMA_WEIGHTS = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
COOL_DAYLIGHT_RGB = np.array([0.975, 1.0, 1.04], dtype=np.float32)
COOL_DAYLIGHT_RGB /= COOL_DAYLIGHT_RGB @ LUMA_WEIGHTS
SOURCE_CHROMA_RETENTION = 0.50


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inference-id", required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--neutral-guide", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--checkpoints", type=Path, required=True)
    parser.add_argument("--workdir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-inference", action="store_true")
    return parser.parse_args()


def inference_fingerprint(
    inference_id: str,
    script_path: Path,
    source_path: Path,
    neutral_guide_path: Path,
) -> str:
    digest = hashlib.sha256()
    for component in (
        inference_id.encode("utf-8"),
        script_path.read_bytes(),
        source_path.read_bytes(),
        neutral_guide_path.read_bytes(),
    ):
        digest.update(len(component).to_bytes(8, "big"))
        digest.update(component)
    return digest.hexdigest()


def make_hdr(path: Path, elevation_deg: float) -> None:
    height, width = 256, 512
    theta = (np.arange(height, dtype=np.float32) + 0.5) / height * np.pi
    phi = (np.arange(width, dtype=np.float32) + 0.5) / width * (2 * np.pi) - np.pi
    theta_grid, phi_grid = np.meshgrid(theta, phi, indexing="ij")
    target_theta = np.pi / 2 - np.deg2rad(elevation_deg)
    cos_angle = np.sin(theta_grid) * np.sin(target_theta) * np.cos(phi_grid) + np.cos(
        theta_grid
    ) * np.cos(target_theta)
    angle = np.arccos(np.clip(cos_angle, -1.0, 1.0))
    key = np.exp(-0.5 * (angle / np.deg2rad(9.0)) ** 2)
    overhead = np.clip(np.cos(theta_grid), 0.0, 1.0) ** 3
    radiance = 0.035 + 14.0 * key + 0.08 * overhead
    rgb = (radiance[..., None] * COOL_DAYLIGHT_RGB).astype(np.float32)
    if not cv2.imwrite(str(path), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)):
        raise RuntimeError(f"Could not write HDR environment map: {path}")


def prepare_input(
    source: Image.Image,
    path: Path,
    model_x: int,
    content_width: int,
) -> None:
    loader_x = model_x + (LOADER_SIZE[0] - MODEL_SIZE[0]) // 2
    loader_y = (LOADER_SIZE[1] - MODEL_SIZE[1]) // 2

    resized = source.resize((content_width, MODEL_SIZE[1]), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", LOADER_SIZE, (242, 242, 242))
    canvas.paste(resized.convert("RGB"), (loader_x, loader_y), resized.getchannel("A"))
    canvas.save(path)


def run_inference(
    args: argparse.Namespace, input_root: Path, env_dir: Path, raw_dir: Path
) -> None:
    command = [
        sys.executable,
        "-m",
        "cosmos_predict1.diffusion.inference.single_gpu_relight",
        "--config_file",
        "cosmos_predict1/diffusion/training/config/config_relight.py",
        "--config",
        "unirelight_cosmos_f57_480p",
        "--ckpt_path",
        str(args.checkpoints / "UniRelight" / "model.pt"),
        "--dataset_name",
        str(input_root),
        "--output_path",
        str(raw_dir),
        "--sample_n_frames",
        str(INFERENCE_FRAMES),
        "--env_light_path",
        str(env_dir),
        "--rotate_light",
        "true",
        "--use_fixed_frame_ind",
        "true",
        "--save_images",
        "true",
        "--save_condition",
        "false",
        "--num_steps",
        str(INFERENCE_STEPS),
    ]
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            path for path in (str(args.repo), os.environ.get("PYTHONPATH", "")) if path
        ),
        "CUDA_HOME": os.environ.get("CUDA_HOME", "/usr/local/cuda"),
    }
    subprocess.run(command, cwd=args.repo, env=env, check=True)


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    normalized = rgb.astype(np.float32) / 255.0
    return np.where(
        normalized <= 0.04045,
        normalized / 12.92,
        ((normalized + 0.055) / 1.055) ** 2.4,
    )


def linear_to_srgb(rgb: np.ndarray) -> np.ndarray:
    encoded = np.where(
        rgb <= 0.0031308,
        rgb * 12.92,
        1.055 * np.maximum(rgb, 0.0) ** (1.0 / 2.4) - 0.055,
    )
    return np.round(np.clip(encoded, 0.0, 1.0) * 255.0).astype(np.uint8)


def masked_gaussian(values: np.ndarray, alpha: np.ndarray, sigma: float) -> np.ndarray:
    weight = cv2.GaussianBlur(alpha, (0, 0), sigma)
    if values.ndim == 2:
        weighted = cv2.GaussianBlur(values * alpha, (0, 0), sigma)
        return weighted / np.maximum(weight, 1e-4)
    weight = weight[..., None]
    weighted = cv2.GaussianBlur(values * alpha[..., None], (0, 0), sigma)
    return weighted / np.maximum(weight, 1e-4)


def align_neutral_guide(source: Image.Image, guide: Image.Image) -> np.ndarray:
    source_rgba = np.asarray(source.convert("RGBA"), dtype=np.uint8)
    source_rgb = source_rgba[..., :3]
    alpha = source_rgba[..., 3:4].astype(np.float32) / 255.0
    source_composite = np.round(source_rgb * alpha + 245 * (1.0 - alpha)).astype(
        np.uint8
    )
    guide_rgb = np.asarray(
        guide.convert("RGB").resize(source.size, Image.Resampling.LANCZOS),
        dtype=np.uint8,
    )

    detector = cv2.SIFT_create(
        nfeatures=4000,
        contrastThreshold=0.02,
    )
    source_points, source_descriptors = detector.detectAndCompute(
        cv2.cvtColor(source_composite, cv2.COLOR_RGB2GRAY),
        None,
    )
    guide_points, guide_descriptors = detector.detectAndCompute(
        cv2.cvtColor(guide_rgb, cv2.COLOR_RGB2GRAY),
        None,
    )
    if source_descriptors is None or guide_descriptors is None:
        raise RuntimeError(
            "Could not detect enough features to align the neutral guide"
        )

    matches = cv2.BFMatcher(cv2.NORM_L2).knnMatch(
        guide_descriptors,
        source_descriptors,
        k=2,
    )
    good_matches = [
        first for first, second in matches if first.distance < 0.72 * second.distance
    ]
    if len(good_matches) < 40:
        raise RuntimeError(f"Only {len(good_matches)} neutral-guide feature matches")
    guide_xy = np.asarray(
        [guide_points[match.queryIdx].pt for match in good_matches],
        dtype=np.float32,
    )
    source_xy = np.asarray(
        [source_points[match.trainIdx].pt for match in good_matches],
        dtype=np.float32,
    )
    transform, inliers = cv2.estimateAffinePartial2D(
        guide_xy,
        source_xy,
        method=cv2.RANSAC,
        ransacReprojThreshold=5.0,
        maxIters=5000,
        confidence=0.999,
    )
    inlier_count = 0 if inliers is None else int(inliers.sum())
    if transform is None or inlier_count < 30:
        raise RuntimeError(f"Neutral-guide alignment has only {inlier_count} inliers")
    return cv2.warpAffine(
        guide_rgb,
        transform,
        source.size,
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(245, 245, 245),
    )


def build_neutral_source(source: Image.Image, guide: Image.Image) -> Image.Image:
    source_rgba = np.asarray(source.convert("RGBA"), dtype=np.uint8)
    source_linear = srgb_to_linear(source_rgba[..., :3])
    guide_linear = srgb_to_linear(align_neutral_guide(source, guide))
    alpha = source_rgba[..., 3].astype(np.float32) / 255.0
    source_log = np.log(np.maximum(source_linear, 0.004))
    guide_log = np.log(np.maximum(guide_linear, 0.004))
    source_base = masked_gaussian(source_log, alpha, 4.0)
    guide_base = masked_gaussian(guide_log, alpha, 4.0)
    neutral_weight = np.clip((alpha - 0.02) / 0.78, 0.0, 1.0)[..., None]
    guide_corrected_log = source_log + neutral_weight * (
        guide_base - source_base + np.log(0.82)
    )
    source_luma_log = np.log(np.maximum(source_linear @ LUMA_WEIGHTS, 0.004))
    guide_luma_log = np.log(np.maximum(guide_linear @ LUMA_WEIGHTS, 0.004))
    source_luma_base = masked_gaussian(source_luma_log, alpha, 4.0)
    guide_luma_base = masked_gaussian(guide_luma_log, alpha, 4.0)
    chroma_preserved_log = (
        source_log
        + neutral_weight
        * (guide_luma_base - source_luma_base + np.log(0.82))[..., None]
    )
    neutral_log = (
        guide_corrected_log * (1.0 - SOURCE_CHROMA_RETENTION)
        + chroma_preserved_log * SOURCE_CHROMA_RETENTION
    )
    neutral_linear = np.exp(neutral_log)

    output = np.empty_like(source_rgba)
    output[..., :3] = linear_to_srgb(neutral_linear)
    output[..., 3] = source_rgba[..., 3]
    return Image.fromarray(output, "RGBA")


def extract_relight(
    frame_path: Path,
    model_x: int,
    content_width: int,
    source_size: tuple[int, int],
) -> Image.Image:
    panel = Image.open(frame_path).convert("RGB")
    if panel.width % 3:
        raise RuntimeError(f"Unexpected UniRelight panel width: {panel.width}")
    panel_width = panel.width // 3
    relit = panel.crop((panel_width, 0, panel_width * 2, panel.height))
    relit = relit.crop((model_x, 0, model_x + content_width, MODEL_SIZE[1]))
    return relit.resize(source_size, Image.Resampling.LANCZOS)


def transfer_generated_lighting(
    source: Image.Image,
    shadow_luma: np.ndarray,
    fully_lit_luma: np.ndarray,
    target: Image.Image,
) -> Image.Image:
    source_rgba = np.asarray(source, dtype=np.uint8)
    source_linear = srgb_to_linear(source_rgba[..., :3])
    target_linear = srgb_to_linear(np.asarray(target, dtype=np.uint8))

    target_luma = np.maximum(target_linear @ LUMA_WEIGHTS, 0.001)
    irradiance = (target_luma - shadow_luma) / np.maximum(
        fully_lit_luma - shadow_luma,
        0.008,
    )
    irradiance = np.clip(irradiance, 0.0, 1.25).astype(np.float32)
    irradiance = cv2.bilateralFilter(irradiance, 9, 0.08, 5.0)
    irradiance = cv2.GaussianBlur(irradiance, (0, 0), 1.2)
    irradiance = np.clip((irradiance - 0.022) / 0.978, 0.0, 1.25)

    alpha = source_rgba[..., 3].astype(np.float32) / 255.0
    irradiance *= np.clip(alpha / 0.35, 0.0, 1.0)
    illumination = irradiance[..., None] * COOL_DAYLIGHT_RGB
    relit = source_linear * illumination
    peak = np.max(relit, axis=2, keepdims=True)
    excess = np.maximum(peak - 0.78, 0.0)
    compressed_peak = 0.78 + 0.15 * excess / (excess + 0.15)
    relit *= np.where(peak > 0.78, compressed_peak / np.maximum(peak, 1e-4), 1.0)

    output = np.empty_like(source_rgba)
    output[..., :3] = linear_to_srgb(relit)
    output[..., 3] = source_rgba[..., 3]
    return Image.fromarray(output, "RGBA")


def default_frame_selection() -> tuple[list[tuple[int, int]], float, float]:
    light_x, light_y = DEFAULT_LIGHT
    light_y = max(-1.0, min(1.0, light_y))
    maximum_azimuth = FRONT_ARC_STEPS / AZIMUTH_SLOTS * 360.0
    signed_azimuth = -math.tanh(light_x * AZIMUTH_RESPONSE) * maximum_azimuth
    azimuth = signed_azimuth + 360.0 if signed_azimuth < 0 else signed_azimuth
    azimuth = azimuth / 360.0 * AZIMUTH_SLOTS
    elevation = min(
        len(ELEVATIONS_DEG) - 1,
        math.log1p(math.exp(ELEVATION_RESPONSE * (2.0 * light_y + 1.0)))
        / ELEVATION_RESPONSE,
    )

    azimuth0 = math.floor(azimuth) % AZIMUTH_SLOTS
    azimuth1 = (
        azimuth0 if azimuth0 == FRONT_ARC_STEPS else (azimuth0 + 1) % AZIMUTH_SLOTS
    )
    elevation0 = math.floor(elevation)
    elevation1 = min(elevation0 + 1, len(ELEVATIONS_DEG) - 1)
    return (
        [
            (elevation0, azimuth0),
            (elevation0, azimuth1),
            (elevation1, azimuth0),
            (elevation1, azimuth1),
        ],
        0.0 if azimuth0 == azimuth1 else azimuth - math.floor(azimuth),
        elevation - elevation0,
    )


def blend_default_frames(
    frames: list[Image.Image],
    azimuth_weight: float,
    elevation_weight: float,
) -> Image.Image:
    rgba = [np.asarray(frame.convert("RGBA"), dtype=np.uint8) for frame in frames]
    alpha = rgba[0][..., 3]
    if any(not np.array_equal(frame[..., 3], alpha) for frame in rgba[1:]):
        raise RuntimeError("Default light-field frames have inconsistent alpha")

    linear = [srgb_to_linear(frame[..., :3]) for frame in rgba]
    lower = linear[0] * (1.0 - azimuth_weight) + linear[1] * azimuth_weight
    upper = linear[2] * (1.0 - azimuth_weight) + linear[3] * azimuth_weight
    blended = lower * (1.0 - elevation_weight) + upper * elevation_weight

    output = np.empty_like(rgba[0])
    output[..., :3] = linear_to_srgb(blended)
    output[..., 3] = alpha
    return Image.fromarray(output, "RGBA")


def package_results(
    output: Path,
    neutral_source: Image.Image,
    model_x: int,
    content_width: int,
    raw_dir: Path,
) -> str:
    output.mkdir()
    source_width, source_height = neutral_source.size
    asset_hash = hashlib.sha256()

    result_dirs = sorted(path for path in raw_dir.glob("*_light-*") if path.is_dir())
    if len(result_dirs) != len(ELEVATIONS_DEG):
        raise RuntimeError(
            f"Expected {len(ELEVATIONS_DEG)} result folders, found {len(result_dirs)}"
        )

    frame_paths_by_elevation: list[list[tuple[int, Path]]] = []
    for result_dir in result_dirs:
        frames = sorted(result_dir.glob("*.png"))
        if len(frames) != INFERENCE_FRAMES:
            raise RuntimeError(
                f"Expected {INFERENCE_FRAMES} frames in {result_dir}, found {len(frames)}"
            )
        sampled_frames = frames[:-1:FRAME_STEP]
        frame_paths_by_elevation.append(
            [(index, sampled_frames[index]) for index in FRONT_ARC_AZIMUTH_INDICES]
        )

    generated_frames: list[list[Image.Image]] = []
    generated_luma: list[np.ndarray] = []
    for frame_paths in frame_paths_by_elevation:
        elevation_frames = []
        for _, frame_path in frame_paths:
            generated = extract_relight(
                frame_path,
                model_x,
                content_width,
                (source_width, source_height),
            )
            elevation_frames.append(generated)
            generated_linear = srgb_to_linear(np.asarray(generated, dtype=np.uint8))
            generated_luma.append(np.maximum(generated_linear @ LUMA_WEIGHTS, 0.001))
        generated_frames.append(elevation_frames)
    generated_luma_stack = np.stack(generated_luma)
    del generated_luma
    shadow_luma, fully_lit_luma = np.percentile(
        generated_luma_stack,
        (5, 75),
        axis=0,
        overwrite_input=True,
    )
    del generated_luma_stack

    for elevation_index, frame_paths in enumerate(frame_paths_by_elevation):
        output_dir = output / f"elev_{elevation_index:02d}"
        output_dir.mkdir()
        for frame_index, (azimuth_index, _) in enumerate(frame_paths):
            relit = transfer_generated_lighting(
                neutral_source,
                shadow_luma,
                fully_lit_luma,
                generated_frames[elevation_index][frame_index],
            )
            output_path = output_dir / f"az_{azimuth_index:02d}.webp"
            relit.save(
                output_path,
                "WEBP",
                quality=100,
                method=6,
                exact=True,
            )
            asset_hash.update(output_path.read_bytes())

    default_indices, azimuth_weight, elevation_weight = default_frame_selection()
    default_frames = []
    for elevation_index, azimuth_index in default_indices:
        with Image.open(
            output
            / f"elev_{elevation_index:02d}"
            / f"az_{azimuth_index:02d}.webp"
        ) as frame:
            default_frames.append(frame.convert("RGBA"))
    default_path = output / "default.webp"
    blend_default_frames(
        default_frames,
        azimuth_weight,
        elevation_weight,
    ).save(
        default_path,
        "WEBP",
        quality=100,
        method=6,
        exact=True,
    )
    asset_hash.update(default_path.read_bytes())

    return asset_hash.hexdigest()[:16]


def main() -> None:
    args = parse_args()
    args.source = args.source.resolve()
    args.neutral_guide = args.neutral_guide.resolve()
    args.repo = args.repo.resolve()
    args.checkpoints = args.checkpoints.resolve()
    args.workdir = args.workdir.resolve()
    args.output = args.output.resolve()

    raw_dir = args.workdir / "raw"
    fingerprint_path = args.workdir / INFERENCE_FINGERPRINT_FILE
    fingerprint = inference_fingerprint(
        args.inference_id,
        Path(__file__).resolve(),
        args.source,
        args.neutral_guide,
    )
    if args.skip_inference:
        try:
            stored_fingerprint = fingerprint_path.read_text(encoding="ascii").strip()
        except FileNotFoundError as error:
            raise RuntimeError(
                f"Missing inference fingerprint: {fingerprint_path}"
            ) from error
        if stored_fingerprint != fingerprint:
            raise RuntimeError(
                f"Inference fingerprint mismatch for workdir: {args.workdir}"
            )

    source = Image.open(args.source).convert("RGBA")
    neutral_guide = Image.open(args.neutral_guide).convert("RGB")
    neutral_source = build_neutral_source(source, neutral_guide)
    content_width = round(source.width * MODEL_SIZE[1] / source.height)
    model_x = (MODEL_SIZE[0] - content_width) // 2

    if not args.skip_inference:
        if args.workdir.exists():
            shutil.rmtree(args.workdir)
        input_root = args.workdir / "input"
        portrait_dir = input_root / "portrait"
        env_dir = args.workdir / "envs"
        for path in (portrait_dir, env_dir, raw_dir):
            path.mkdir(parents=True, exist_ok=True)
        prepare_input(
            neutral_source,
            portrait_dir / "00000.rgb.png",
            model_x,
            content_width,
        )
        for index, elevation in enumerate(ELEVATIONS_DEG):
            make_hdr(env_dir / f"{index:02d}_elev_{elevation:+05.1f}.hdr", elevation)
        run_inference(args, input_root, env_dir, raw_dir)
        fingerprint_path.write_text(f"{fingerprint}\n", encoding="ascii")
    pending_output = args.output.with_name(f"{args.output.name}.pending")
    if pending_output.exists():
        shutil.rmtree(pending_output)
    pending_output.mkdir(parents=True)

    tiers = {}
    for name, output_width in OUTPUT_WIDTHS.items():
        output_height = round(source.height * output_width / source.width)
        output_neutral = neutral_source.resize(
            (output_width, output_height),
            Image.Resampling.LANCZOS,
        )
        tiers[name] = {
            "version": package_results(
                pending_output / name,
                output_neutral,
                model_x,
                content_width,
                raw_dir,
            ),
            "source_size": [output_width, output_height],
        }

    manifest = {
        "azimuth_slots": AZIMUTH_SLOTS,
        "elevations_deg": ELEVATIONS_DEG,
        "front_arc_steps": FRONT_ARC_STEPS,
        "default_light": DEFAULT_LIGHT,
        "azimuth_response": AZIMUTH_RESPONSE,
        "elevation_response": ELEVATION_RESPONSE,
        "tiers": tiers,
    }
    (pending_output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.output.exists():
        shutil.rmtree(args.output)
    pending_output.rename(args.output)


if __name__ == "__main__":
    main()
