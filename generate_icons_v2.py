from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size):
    # Create a new image with a transparent background
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Draw a rounded rectangle (background)
    bg_color = (16, 185, 129, 255) # Emerald green
    d.rounded_rectangle([(0, 0), (size, size)], radius=size//4, fill=bg_color)

    # Draw a stylized "TeX" or document symbol
    # For simplicity, let's draw a white document shape
    doc_margin = size // 4
    doc_w = size - (doc_margin * 2)
    doc_h = size - (doc_margin * 2)
    
    d.rectangle(
        [(doc_margin, doc_margin), (doc_margin + doc_w, doc_margin + doc_h)],
        fill="white"
    )

    # Add some "text" lines
    line_h = size // 12
    line_gap = size // 10
    start_y = doc_margin + (doc_h // 3)
    
    for i in range(3):
        y = start_y + (i * line_gap)
        d.line(
            [(doc_margin + (doc_w//4), y), (doc_margin + (doc_w * 0.75), y)],
            fill=bg_color,
            width=line_h
        )

    # Save
    if not os.path.exists("extension/icons"):
        os.makedirs("extension/icons")
    img.save(f"extension/icons/icon{size}.png")
    print(f"Generated icon{size}.png")

if __name__ == "__main__":
    sizes = [16, 48, 128]
    for s in sizes:
        create_icon(s)
