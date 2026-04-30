#!/usr/bin/env python3
"""Generate the portrait light atlas with IC-Light.

Run with:
  uv run --python 3.11 \
    --with torch --with diffusers --with transformers --with accelerate \
    --with safetensors --with huggingface-hub --with pillow --with numpy \
    python tools/generate_iclight_atlas.py
"""

from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np  # ty: ignore[unresolved-import]
import safetensors.torch as sf  # ty: ignore[unresolved-import]
import torch  # ty: ignore[unresolved-import]
from diffusers import (  # ty: ignore[unresolved-import]
    AutoencoderKL,
    DPMSolverMultistepScheduler,
    StableDiffusionImg2ImgPipeline,
    UNet2DConditionModel,
)
from diffusers.models.attention_processor import AttnProcessor2_0  # ty: ignore[unresolved-import]
from huggingface_hub import hf_hub_download  # ty: ignore[unresolved-import]
from PIL import Image, ImageFilter  # ty: ignore[unresolved-import]
from transformers import CLIPTextModel, CLIPTokenizer  # ty: ignore[unresolved-import]

SD15_MODEL = "stablediffusionapi/realistic-vision-v51"
ICLIGHT_REPO = "lllyasviel/ic-light"
ICLIGHT_MODEL = "iclight_sd15_fc.safetensors"
LIGHT_CELLS = [
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


def select_device() -> torch.device:
    if torch.backends.mps.is_available():
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def load_rgba(path: Path) -> Image.Image:
    return Image.open(path).convert("RGBA")


def fit_rgba(image: Image.Image, width: int, height: int) -> Image.Image:
    fitted = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    scale = min(width / image.width, height / image.height)
    size = (round(image.width * scale), round(image.height * scale))
    resized = image.resize(size, Image.Resampling.LANCZOS)
    fitted.alpha_composite(resized, ((width - size[0]) // 2, (height - size[1]) // 2))
    return fitted


def foreground_rgb(rgba: Image.Image) -> np.ndarray:
    arr = np.asarray(rgba, dtype=np.float32)
    alpha = arr[:, :, 3:4] / 255.0
    rgb = 127.0 + (arr[:, :, :3] - 127.0) * alpha
    return np.uint8(np.clip(rgb, 0, 255))


def alpha_mask(rgba: Image.Image) -> Image.Image:
    alpha = rgba.getchannel("A")
    return alpha.filter(ImageFilter.GaussianBlur(radius=0.35))


def numpy_to_pytorch(images: list[np.ndarray]) -> torch.Tensor:
    tensor = torch.from_numpy(np.stack(images, axis=0)).float() / 127.0 - 1.0
    return tensor.movedim(-1, 1)


def pytorch_to_numpy(images: torch.Tensor) -> list[np.ndarray]:
    results = []
    for image in images:
        arr = image.movedim(0, -1) * 127.5 + 127.5
        results.append(arr.detach().float().cpu().numpy().clip(0, 255).astype(np.uint8))
    return results


def gradient(width: int, height: int, x: float, y: float) -> np.ndarray:
    if x == 0.0 and y == 0.0:
        return np.full((height, width, 3), 127, dtype=np.uint8)
    xx = np.linspace(-1.0, 1.0, width, dtype=np.float32)[None, :]
    yy = np.linspace(1.0, -1.0, height, dtype=np.float32)[:, None]
    direction = np.array([x, y], dtype=np.float32)
    direction /= max(float(np.linalg.norm(direction)), 1e-6)
    ramp = 0.5 + 0.5 * (xx * direction[0] + yy * direction[1])
    ramp = np.clip(ramp, 0.0, 1.0)
    return np.repeat(np.uint8(np.round(ramp[:, :, None] * 255.0)), 3, axis=2)


class ICLightGenerator:
    def __init__(self, width: int, height: int) -> None:
        self.device = select_device()
        self.dtype = torch.float16 if self.device.type in {"cuda", "mps"} else torch.float32
        self.width = width
        self.height = height

        self.tokenizer = CLIPTokenizer.from_pretrained(SD15_MODEL, subfolder="tokenizer")
        self.text_encoder = CLIPTextModel.from_pretrained(SD15_MODEL, subfolder="text_encoder")
        self.vae = AutoencoderKL.from_pretrained(SD15_MODEL, subfolder="vae")
        self.unet = UNet2DConditionModel.from_pretrained(SD15_MODEL, subfolder="unet")
        self.patch_unet()
        self.load_iclight_weights()

        self.text_encoder = self.text_encoder.to(device=self.device, dtype=self.dtype)
        self.vae = self.vae.to(device=self.device, dtype=self.dtype)
        self.unet = self.unet.to(device=self.device, dtype=self.dtype)
        self.unet.set_attn_processor(AttnProcessor2_0())
        self.vae.set_attn_processor(AttnProcessor2_0())

        scheduler = DPMSolverMultistepScheduler(
            num_train_timesteps=1000,
            beta_start=0.00085,
            beta_end=0.012,
            beta_schedule="scaled_linear",
            algorithm_type="sde-dpmsolver++",
            use_karras_sigmas=True,
            steps_offset=1,
        )
        self.pipe = StableDiffusionImg2ImgPipeline(
            vae=self.vae,
            text_encoder=self.text_encoder,
            tokenizer=self.tokenizer,
            unet=self.unet,
            scheduler=scheduler,
            safety_checker=None,
            requires_safety_checker=False,
            feature_extractor=None,
            image_encoder=None,
        )
        self.pipe.set_progress_bar_config(disable=False)

    def patch_unet(self) -> None:
        conv_in = self.unet.conv_in
        new_conv_in = torch.nn.Conv2d(
            8,
            conv_in.out_channels,
            conv_in.kernel_size,
            conv_in.stride,
            conv_in.padding,
        )
        with torch.no_grad():
            new_conv_in.weight.zero_()
            new_conv_in.weight[:, :4, :, :].copy_(conv_in.weight)
            new_conv_in.bias = conv_in.bias
        self.unet.conv_in = new_conv_in
        original_forward = self.unet.forward

        def hooked_forward(sample: torch.Tensor, timestep: torch.Tensor, encoder_hidden_states: torch.Tensor, **kwargs: Any) -> Any:
            concat = kwargs["cross_attention_kwargs"]["concat_conds"].to(sample)
            concat = torch.cat([concat] * (sample.shape[0] // concat.shape[0]), dim=0)
            kwargs["cross_attention_kwargs"] = {}
            return original_forward(torch.cat([sample, concat], dim=1), timestep, encoder_hidden_states, **kwargs)

        self.unet.forward = hooked_forward  # type: ignore[method-assign]

    def load_iclight_weights(self) -> None:
        path = hf_hub_download(repo_id=ICLIGHT_REPO, filename=ICLIGHT_MODEL)
        offset = sf.load_file(path)
        origin = self.unet.state_dict()
        merged = {key: origin[key] + offset[key] for key in origin}
        self.unet.load_state_dict(merged, strict=True)

    @torch.inference_mode()
    def encode_prompt_inner(self, text: str) -> torch.Tensor:
        max_length = self.tokenizer.model_max_length
        chunk_length = max_length - 2
        tokens = self.tokenizer(text, truncation=False, add_special_tokens=False)["input_ids"]
        chunks = [
            [self.tokenizer.bos_token_id] + tokens[i : i + chunk_length] + [self.tokenizer.eos_token_id]
            for i in range(0, len(tokens), chunk_length)
        ]
        chunks = [chunk[:max_length] + [self.tokenizer.eos_token_id] * max(0, max_length - len(chunk)) for chunk in chunks]
        token_ids = torch.tensor(chunks).to(device=self.device, dtype=torch.int64)
        return self.text_encoder(token_ids).last_hidden_state

    @torch.inference_mode()
    def encode_prompt_pair(self, prompt: str, negative_prompt: str) -> tuple[torch.Tensor, torch.Tensor]:
        cond = self.encode_prompt_inner(prompt)
        uncond = self.encode_prompt_inner(negative_prompt)
        max_count = max(len(cond), len(uncond))
        cond = torch.cat([cond] * math.ceil(max_count / len(cond)), dim=0)[:max_count]
        uncond = torch.cat([uncond] * math.ceil(max_count / len(uncond)), dim=0)[:max_count]
        return (
            torch.cat([chunk[None, ...] for chunk in cond], dim=1),
            torch.cat([chunk[None, ...] for chunk in uncond], dim=1),
        )

    @torch.inference_mode()
    def encode_latent(self, image: np.ndarray) -> torch.Tensor:
        tensor = numpy_to_pytorch([image]).to(device=self.device, dtype=self.dtype)
        return self.vae.encode(tensor).latent_dist.mode() * self.vae.config.scaling_factor

    @torch.inference_mode()
    def relight(
        self,
        foreground: np.ndarray,
        light_bg: np.ndarray,
        prompt: str,
        negative_prompt: str,
        seed: int,
        steps: int,
        denoise: float,
        guidance: float,
    ) -> Image.Image:
        concat_conds = self.encode_latent(foreground)
        background_latent = self.encode_latent(light_bg)
        cond, uncond = self.encode_prompt_pair(prompt, negative_prompt)
        generator = torch.Generator(device=self.device).manual_seed(seed)
        latent = self.pipe(
            image=background_latent,
            strength=denoise,
            prompt_embeds=cond,
            negative_prompt_embeds=uncond,
            width=self.width,
            height=self.height,
            num_inference_steps=max(1, round(steps / denoise)),
            num_images_per_prompt=1,
            generator=generator,
            output_type="latent",
            guidance_scale=guidance,
            cross_attention_kwargs={"concat_conds": concat_conds},
        ).images.to(self.dtype)
        pixels = self.vae.decode(latent / self.vae.config.scaling_factor).sample
        return Image.fromarray(pytorch_to_numpy(pixels)[0], mode="RGB")


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


def transfer_lighting(source: Image.Image, generated: Image.Image, mask: Image.Image) -> Image.Image:
    source_arr = np.asarray(source.convert("RGBA"), dtype=np.float32)
    generated_rgb = np.asarray(generated.convert("RGB"), dtype=np.float32) / 255.0
    source_rgb = source_arr[:, :, :3] / 255.0
    alpha = np.asarray(mask, dtype=np.float32)[:, :, None] / 255.0

    source_luma = blur_array(luminance(source_rgb), radius=10.0)
    generated_luma = blur_array(luminance(generated_rgb), radius=18.0)
    ratio = np.clip(generated_luma / np.maximum(source_luma, 0.08), 0.42, 1.85)
    ratio = blur_array(ratio, radius=7.0)[:, :, None]

    source_color = blur_array(source_rgb, radius=18.0)
    generated_color = blur_array(generated_rgb, radius=24.0)
    tint = np.clip(generated_color / np.maximum(source_color, 0.08), 0.72, 1.28)
    relit = source_rgb * ratio * (0.88 + tint * 0.12)

    detail = np.clip(source_rgb / np.maximum(blur_array(source_rgb, radius=1.4), 0.05), 0.82, 1.18)
    relit = np.clip(relit * np.power(detail, 0.25), 0.0, 1.0)
    rgb = source_rgb * (1.0 - alpha) + relit * alpha
    return Image.fromarray(np.uint8(np.dstack([rgb, source_arr[:, :, 3:4] / 255.0]) * 255.0), mode="RGBA")


def build_atlas(args: argparse.Namespace) -> None:
    width = args.width - (args.width % 64)
    height = args.height - (args.height % 64)
    source = fit_rgba(load_rgba(args.source), width, height)
    foreground = foreground_rgb(source)
    mask = alpha_mask(source)
    prompt = args.prompt + ", " + args.added_prompt
    generator = ICLightGenerator(width, height)
    atlas = Image.new("RGBA", (width * 3, height * 3), (0, 0, 0, 0))

    with tempfile.TemporaryDirectory(prefix="shamus-iclight-") as tmp:
        tmp_dir = Path(tmp)
        for index, cell in enumerate(LIGHT_CELLS):
            name = str(cell["name"])
            light_bg = gradient(width, height, float(cell["x"]), float(cell["y"]))
            result = generator.relight(
                foreground=foreground,
                light_bg=light_bg,
                prompt=prompt,
                negative_prompt=args.negative_prompt,
                seed=args.seed + index,
                steps=args.steps,
                denoise=args.denoise,
                guidance=args.guidance,
            )
            relit = source if cell["name"] == "center" else transfer_lighting(source, result, mask)
            relit.save(tmp_dir / f"{index:02d}-{name}.png")
            atlas.paste(relit, (int(cell["col"]) * width, int(cell["row"]) * height))

    args.atlas_dir.mkdir(parents=True, exist_ok=True)
    atlas_path = args.atlas_dir / "shamus-light-atlas.png"
    atlas.save(atlas_path, optimize=True)
    metadata = {
        "source": str(args.source),
        "atlas": atlas_path.name,
        "cellWidth": width,
        "cellHeight": height,
        "grid": [3, 3],
        "initialLight": {"x": 0.0, "y": 0.0},
        "runtime": "single-texture-webgl2-bilinear-iclight-atlas",
        "generator": {
            "model": ICLIGHT_REPO,
            "checkpoint": ICLIGHT_MODEL,
            "baseModel": SD15_MODEL,
            "prompt": prompt,
            "negativePrompt": args.negative_prompt,
            "steps": args.steps,
            "denoise": args.denoise,
            "guidance": args.guidance,
            "seed": args.seed,
        },
        "cells": LIGHT_CELLS,
    }
    (args.atlas_dir / "shamus-light-atlas.json").write_text(json.dumps(metadata, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("static/resources/shamus-picture.png"))
    parser.add_argument("--atlas-dir", type=Path, default=Path("static/resources/relight-atlas"))
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--steps", type=int, default=14)
    parser.add_argument("--denoise", type=float, default=0.78)
    parser.add_argument("--guidance", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=4660)
    parser.add_argument(
        "--prompt",
        default="handsome man, detailed face, realistic portrait, cinematic studio lighting",
    )
    parser.add_argument(
        "--added-prompt",
        default="best quality, natural skin texture, coherent shadows, same person",
    )
    parser.add_argument(
        "--negative-prompt",
        default="lowres, bad anatomy, bad hands, cropped, distorted face, different person, worst quality",
    )
    build_atlas(parser.parse_args())


if __name__ == "__main__":
    main()
