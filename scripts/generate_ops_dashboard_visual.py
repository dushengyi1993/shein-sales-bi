#!/usr/bin/env python3
"""Generate a dark neon SHEIN ops dashboard PNG from local report data.

The output is intentionally a normal image so it can be embedded into a Lark
Doc. This avoids relying on Lark Base native Dashboard blocks, which may be
created successfully by API but still fail to render in the Feishu frontend.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
FX_SAR_TO_RMB = 1.8


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def bj_now() -> datetime:
    return datetime.now(timezone.utc) + timedelta(hours=8)


def bj_date(delta: int = 0) -> str:
    return (bj_now().date() + timedelta(days=delta)).isoformat()


def month_of(date: str) -> str:
    return date[:7]


def days_in_month(month: str) -> int:
    y, m = map(int, month.split("-"))
    if m == 12:
        nxt = datetime(y + 1, 1, 1)
    else:
        nxt = datetime(y, m + 1, 1)
    cur = datetime(y, m, 1)
    return (nxt - cur).days


def round2(n: float) -> float:
    return round(float(n or 0) + 1e-9, 2)


def money(n: float, digits: int = 2) -> str:
    return f"{float(n or 0):,.{digits}f}"


def intfmt(n: float) -> str:
    return f"{int(round(float(n or 0))):,}"


def find_font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for p in candidates:
        if Path(p).exists():
            return ImageFont.truetype(p, size=size)
    # Last resort; may not render CJK well, but keeps script usable.
    return ImageFont.load_default()


FONT_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
FONT_REGULAR_CANDIDATES = [
    str(FONT_DIR / "msyh.ttc"),
    str(FONT_DIR / "simhei.ttf"),
    str(FONT_DIR / "simsun.ttc"),
    str(FONT_DIR / "arial.ttf"),
]
FONT_BOLD_CANDIDATES = [
    str(FONT_DIR / "msyhbd.ttc"),
    str(FONT_DIR / "simhei.ttf"),
    str(FONT_DIR / "arialbd.ttf"),
    str(FONT_DIR / "msyh.ttc"),
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return find_font(FONT_BOLD_CANDIDATES if bold else FONT_REGULAR_CANDIDATES, size)


@dataclass
class StoreDay:
    key: str
    sales: float
    orders: int
    qty: int
    missing: bool = False


def load_stores(group: str) -> list[dict[str, Any]]:
    cfg = load_json(ROOT / "config" / "stores.json", {})
    keys = cfg.get("groups", {}).get(group, [])
    stores = cfg.get("stores", [])
    by_key = {s.get("storeKey"): s for s in stores}
    return [by_key[k] for k in keys if k in by_key]


def load_store_day(store: dict[str, Any], date: str) -> StoreDay:
    obj = load_json(ROOT / "outputs" / "shein_fetch" / store["storeKey"] / f"{date}.json", None)
    summary = (obj or {}).get("summary") or {}
    sales = round2(summary.get("salesSar", 0))
    return StoreDay(
        key=store["storeKey"],
        sales=sales,
        orders=int(summary.get("positiveAmountOrderCount", 0) or 0),
        qty=int(summary.get("quantityPositiveAmount", 0) or 0),
        missing=obj is None,
    )


def load_group_day(stores: list[dict[str, Any]], date: str) -> dict[str, Any]:
    rows = [load_store_day(s, date) for s in stores]
    return {
        "date": date,
        "rows": rows,
        "sales": round2(sum(r.sales for r in rows)),
        "orders": sum(r.orders for r in rows),
        "qty": sum(r.qty for r in rows),
    }


def load_month_trend(stores: list[dict[str, Any]], month: str) -> list[dict[str, Any]]:
    today = bj_date()
    last = int(today[-2:]) if month == month_of(today) else days_in_month(month)
    out = []
    for d in range(1, last + 1):
        out.append(load_group_day(stores, f"{month}-{d:02d}"))
    return out


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


def gradient(size: tuple[int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size)
    pix = img.load()
    for y in range(h):
        for x in range(w):
            nx = x / max(1, w - 1)
            ny = y / max(1, h - 1)
            v = (nx * 0.55 + ny * 0.45)
            r = lerp(8, 22, v)
            g = lerp(12, 20, v)
            b = lerp(30, 56, v)
            # subtle cyan/purple radial glow
            d1 = math.hypot(nx - 0.18, ny - 0.12)
            d2 = math.hypot(nx - 0.82, ny - 0.2)
            cyan = max(0, 1 - d1 * 2.2)
            purple = max(0, 1 - d2 * 2.1)
            r = min(255, r + int(purple * 42))
            g = min(255, g + int(cyan * 38))
            b = min(255, b + int(cyan * 55 + purple * 38))
            pix[x, y] = (r, g, b)
    return img


def rounded_rect(draw: ImageDraw.ImageDraw, xy, radius: int, fill, outline=None, width: int = 1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def glow_line(base: Image.Image, points: list[tuple[float, float]], color=(0, 230, 255), width=4):
    if len(points) < 2:
        return
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for w, alpha in [(18, 38), (10, 58), (6, 90)]:
        d.line(points, fill=(*color, alpha), width=w, joint="curve")
    d.line(points, fill=(*color, 245), width=width, joint="curve")
    base.alpha_composite(layer)


def draw_text(draw: ImageDraw.ImageDraw, xy, text: str, fnt, fill=(238, 245, 255), anchor=None):
    draw.text(xy, text, font=fnt, fill=fill, anchor=anchor)


def text_size(draw: ImageDraw.ImageDraw, text: str, fnt) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=fnt)
    return box[2] - box[0], box[3] - box[1]


def draw_card(img: Image.Image, xy, title: str, value: str, sub: str, accent=(0, 229, 255)):
    d = ImageDraw.Draw(img, "RGBA")
    x1, y1, x2, y2 = xy
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow, "RGBA")
    gd.rounded_rectangle(xy, radius=28, fill=(*accent, 30))
    glow = glow.filter(ImageFilter.GaussianBlur(14))
    img.alpha_composite(glow)
    rounded_rect(d, xy, 28, fill=(10, 20, 48, 210), outline=(*accent, 95), width=2)
    d.rounded_rectangle((x1 + 18, y1 + 18, x1 + 28, y2 - 18), radius=5, fill=(*accent, 220))
    draw_text(d, (x1 + 44, y1 + 22), title, font(22), fill=(160, 185, 215))
    draw_text(d, (x1 + 44, y1 + 62), value, font(38, True), fill=(246, 252, 255))
    draw_text(d, (x1 + 44, y2 - 36), sub, font(19), fill=(135, 163, 192))


def draw_panel(img: Image.Image, xy, title: str, accent=(0, 229, 255)):
    d = ImageDraw.Draw(img, "RGBA")
    rounded_rect(d, xy, 28, fill=(8, 17, 42, 205), outline=(*accent, 72), width=1)
    x1, y1, _, _ = xy
    draw_text(d, (x1 + 26, y1 + 18), title, font(28, True), fill=(239, 248, 255))
    d.line((x1 + 26, y1 + 58, x1 + 170, y1 + 58), fill=(*accent, 180), width=3)


def draw_store_bars(img: Image.Image, xy, rows: list[dict[str, Any]]):
    d = ImageDraw.Draw(img, "RGBA")
    x1, y1, x2, y2 = xy
    draw_panel(img, xy, "店铺月度排行", (0, 229, 255))
    rows = rows[:10]
    maxv = max([float(r.get("total") or 0) for r in rows] + [1])
    top = y1 + 84
    row_h = 38
    bar_x = x1 + 112
    bar_w = x2 - bar_x - 116
    for i, r in enumerate(rows):
        y = top + i * row_h
        name = str(r.get("label", ""))
        val = float(r.get("total") or 0)
        pct = val / maxv
        draw_text(d, (x1 + 28, y + 4), f"{i+1:02d}", font(18, True), fill=(90, 236, 255))
        draw_text(d, (x1 + 66, y + 4), name, font(21, True), fill=(235, 245, 255))
        d.rounded_rectangle((bar_x, y + 6, bar_x + bar_w, y + 24), radius=9, fill=(28, 43, 74, 220))
        fill_w = max(4, int(bar_w * pct))
        color = (0, 229, 255) if i < 3 else (78, 133, 255)
        d.rounded_rectangle((bar_x, y + 6, bar_x + fill_w, y + 24), radius=9, fill=(*color, 230))
        draw_text(d, (x2 - 96, y + 1), money(val, 0), font(20, True), fill=(230, 245, 255))


def draw_product_bars(img: Image.Image, xy, rows: list[dict[str, Any]]):
    d = ImageDraw.Draw(img, "RGBA")
    x1, y1, x2, y2 = xy
    draw_panel(img, xy, "本月热卖产品 Top 8", (167, 103, 255))
    rows = rows[:8]
    max_qty = max([float(r.get("totalQty") or 0) for r in rows] + [1])
    top = y1 + 84
    row_h = 46
    bar_x = x1 + 266
    bar_w = x2 - bar_x - 112
    for i, r in enumerate(rows):
        y = top + i * row_h
        name = str(r.get("goodsSn", ""))[:22]
        qty = float(r.get("totalQty") or 0)
        sar = float(r.get("totalSar") or 0)
        pct = qty / max_qty
        draw_text(d, (x1 + 28, y + 2), f"{i+1}", font(21, True), fill=(210, 186, 255))
        draw_text(d, (x1 + 58, y + 1), name, font(20, True), fill=(240, 238, 255))
        draw_text(d, (x1 + 58, y + 25), f"{intfmt(qty)} 件 · {money(sar, 0)} SAR", font(16), fill=(157, 174, 204))
        d.rounded_rectangle((bar_x, y + 13, bar_x + bar_w, y + 30), radius=9, fill=(32, 33, 73, 220))
        fill_w = max(4, int(bar_w * pct))
        d.rounded_rectangle((bar_x, y + 13, bar_x + fill_w, y + 30), radius=9, fill=(167, 103, 255, 230))
        d.ellipse((bar_x + fill_w - 5, y + 8, bar_x + fill_w + 5, y + 35), fill=(236, 221, 255, 235))


def draw_line_chart(img: Image.Image, xy, trend: list[dict[str, Any]]):
    d = ImageDraw.Draw(img, "RGBA")
    x1, y1, x2, y2 = xy
    draw_panel(img, xy, "日销售额趋势", (0, 255, 178))
    plot = (x1 + 52, y1 + 90, x2 - 34, y2 - 56)
    px1, py1, px2, py2 = plot
    values = [float(t["sales"]) for t in trend]
    maxv = max(values + [1])
    # grid
    for i in range(5):
        yy = py1 + (py2 - py1) * i / 4
        d.line((px1, yy, px2, yy), fill=(83, 104, 142, 55), width=1)
        label = money(maxv * (1 - i / 4), 0)
        draw_text(d, (x1 + 22, yy - 10), label, font(14), fill=(110, 136, 170))
    if len(values) >= 2:
        pts = []
        for i, val in enumerate(values):
            x = px1 + (px2 - px1) * i / (len(values) - 1)
            y = py2 - (val / maxv) * (py2 - py1)
            pts.append((x, y))
        # area
        area = pts + [(pts[-1][0], py2), (pts[0][0], py2)]
        d.polygon(area, fill=(0, 255, 178, 36))
        glow_line(img, pts, color=(0, 255, 178), width=4)
        for x, y in pts[-6:]:
            d.ellipse((x - 5, y - 5, x + 5, y + 5), fill=(240, 255, 250, 230))
    # x labels, last 6 dates
    if trend:
        for idx in range(0, len(trend), max(1, len(trend) // 6)):
            x = px1 + (px2 - px1) * idx / max(1, len(trend) - 1)
            draw_text(d, (x - 22, py2 + 16), trend[idx]["date"][5:], font(14), fill=(125, 151, 184))


def draw_history_strip(img: Image.Image, xy, history: list[dict[str, Any]]):
    d = ImageDraw.Draw(img, "RGBA")
    x1, y1, x2, y2 = xy
    draw_panel(img, xy, "历史月销", (255, 184, 77))
    rows = history[-8:]
    maxv = max([float(r.get("storeTotalSar") or 0) for r in rows] + [1])
    left = x1 + 34
    bottom = y2 - 58
    top = y1 + 88
    col_w = (x2 - x1 - 74) / max(1, len(rows))
    for i, r in enumerate(rows):
        v = float(r.get("storeTotalSar") or 0)
        h = (bottom - top) * (v / maxv)
        bx = left + i * col_w + col_w * 0.18
        bw = col_w * 0.58
        d.rounded_rectangle((bx, bottom - h, bx + bw, bottom), radius=10, fill=(255, 184, 77, 215))
        draw_text(d, (bx - 4, bottom + 12), str(r.get("month", ""))[2:], font(14), fill=(169, 181, 204))
        draw_text(d, (bx - 6, bottom - h - 24), money(v / 1000, 0) + "k", font(14, True), fill=(255, 232, 190))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default="DSY")
    ap.add_argument("--month", default=None)
    ap.add_argument("--output", default=None)
    args = ap.parse_args()

    group = args.group.upper()
    month = args.month or month_of(bj_date())
    today = bj_date()
    yesterday = bj_date(-1)

    stores = load_stores(group)
    monthly = load_json(ROOT / "outputs" / "reports" / f"monthly-sales-{month}.json", {})
    product = load_json(ROOT / "outputs" / "reports" / f"product-sales-{month}.json", {})
    validation = load_json(ROOT / "outputs" / "reports" / "history-product-vs-store-validation.json", {})
    today_data = load_group_day(stores, today)
    yesterday_data = load_group_day(stores, yesterday)
    trend = load_month_trend(stores, month)

    store_rows = [
        r for r in monthly.get("rows", [])
        if r.get("group") == group and r.get("type") == "店铺" and r.get("currency") == "SAR"
    ]
    store_rows.sort(key=lambda r: float(r.get("total") or 0), reverse=True)

    W, H = 1920, 1080
    img = gradient((W, H)).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")

    # decorative grid and orbs
    for x in range(0, W, 80):
        d.line((x, 0, x, H), fill=(90, 130, 190, 18), width=1)
    for y in range(0, H, 80):
        d.line((0, y, W, y), fill=(90, 130, 190, 16), width=1)
    for cx, cy, r, col in [
        (310, 120, 160, (0, 229, 255, 35)),
        (1650, 180, 220, (167, 103, 255, 36)),
        (1480, 920, 180, (0, 255, 178, 25)),
    ]:
        orb = Image.new("RGBA", img.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(orb, "RGBA")
        od.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col)
        img.alpha_composite(orb.filter(ImageFilter.GaussianBlur(35)))

    # header
    draw_text(d, (70, 52), f"SHEIN {group} 经营驾驶舱", font(48, True), fill=(248, 252, 255))
    draw_text(
        d,
        (73, 112),
        f"{month} · 北京时间 · 订单创建时间口径 · 生成于 {bj_now().strftime('%Y-%m-%d %H:%M:%S')}",
        font(22),
        fill=(144, 176, 211),
    )
    d.rounded_rectangle((1515, 58, 1848, 104), radius=23, fill=(0, 229, 255, 28), outline=(0, 229, 255, 120), width=1)
    draw_text(d, (1538, 68), "1 SAR = 1.8 RMB · 利润率 25%", font(20, True), fill=(184, 244, 255))

    totals = monthly.get("totals", {})
    card_w, card_h = 332, 142
    cards = [
        ("昨日完整", f"{money(yesterday_data['sales'])} SAR", f"{yesterday} · 订单 {yesterday_data['orders']} · 销量 {yesterday_data['qty']}", (0, 229, 255)),
        ("今日最新", f"{money(today_data['sales'])} SAR", f"{today} · 订单 {today_data['orders']} · 销量 {today_data['qty']}", (0, 255, 178)),
        ("月累计", f"{money(totals.get('totalSar'))} SAR", f"{money(totals.get('totalRmb'))} RMB", (167, 103, 255)),
        ("预测业绩", f"{money(totals.get('predictedSar'))} SAR", f"{money(totals.get('predictedRmb'))} RMB", (255, 184, 77)),
        ("预测利润", f"{money(totals.get('predictedProfitRmb'))} RMB", "按 25% 利润率估算", (255, 91, 134)),
    ]
    gap = 24
    start_x = 70
    y = 166
    for i, c in enumerate(cards):
        x = start_x + i * (card_w + gap)
        draw_card(img, (x, y, x + card_w, y + card_h), *c)

    # panels
    draw_line_chart(
        img,
        (70, 340, 1198, 682),
        [{"date": t["date"], "sales": t["sales"], "orders": t["orders"], "qty": t["qty"]} for t in trend],
    )
    draw_store_bars(img, (1230, 340, 1850, 682), store_rows)
    draw_product_bars(img, (70, 714, 1198, 1018), product.get("topProducts", []))
    draw_history_strip(img, (1230, 714, 1850, 1018), validation.get("rows", []))

    # footer
    draw_text(
        d,
        (70, 1040),
        "数据来源：SHEIN 后台订单明细 → 工作区脚本 → 飞书多维表格事实表 / 产品统计表；Base 原生 Dashboard 暂停使用，避免前端配置失效。",
        font(17),
        fill=(118, 145, 178),
    )

    out = Path(args.output) if args.output else ROOT / "outputs" / "visuals" / f"shein-ops-dashboard-{group}-{month}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out, "PNG", optimize=True)
    meta = {
        "ok": True,
        "group": group,
        "month": month,
        "output": str(out.relative_to(ROOT)).replace("\\", "/"),
        "today": today_data,
        "yesterday": yesterday_data,
        "monthlyTotalSar": totals.get("totalSar"),
        "predictedSar": totals.get("predictedSar"),
        "predictedProfitRmb": totals.get("predictedProfitRmb"),
    }
    print(json.dumps(meta, ensure_ascii=False, indent=2, default=lambda o: o.__dict__))


if __name__ == "__main__":
    main()
