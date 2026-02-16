#!/usr/bin/env python3
"""
generate_icons.py — Gera ícones PNG para a extensão usando Pillow.
Uso: python generate_icons.py
Saída: icons/icon16.png, icons/icon48.png, icons/icon128.png
"""

import os

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Pillow não encontrado. Gerando ícones simples com bytes puros...")
    # Fallback: create minimal valid PNGs without Pillow
    import struct, zlib

    def create_simple_png(size, filepath):
        """Create a minimal green square PNG."""
        # RGBA pixels: green background
        raw = b''
        for y in range(size):
            raw += b'\x00'  # filter byte
            for x in range(size):
                # Rounded corners effect
                cx, cy = size // 2, size // 2
                r = size * 0.42
                dx, dy = abs(x - cx), abs(y - cy)
                corner_r = size * 0.2
                in_rect = dx <= r and dy <= r

                if in_rect:
                    # Check corners
                    if dx > r - corner_r and dy > r - corner_r:
                        cdx = dx - (r - corner_r)
                        cdy = dy - (r - corner_r)
                        if (cdx**2 + cdy**2) > corner_r**2:
                            raw += b'\x00\x00\x00\x00'
                            continue

                    # Inner document icon area
                    doc_margin = size * 0.22
                    if dx < r - doc_margin and dy < r - doc_margin:
                        # White document
                        raw += b'\xff\xff\xff\xdd'
                    else:
                        # Green background
                        raw += b'\x10\xb9\x81\xff'
                else:
                    raw += b'\x00\x00\x00\x00'

        def make_chunk(chunk_type, data):
            c = chunk_type + data
            crc = zlib.crc32(c) & 0xffffffff
            return struct.pack('>I', len(data)) + c + struct.pack('>I', crc)

        ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
        compressed = zlib.compress(raw)

        png = b'\x89PNG\r\n\x1a\n'
        png += make_chunk(b'IHDR', ihdr)
        png += make_chunk(b'IDAT', compressed)
        png += make_chunk(b'IEND', b'')

        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'wb') as f:
            f.write(png)
        print(f"  [OK] {filepath} ({size}x{size})")

    for s in [16, 48, 128]:
        create_simple_png(s, f'icons/icon{s}.png')

    print("\nÍcones gerados com sucesso!")
    exit(0)

# ─── Pillow version (higher quality) ──────────────────────────────

def generate_icon(size, filepath):
    """Generate a high-quality icon with Pillow."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded rectangle background
    margin = 0
    radius = int(size * 0.22)
    bg_color = (16, 185, 129, 255)  # #10b981
    draw.rounded_rectangle(
        [margin, margin, size - 1 - margin, size - 1 - margin],
        radius=radius,
        fill=bg_color,
    )

    # Document icon (white)
    doc_margin = int(size * 0.2)
    doc_w = int(size * 0.45)
    doc_h = int(size * 0.55)
    doc_x = (size - doc_w) // 2
    doc_y = int(size * 0.15)
    fold = int(size * 0.12)

    # Document body
    doc_points = [
        (doc_x, doc_y),
        (doc_x + doc_w - fold, doc_y),
        (doc_x + doc_w, doc_y + fold),
        (doc_x + doc_w, doc_y + doc_h),
        (doc_x, doc_y + doc_h),
    ]
    draw.polygon(doc_points, fill=(255, 255, 255, 230))

    # Fold triangle
    fold_points = [
        (doc_x + doc_w - fold, doc_y),
        (doc_x + doc_w, doc_y + fold),
        (doc_x + doc_w - fold, doc_y + fold),
    ]
    draw.polygon(fold_points, fill=(200, 200, 200, 200))

    # Down arrow
    arrow_cx = size // 2
    arrow_top = int(doc_y + doc_h * 0.3)
    arrow_bot = int(doc_y + doc_h * 0.7)
    arrow_w = int(size * 0.08)
    arrow_head = int(size * 0.14)

    line_w = max(1, size // 16)
    draw.line([(arrow_cx, arrow_top), (arrow_cx, arrow_bot)], fill=bg_color, width=line_w)
    # Arrowhead
    draw.polygon([
        (arrow_cx, arrow_bot + max(1, size // 20)),
        (arrow_cx - arrow_head // 2, arrow_bot - max(1, size // 20)),
        (arrow_cx + arrow_head // 2, arrow_bot - max(1, size // 20)),
    ], fill=bg_color)

    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    img.save(filepath, 'PNG')
    print(f"  [OK] {filepath} ({size}x{size})")

for s in [16, 48, 128]:
    generate_icon(s, f'icons/icon{s}.png')

print("\nÍcones gerados com sucesso!")
