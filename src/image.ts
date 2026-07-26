import { nativeImage } from "electron";

// Same budget as prepare_image() in scripts/paddle_table.py: glyph height is
// what drives recognition accuracy, and a screenshot/photo of a printed table
// is often far below it.
const TARGET_LONG_SIDE = 2200;
const MAX_UPSCALE = 3;

// Upscales a small image before it is handed to a VLM.
//
// qwen2.5vl (and other vision models) downsample the image to a fixed patch
// budget, and on a small two-block word table that is enough to lose the
// RIGHTMOST column entirely: the model still declares the column in
// "columns", but every cell comes back "" — so the printed sheet showed an
// empty 3rd column. Feeding it a 2x-3x larger image makes that column
// readable again. The Paddle path does its own upscaling in Python, so it
// must not be run through this as well.
export function upscaleForRecognition(dataUrl: string): string {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return dataUrl;

    const { width, height } = image.getSize();
    const longSide = Math.max(width, height);
    if (longSide <= 0) return dataUrl;

    const scale = Math.min(TARGET_LONG_SIDE / longSide, MAX_UPSCALE);
    if (scale <= 1) return dataUrl;

    const resized = image.resize({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      quality: "best",
    });
    return resized.isEmpty() ? dataUrl : resized.toDataURL();
  } catch {
    // A failed resize should cost accuracy, never the whole run.
    return dataUrl;
  }
}
