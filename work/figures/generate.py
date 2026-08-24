"""Build square work-page thumbnails from real paper figure resources.

The source panels are extracted without modification from:

- ``eccv_workshop/figures/3-synthetic-lightfield.pdf`` on Monakhova
- ``Quantile-UQNet/docs/paper/Figures/hallucinations.pdf`` on Monakhova

Only deterministic cropping, resizing, and compositing are applied.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
RESOURCES = HERE / "resources"
OUTPUT = REPO_ROOT / "public" / "work"
SIZE = 1000
DIVIDER = (210, 213, 220)


def square(image: Image.Image) -> Image.Image:
    return ImageOps.fit(
        image.convert("RGB"),
        (SIZE, SIZE),
        method=Image.Resampling.LANCZOS,
    )


def split_figure(
    left_path: Path,
    right_path: Path,
    output_path: Path,
    *,
    left_crop: tuple[int, int, int, int] | None = None,
    right_crop: tuple[int, int, int, int] | None = None,
) -> None:
    with Image.open(left_path) as left_source, Image.open(right_path) as right_source:
        left = square(left_source.crop(left_crop) if left_crop else left_source)
        right = square(right_source.crop(right_crop) if right_crop else right_source)

    # A slightly diagonal split keeps the pair readable without adding labels.
    top_x = 430
    bottom_x = 520
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).polygon(
        [(0, 0), (top_x, 0), (bottom_x, SIZE), (0, SIZE)],
        fill=255,
    )

    figure = right.copy()
    figure.paste(left, mask=mask)
    ImageDraw.Draw(figure).line(
        [(top_x, 0), (bottom_x, SIZE)],
        fill=DIVIDER,
        width=4,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.save(output_path, "WEBP", quality=90, method=6)


def single_figure(
    source_path: Path,
    output_path: Path,
    *,
    crop: tuple[int, int, int, int] | None = None,
) -> None:
    with Image.open(source_path) as source:
        figure = square(source.crop(crop) if crop else source)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.save(output_path, "WEBP", quality=90, method=6)


def main() -> None:
    split_figure(
        RESOURCES / "lightfield-monocular.jpg",
        RESOURCES / "lightfield-multiview.jpg",
        OUTPUT / "lightfield.webp",
    )
    single_figure(
        RESOURCES / "qutcc-uncertainty.jpg",
        OUTPUT / "qutcc.webp",
        crop=(6, 13, 354, 361),
    )


if __name__ == "__main__":
    main()
