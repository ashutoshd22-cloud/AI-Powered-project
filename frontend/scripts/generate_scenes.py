"""Generates LifeOS's original background scenes as SVG (deterministic, no external assets).

Usage: python scripts/generate_scenes.py public/scenes
"""

import math
import random
import sys
from pathlib import Path

W, H = 1920, 1080


def stars(rng: random.Random, count: int, max_y: float, color: str = "#ffffff") -> str:
    out = []
    for _ in range(count):
        x, y = rng.uniform(0, W), rng.uniform(0, max_y) ** 1.15 / max_y**0.15
        r = rng.choice([0.6, 0.8, 1.0, 1.2, 1.6, 2.2])
        o = rng.uniform(0.35, 0.95)
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="{color}" opacity="{o:.2f}"/>')
    return "".join(out)


def ridge(rng: random.Random, base: float, amp: float, rough: float, seed_shift: float) -> str:
    """Closed path of a mountain ridge built from summed sines plus jitter."""
    pts = []
    phases = [rng.uniform(0, math.tau) for _ in range(4)]
    for i in range(0, W + 41, 40):
        t = i / W
        y = base - amp * (
            0.55 * math.sin(t * 3.1 + phases[0] + seed_shift)
            + 0.30 * math.sin(t * 7.3 + phases[1])
            + 0.15 * math.sin(t * 15.7 + phases[2])
        )
        y += rng.uniform(-rough, rough)
        pts.append(f"{i},{y:.0f}")
    return f'M0,{H} L{" L".join(pts)} L{W},{H} Z'


def svg(defs: str, body: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice">'
        f"<defs>{defs}</defs>{body}</svg>\n"
    )


def aurora() -> str:
    rng = random.Random(7)
    defs = (
        '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#030712"/><stop offset=".55" stop-color="#0b1d3a"/>'
        '<stop offset="1" stop-color="#0f3b4a"/></linearGradient>'
        '<linearGradient id="a1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#22d3ee" stop-opacity="0"/>'
        '<stop offset=".35" stop-color="#2dd4bf"/><stop offset=".7" stop-color="#4ade80"/>'
        '<stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></linearGradient>'
        '<linearGradient id="a2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#818cf8" stop-opacity="0"/>'
        '<stop offset=".5" stop-color="#38bdf8"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></linearGradient>'
        '<filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="38"/></filter>'
        '<linearGradient id="snow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a5f"/>'
        '<stop offset="1" stop-color="#0b1626"/></linearGradient>'
    )
    body = (
        f'<rect width="{W}" height="{H}" fill="url(#sky)"/>{stars(rng, 260, 700)}'
        '<g filter="url(#glow)" opacity=".85">'
        '<path d="M-100,520 C300,300 620,620 980,380 S1600,240 2020,420 L2020,520 C1600,360 1240,520 980,500 S300,440 -100,640 Z" fill="url(#a1)"/>'
        '<path d="M-100,360 C380,200 760,460 1120,260 S1700,180 2020,300 L2020,360 C1700,260 1300,400 1120,360 S420,300 -100,450 Z" fill="url(#a2)" opacity=".7"/>'
        "</g>"
        f'<path d="{ridge(rng, 860, 120, 6, 0)}" fill="#13284a"/>'
        f'<path d="{ridge(rng, 960, 80, 4, 1.7)}" fill="url(#snow)"/>'
    )
    return svg(defs, body)


def dusk() -> str:
    rng = random.Random(11)
    defs = (
        '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#312e81"/>'
        '<stop offset=".45" stop-color="#be185d"/><stop offset=".75" stop-color="#fb923c"/>'
        '<stop offset="1" stop-color="#fde68a"/></linearGradient>'
        '<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff7ed"/>'
        '<stop offset=".35" stop-color="#fed7aa"/><stop offset="1" stop-color="#fb923c" stop-opacity="0"/></radialGradient>'
    )
    layers = [("#7c2d5a", 700, 170, 0.0), ("#5b2150", 790, 140, 1.2), ("#3b1747", 880, 110, 2.4), ("#1f0f33", 980, 70, 3.1)]
    ridges = "".join(f'<path d="{ridge(rng, b, a, 8, s)}" fill="{c}"/>' for c, b, a, s in layers)
    body = (
        f'<rect width="{W}" height="{H}" fill="url(#sky)"/>{stars(rng, 70, 330, "#fde68a")}'
        '<circle cx="1260" cy="660" r="330" fill="url(#sun)" opacity=".9"/>'
        '<circle cx="1260" cy="660" r="92" fill="#fff1d6"/>'
        f"{ridges}"
    )
    return svg(defs, body)


def ocean() -> str:
    rng = random.Random(3)
    defs = (
        '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0ea5e9"/>'
        '<stop offset=".55" stop-color="#7dd3fc"/><stop offset="1" stop-color="#e0f2fe"/></linearGradient>'
        '<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0891b2"/>'
        '<stop offset="1" stop-color="#083344"/></linearGradient>'
        '<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffffff"/>'
        '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>'
        '<filter id="soft"><feGaussianBlur stdDeviation="22"/></filter>'
    )
    clouds = "".join(
        f'<ellipse cx="{rng.uniform(0, W):.0f}" cy="{rng.uniform(120, 420):.0f}" rx="{rng.uniform(140, 320):.0f}" '
        f'ry="{rng.uniform(26, 60):.0f}" fill="#ffffff" opacity="{rng.uniform(.35, .7):.2f}"/>'
        for _ in range(9)
    )
    waves = []
    for k in range(9):
        y0 = 640 + k * 52
        amp = 6 + k * 2.2
        pts = " ".join(f"{x},{y0 + amp * math.sin(x / (90 + k * 14) + k):.0f}" for x in range(0, W + 41, 40))
        shade = 0.10 + k * 0.035
        waves.append(f'<path d="M0,{H} L{pts.replace(" ", " L")} L{W},{H} Z" fill="#082f49" opacity="{shade:.2f}"/>')
    glints = "".join(
        f'<rect x="{rng.gauss(560, 140):.0f}" y="{rng.uniform(650, 900):.0f}" width="{rng.uniform(18, 70):.0f}" height="2" '
        f'rx="1" fill="#ffffff" opacity="{rng.uniform(.3, .8):.2f}"/>'
        for _ in range(60)
    )
    body = (
        f'<rect width="{W}" height="{H}" fill="url(#sky)"/>'
        f'<g filter="url(#soft)">{clouds}</g>'
        '<circle cx="560" cy="520" r="260" fill="url(#sun)" opacity=".9"/>'
        f'<rect y="620" width="{W}" height="{H - 620}" fill="url(#sea)"/>{"".join(waves)}{glints}'
    )
    return svg(defs, body)


def nebula() -> str:
    rng = random.Random(21)
    defs = (
        '<radialGradient id="bg" cx=".45" cy=".4" r=".9"><stop offset="0" stop-color="#1e1b4b"/>'
        '<stop offset="1" stop-color="#020617"/></radialGradient>'
        '<filter id="cloud" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter>'
    )
    palette = ["#7c3aed", "#db2777", "#06b6d4", "#2563eb", "#c026d3", "#14b8a6"]
    blobs = "".join(
        f'<ellipse cx="{rng.uniform(150, W - 150):.0f}" cy="{rng.uniform(120, H - 120):.0f}" '
        f'rx="{rng.uniform(160, 380):.0f}" ry="{rng.uniform(90, 240):.0f}" fill="{rng.choice(palette)}" '
        f'opacity="{rng.uniform(.25, .55):.2f}" transform="rotate({rng.uniform(-35, 35):.0f})"/>'
        for _ in range(14)
    )
    bright = "".join(
        f'<circle cx="{rng.uniform(0, W):.0f}" cy="{rng.uniform(0, H):.0f}" r="{rng.uniform(1.8, 3.2):.1f}" fill="#ffffff"/>'
        for _ in range(18)
    )
    body = f'<rect width="{W}" height="{H}" fill="url(#bg)"/><g filter="url(#cloud)">{blobs}</g>{stars(rng, 380, H)}{bright}'
    return svg(defs, body)


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for name, fn in {"aurora": aurora, "dusk": dusk, "ocean": ocean, "nebula": nebula}.items():
        (out / f"{name}.svg").write_text(fn(), encoding="utf-8")
        print(name, (out / f"{name}.svg").stat().st_size, "bytes")
