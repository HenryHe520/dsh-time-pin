#!/usr/bin/env python3
"""Prepare marketplace screenshots for dsh-time-pin.

Reads the raw captures the maintainer drops into `docs/screenshots/`
(`raw-*.png|jpg|jpeg|webp`) and writes cleaned, consistently sized PNGs plus an
optional slideshow GIF. No external services, no metadata leakage.

Usage:
    python scripts/process-screenshots.py [--width 1440] [--gif]

Outputs (same directory):
    shot-01-default.png ...      resized, metadata-stripped, RGB PNGs
    demo-slideshow.gif           only with --gif, or when raw-demo.gif is absent
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - environment guard
    print("Pillow is required (it ships with the DSH runtime).", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"
RAW_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def natural_key(path: Path) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def load_rgb(path: Path) -> Image.Image:
    image = Image.open(path)
    image.load()
    # Drop EXIF/ICC and any alpha: marketplace PNGs want plain RGB.
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        background = Image.new("RGB", image.size, (255, 255, 255))
        rgba = image.convert("RGBA")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")


def resize(image: Image.Image, target_width: int) -> Image.Image:
    if image.width <= target_width:
        return image
    height = round(image.height * target_width / image.width)
    return image.resize((target_width, height), Image.LANCZOS)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=int, default=1440, help="target max width in pixels")
    parser.add_argument("--gif", action="store_true", help="write a slideshow GIF from the shots")
    args = parser.parse_args()

    SHOTS.mkdir(parents=True, exist_ok=True)
    raws = sorted(
        (path for path in SHOTS.iterdir() if path.stem.startswith("raw-") and path.suffix.lower() in RAW_SUFFIXES),
        key=natural_key,
    )
    if not raws:
        print(f"No raw-*.png|jpg captures in {SHOTS}")
        return 1

    written: list[Path] = []
    for index, raw in enumerate(raws, start=1):
        image = resize(load_rgb(raw), args.width)
        stem = re.sub(r"^raw-\d*[-_]?", "", raw.stem) or f"cap{index:02d}"
        target = SHOTS / f"shot-{index:02d}-{stem}.png"
        # Strip metadata: a fresh RGB save carries none.
        image.save(target, format="PNG", optimize=True)
        written.append(target)
        print(f"{raw.name} -> {target.name} ({image.width}x{image.height}, {target.stat().st_size // 1024} KiB)")

    demo = SHOTS / "raw-demo.gif"
    if args.gif or not demo.exists():
        frames = [Image.open(path).convert("RGB") for path in written]
        if frames:
            gif_target = SHOTS / "demo-slideshow.gif"
            frames[0].save(
                gif_target,
                save_all=True,
                append_images=frames[1:],
                duration=2200,
                loop=0,
                optimize=True,
            )
            print(f"slideshow -> {gif_target.name} ({gif_target.stat().st_size // 1024} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
