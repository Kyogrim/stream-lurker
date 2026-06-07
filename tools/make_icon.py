"""Generate icon.ico for Stream Lurker, matching the in-app logo:
a rounded-square tile with a diagonal cyan->purple gradient and a dark
circular 'pupil' in the center (an eye-like 'lurker' mark).

Rendered at high supersample for smooth edges, then packed into a
multi-size Windows .ico. Run from the project root:

    python tools/make_icon.py

Requires Pillow (`pip install pillow`).
"""
from PIL import Image, ImageDraw

# Brand colors (from style.css)
CYAN = (32, 211, 238)     # hsl(188,86%,53%)  top-left
PURPLE = (132, 66, 255)   # hsl(261,100%,63%) bottom-right
DARK = (9, 9, 11)         # hsl(240,10%,3.9%) app bg (center pupil)

SS = 1024  # supersample master size
canvas = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))

# --- diagonal gradient (135deg: top-left cyan -> bottom-right purple) ---
grad = Image.new("RGB", (SS, SS))
gpx = grad.load()
for y in range(SS):
    for x in range(SS):
        t = (x + y) / (2 * (SS - 1))  # 0 at TL, 1 at BR
        r = round(CYAN[0] + (PURPLE[0] - CYAN[0]) * t)
        g = round(CYAN[1] + (PURPLE[1] - CYAN[1]) * t)
        b = round(CYAN[2] + (PURPLE[2] - CYAN[2]) * t)
        gpx[x, y] = (r, g, b)

# --- rounded-square mask (tile fills ~88% of canvas) ---
margin = int(SS * 0.06)
radius = int(SS * 0.22)
mask = Image.new("L", (SS, SS), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [margin, margin, SS - margin, SS - margin], radius=radius, fill=255)
canvas.paste(grad, (0, 0), mask)

# --- dark circular 'pupil' in the center ---
draw = ImageDraw.Draw(canvas)
dot_r = int(SS * 0.155)
cx = cy = SS // 2
draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=DARK + (255,))

# --- subtle top-left glossy highlight for depth ---
gloss = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
ImageDraw.Draw(gloss).ellipse(
    [margin, margin, int(SS * 0.62), int(SS * 0.46)], fill=(255, 255, 255, 38))
gloss.putalpha(Image.composite(gloss.getchannel("A"),
                               Image.new("L", (SS, SS), 0), mask))
canvas = Image.alpha_composite(canvas, gloss)

master = canvas.resize((256, 256), Image.LANCZOS)
sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
master.save("icon.ico", format="ICO", sizes=sizes)
master.save("icon.png", format="PNG")  # 256px, for Linux/macOS/docs use
print("Wrote icon.ico with sizes:", [s[0] for s in sizes])
