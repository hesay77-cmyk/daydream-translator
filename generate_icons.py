from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
BLUE = "#0058a3"
YELLOW = "#ffdb00"
NAVY = "#122c46"
WHITE = "#ffffff"

canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((24, 24, 488, 488), radius=112, fill=NAVY)
draw.rounded_rectangle((68, 90, 444, 340), radius=44, fill=BLUE)
draw.polygon(((218, 140), (218, 276), (332, 208)), fill=WHITE)
draw.rounded_rectangle((164, 288, 456, 412), radius=34, fill=YELLOW)
draw.polygon(((208, 394), (188, 446), (266, 394)), fill=YELLOW)
draw.rounded_rectangle((204, 320, 414, 342), radius=11, fill=NAVY)
draw.rounded_rectangle((204, 360, 360, 382), radius=11, fill=NAVY)


icons = ROOT / "icons"
icons.mkdir(exist_ok=True)
canvas.save(icons / 'daydream-icon-preview.png')
for size in (16, 32, 48, 128):
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(icons / f"icon-{size}.png")
