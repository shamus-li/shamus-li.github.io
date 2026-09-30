"""Compress the portrait light field into a linear basis for the home page.

Every frame in ``frames/<tier>/elev_XX/az_YY.webp`` is approximated as the mean
image plus a weighted sum of ``COMPONENTS`` basis images from an SVD. The page
script bundles the per-frame weights, downloads the mean and basis images once,
then relights any light position in a single shader pass.
"""

import io
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
FRAMES = HERE / "frames"
OUTPUT = HERE.parent / "public" / "relight-field"
WEIGHTS = HERE.parent / "src" / "portrait-light-field-weights.json"
POSTER = "elev_02/az_06.webp"
COMPONENTS = 12
POSTER_QUALITY = 80
MEAN_QUALITY = 90
BASIS_QUALITY = {"standard": 70, "high": 60}


def encode(pixels: np.ndarray, quality: int) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, "AVIF", quality=quality, speed=0)
    return buffer.getvalue()


def decode(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as image:
        return np.asarray(image.convert("RGB"), dtype=np.float32) / 255


def to_bytes(values: np.ndarray) -> np.ndarray:
    return np.clip(np.round(values * 255), 0, 255).astype(np.uint8)


def build(tier: str) -> dict[str, list[float]]:
    paths = sorted((FRAMES / tier).glob("elev_*/az_*.webp"))
    names = [
        path.relative_to(FRAMES / tier).with_suffix("").as_posix() for path in paths
    ]
    frames = np.stack(
        [
            np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255
            for path in paths
        ]
    )
    count, height, width, _ = frames.shape
    alpha = frames[0, ..., 3]
    if np.any(frames[..., 3] != alpha):
        raise ValueError(f"{tier} frames do not share one alpha mask")
    foreground = np.repeat(alpha.reshape(-1) > 0, 3)
    colors = frames[..., :3].reshape(count, -1)

    mean = colors.mean(0)
    _, _, basis = np.linalg.svd(colors - mean, full_matrices=False)

    output = OUTPUT / tier
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    # The WebP poster is the still portrait for browsers without AVIF.
    shutil.copy(FRAMES / tier / POSTER, output / "poster.webp")
    with Image.open(FRAMES / tier / POSTER) as poster:
        (output / "poster.avif").write_bytes(
            encode(np.asarray(poster.convert("RGBA")), POSTER_QUALITY)
        )

    mean_data = encode(
        to_bytes(np.dstack([mean.reshape(height, width, 3), alpha])), MEAN_QUALITY
    )
    (output / "mean.avif").write_bytes(mean_data)
    decoded_mean = decode(mean_data).reshape(-1)

    decoded_basis = []
    for index in range(COMPONENTS):
        component = basis[index] / np.abs(basis[index][foreground]).max()
        data = encode(
            to_bytes(component.reshape(height, width, 3) * 0.5 + 0.5),
            BASIS_QUALITY[tier],
        )
        (output / f"basis_{index:02d}.avif").write_bytes(data)
        decoded_basis.append(decode(data).reshape(-1) * 2 - 1)
    decoded = np.stack(decoded_basis)

    # Fit weights against the encoded images so compression error is absorbed.
    weights = np.linalg.lstsq(
        decoded[:, foreground].T, (colors - decoded_mean)[:, foreground].T, rcond=None
    )[0].T
    error = ((decoded_mean + weights @ decoded - colors)[:, foreground] ** 2).mean(1)
    psnr = 10 * np.log10(1 / error)
    print(f"{tier}: PSNR min {psnr.min():.1f} dB, mean {psnr.mean():.1f} dB")

    return {
        name: [round(float(value), 4) for value in row]
        for name, row in zip(names, weights)
    }


if __name__ == "__main__":
    WEIGHTS.write_text(
        json.dumps(
            {tier: build(tier) for tier in ("standard", "high")}, separators=(",", ":")
        )
        + "\n"
    )
