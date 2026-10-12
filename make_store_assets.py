from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'releases'
FONT = 'C:/Windows/Fonts/msyh.ttc'
BOLD = 'C:/Windows/Fonts/msyhbd.ttc'

def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size)

board = Image.new('RGB', (1280, 800), '#f4f7fa')
draw = ImageDraw.Draw(board)
icon = Image.open(ROOT / 'icons/daydream-icon-preview.png').resize((120, 120), Image.Resampling.LANCZOS)
board.paste(icon, (66, 60), icon)
draw.text((66, 214), '白日梦 Daydream', font=font(40, True), fill='#122c46')
draw.text((66, 283), '视频双语字幕 · 网页双语阅读', font=font(25), fill='#0058a3')
for y, title, detail in [
    (386, 'Alt + A  视频字幕', '独立开启与关闭字幕翻译'),
    (486, 'Alt + W  网页文字', '原文保留，中文放在下方'),
    (586, '默认本地翻译', '云翻译可选，由用户填写自己的 Key')
]:
    draw.text((66, y), title, font=font(26, True), fill='#122c46')
    draw.text((66, y + 43), detail, font=font(20), fill='#556577')
popup = Image.open(OUT / 'settings-ui.png').convert('RGB')
popup.thumbnail((430, 690), Image.Resampling.LANCZOS)
draw.rounded_rectangle((720, 35, 1190, 760), radius=24, fill='white', outline='#d9e1e8', width=2)
board.paste(popup, (740, 52))
draw.text((750, 763), '扩展设置界面 · 未填写任何个人密钥', font=font(16), fill='#556577')
board.save(OUT / 'store-screenshot-settings.png')
promo = Image.new('RGB', (440, 280), '#122c46')
draw = ImageDraw.Draw(promo)
promo.paste(icon, (160, 18), icon)
draw.text((80, 151), '白日梦 Daydream', font=font(30, True), fill='white')
draw.text((78, 213), '视频字幕 · 网页双语翻译', font=font(22), fill='#ffdb00')
promo.save(OUT / 'promo-440x280.png')
print('Created 1280x800 store screenshot and 440x280 promotional image')
