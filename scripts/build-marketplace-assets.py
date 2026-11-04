#!/usr/bin/env python3
"""Build marketplace-ready images from the raw DSH captures.

Input : docs/screenshots/raw-*.png
Output: docs/screenshots/shot-01..04.png (1280x720, opaque PNG, no metadata)
        docs/screenshots/demo-slideshow.gif
        docs/screenshots/icon-512.png is produced separately from icon.svg.

Design: a light neutral canvas, one rounded white card with a soft shadow, an
English caption + subtitle, and the raw capture at its natural aspect ratio.
Captions are annotations about real UI, never mocked UI.
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"
W, H = 1280, 720
FONT_DIR = Path("C:/Windows/Fonts")
BOLD = FONT_DIR / "segoeuib.ttf"
REGULAR = FONT_DIR / "segoeui.ttf"
SEMI = FONT_DIR / "seguisb.ttf"


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    for candidate in (path, SEMI, BOLD, REGULAR):
        if candidate.exists():
            try:
                return ImageFont.truetype(str(candidate), size)
            except OSError:
                continue
    return ImageFont.load_default()


def gradient(width: int, height: int, top=(248, 250, 253), bottom=(228, 234, 243)) -> Image.Image:
    canvas = Image.new("RGB", (width, height), top)
    draw = ImageDraw.Draw(canvas)
    for y in range(height):
        t = y / max(1, height - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color)
    return canvas


def rounded_card(canvas: Image.Image, box: tuple[int, int, int, int], radius: int = 22) -> None:
    x0, y0, x1, y1 = box
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x0 + 4, y0 + 10, x1 + 4, y1 + 12), radius=radius, fill=(23, 34, 51, 60)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB"), (0, 0))
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=(255, 255, 255, 255))
    draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, outline=(214, 222, 233, 255), width=1)
    canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB"), (0, 0))


def compose(name: str, caption: str, subtitle: str, content: Image.Image, scale: float,
            pad: int = 34) -> Path:
    canvas = gradient(W, H)
    draw = ImageDraw.Draw(canvas)
    title_font = font(BOLD, 40)
    subtitle_font = font(REGULAR, 21)
    brand_font = font(SEMI, 17)

    title_box = draw.textbbox((0, 0), caption, font=title_font)
    draw.text(((W - (title_box[2] - title_box[0])) // 2, 50), caption, font=title_font, fill=(21, 32, 50))
    sub_box = draw.textbbox((0, 0), subtitle, font=subtitle_font)
    draw.text(((W - (sub_box[2] - sub_box[0])) // 2, 104), subtitle, font=subtitle_font, fill=(104, 116, 134))

    CARD_TOP = 156
    CARD_BOTTOM = 76
    MAX_W = W - 140
    MAX_H = H - CARD_TOP - CARD_BOTTOM
    MAX_CONTENT_W = MAX_W - pad * 2
    MAX_CONTENT_H = MAX_H - pad * 2

    # Fit the content inside the card (padding included), never clipping it or
    # the brand line below the card.
    fit = min(scale, MAX_CONTENT_H / content.height, MAX_CONTENT_W / content.width)
    target = content.resize((round(content.width * fit), round(content.height * fit)), Image.LANCZOS)
    card_w = min(MAX_W + pad * 2, target.width + pad * 2)
    card_h = target.height + pad * 2
    x0 = (W - card_w) // 2
    y0 = CARD_TOP + max(0, (MAX_H - card_h) // 2)
    rounded_card(canvas, (x0, y0, x0 + card_w, y0 + card_h))
    px = x0 + (card_w - target.width) // 2
    py = y0 + (card_h - target.height) // 2
    canvas.paste(target, (px, py))

    label = "dsh-time-pin · Time Anchor"
    brand_box = draw.textbbox((0, 0), label, font=brand_font)
    draw.text(((W - (brand_box[2] - brand_box[0])) // 2, H - 52), label, font=brand_font, fill=(140, 150, 166))

    target_path = SHOTS / name
    canvas.save(target_path, format="PNG", optimize=True)
    print(f"{name}: {canvas.width}x{canvas.height}, {target_path.stat().st_size // 1024} KiB")
    return target_path


def stack(images: list[tuple[Image.Image, str]], width: int, gap: int = 26) -> Image.Image:
    """Stack labeled strips vertically onto a transparent-ish white sheet."""
    label_font = font(SEMI, 22)
    scaled = []
    for image, label in images:
        factor = width / image.width
        resized = image.resize((width, round(image.height * factor)), Image.LANCZOS)
        scaled.append((resized, label))
    height = sum(r.height + 52 for r, _ in scaled) + gap * (len(scaled) - 1)
    sheet = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    y = 0
    for resized, label in scaled:
        draw.text((2, y), label, font=label_font, fill=(90, 102, 120))
        y += 34
        sheet.paste(resized, (0, y))
        y += resized.height + gap
    return sheet


def chip_gallery(chip: Image.Image) -> Image.Image:
    """Chip crop (left) plus a plain-text legend of the three header states."""
    upscaled = chip.resize((chip.width * 2, chip.height * 2), Image.LANCZOS)
    upscaled = upscaled.filter(ImageFilter.UnsharpMask(radius=1.2, percent=140, threshold=2))
    sheet = Image.new("RGB", (980, 400), (255, 255, 255))
    sheet.paste(upscaled, (30, (400 - upscaled.height) // 2))
    draw = ImageDraw.Draw(sheet)
    head_font = font(SEMI, 24)
    detail_font = font(REGULAR, 18)
    rows = [
        ("Default · Unlimited", "nothing injected, no date filtering"),
        ("2000-01-01 · last 10 years", "restricted: only dated sources inside the window"),
        ("3000-01-01 · unlimited", "future view: speculation, never fact"),
    ]
    y = 34
    for index, (headline, detail) in enumerate(rows):
        color = [(36, 123, 191), (28, 110, 160), (94, 84, 176)][index]
        draw.ellipse((530, y + 8, 542, y + 20), fill=color)
        draw.text((560, y), headline, font=head_font, fill=(28, 40, 58))
        draw.text((560, y + 30), detail, font=detail_font, fill=(110, 122, 140))
        y += 112
    return sheet


def cover(chip: Image.Image, panel: Image.Image) -> Image.Image:
    """16:9 dark hero cover for the marketplace card."""
    width, height = 1280, 720
    canvas = Image.new("RGB", (width, height), (11, 21, 38))
    draw = ImageDraw.Draw(canvas)
    for y in range(height):
        t = y / (height - 1)
        color = (
            round(11 + (20 - 11) * t),
            round(21 + (36 - 21) * t),
            round(38 + (62 - 38) * t),
        )
        draw.line([(0, y), (width, y)], fill=color)
    # soft accent glow
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((760, -180, 1420, 460), fill=(58, 110, 220, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), glow).convert("RGB"), (0, 0))

    draw.text((72, 86), "Time Anchor", font=font(BOLD, 76), fill=(255, 255, 255))
    draw.text((76, 188), "dsh-time-pin  ·  DeepSeek Harness plugin", font=font(REGULAR, 24), fill=(147, 180, 226))
    draw.text((76, 244), "Pin the agent’s “as of” clock and give every", font=font(SEMI, 30), fill=(226, 234, 246))
    draw.text((76, 283), "conversation a dated evidence window.", font=font(SEMI, 30), fill=(226, 234, 246))

    bullets = [
        "Past, future or BC time points, plus a lookback span",
        "Restricted evidence: only dated sources inside the window",
        "Anchor echo, filtered web_search, silent-job time facts",
    ]
    y = 372
    for bullet in bullets:
        draw.ellipse((80, y + 9, 92, y + 21), fill=(86, 156, 255))
        draw.text((108, y), bullet, font=font(REGULAR, 21), fill=(183, 201, 226))
        y += 44

    # Header control card (top right)
    card = Image.new("RGB", (440, 300), (255, 255, 255))
    chip_up = chip.resize((chip.width * 2, chip.height * 2), Image.LANCZOS)
    chip_up = chip_up.filter(ImageFilter.UnsharpMask(radius=1.2, percent=140, threshold=2))
    card.paste(chip_up, ((440 - chip_up.width) // 2, (300 - chip_up.height) // 2))
    rounded_card(canvas, (782, 128, 782 + 440, 128 + 300))
    canvas.paste(card, (782, 128))

    # Settings panel peeking below the header card (bottom right)
    panel_small = panel.resize((round(panel.width * 0.34), round(panel.height * 0.34)), Image.LANCZOS)
    px, py = 946, 470
    rounded_card(canvas, (px - 10, py - 10, px + panel_small.width + 10, py + panel_small.height + 10))
    canvas.paste(panel_small, (px, py))

    draw.text((76, 664), "npm: dsh-time-pin@0.1.0   ·   github.com/HenryHe520/dsh-time-pin", font=font(REGULAR, 19), fill=(122, 146, 180))
    target = SHOTS / "cover-16x9.png"
    canvas.save(target, format="PNG", optimize=True)
    print(f"cover-16x9.png: {canvas.width}x{canvas.height}, {target.stat().st_size // 1024} KiB")
    return target


def main() -> int:
    raw = {path.stem: Image.open(path).convert("RGB") for path in SHOTS.glob("raw-*.png")}
    outputs: list[Path] = []

    chip = raw["raw-01-default"]
    outputs.append(compose(
        "shot-01-default.png",
        "A pinned clock in the conversation header",
        "Default mode injects nothing and filters nothing — pin a point and a lookback span when you need one",
        chip_gallery(chip), 1.0,
    ))

    panel = raw["raw-02-panel"]
    outputs.append(compose(
        "shot-02-window-panel.png",
        "Set a time point and a lookback span",
        "Past, future or BC; one click applies it to this conversation",
        panel, 0.82,
    ))

    receipts = stack([
        (raw["raw-03-pinned"], "Restricted mode: a dated evidence window, undated sources excluded"),
        (raw["raw-04-future"], "Future view: the model is told it cannot know that period"),
    ], width=1120)
    outputs.append(compose(
        "shot-03-command-receipts.png",
        "One command, one validator",
        "/pin receipt for a pinned 2000-01-01 window and for a future 3000-01-01 view",
        receipts, 1.0,
    ))

    settings = raw["raw-05-settings"]
    outputs.append(compose(
        "shot-04-settings.png",
        "Configure it from the Plugins page",
        "Model-prompt language, silence narration on/off, first delay and refresh interval",
        settings, 0.63,
    ))

    cover(chip, raw["raw-02-panel"])

    frames = [Image.open(path).convert("RGB") for path in outputs]
    gif = SHOTS / "demo-slideshow.gif"
    frames[0].save(gif, save_all=True, append_images=frames[1:], duration=2400, loop=0, optimize=True)
    print(f"demo-slideshow.gif: {gif.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
