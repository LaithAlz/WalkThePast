/**
 * Client-side photo prep before a world is generated (the lessons from Phase 0):
 *  - trim paper borders / mounts so Marble does not build a framed picture in a room
 *  - cap the long side so the upload stays reasonable, re-encode as JPEG
 * Returns the bytes exactly as Marble will see them; they are also saved as the
 * world's provenance source, so the crop box is recorded for later camera mapping.
 */
export type PreppedImage = {
  name: string;
  mime: "image/jpeg";
  dataBase64: string;
  width: number;
  height: number;
  cropBox: [number, number, number, number];
  sourceSize: [number, number];
};

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`could not decode ${file.name}`));
    img.src = url;
  });
}

/** Walk inward from each edge until a row/column shows real variation (std of luminance). */
function detectBorder(img: HTMLImageElement, thresh = 0.10, maxFrac = 0.25, pad = 0.012): [number, number, number, number] {
  const W = 320;
  const H = Math.max(1, Math.round((W * img.naturalHeight) / img.naturalWidth));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  const rowStd = (y: number) => {
    let s = 0, s2 = 0;
    for (let x = 0; x < W; x++) { const v = lum[y * W + x]; s += v; s2 += v * v; }
    const m = s / W;
    return Math.sqrt(Math.max(0, s2 / W - m * m));
  };
  const colStd = (x: number) => {
    let s = 0, s2 = 0;
    for (let y = 0; y < H; y++) { const v = lum[y * W + x]; s += v; s2 += v * v; }
    const m = s / H;
    return Math.sqrt(Math.max(0, s2 / H - m * m));
  };
  let top = 0, bottom = H, left = 0, right = W;
  for (let y = 0; y < H * maxFrac; y++) if (rowStd(y) > thresh) { top = y; break; }
  for (let y = H - 1; y > H * (1 - maxFrac); y--) if (rowStd(y) > thresh) { bottom = y + 1; break; }
  for (let x = 0; x < W * maxFrac; x++) if (colStd(x) > thresh) { left = x; break; }
  for (let x = W - 1; x > W * (1 - maxFrac); x--) if (colStd(x) > thresh) { right = x + 1; break; }
  const sx = img.naturalWidth / W, sy = img.naturalHeight / H;
  const px = Math.round((right - left) * sx * pad), py = Math.round((bottom - top) * sy * pad);
  return [Math.round(left * sx) + px, Math.round(top * sy) + py, Math.round(right * sx) - px, Math.round(bottom * sy) - py];
}

export async function prepPhoto(file: File, opts: { trimBorder?: boolean; maxSide?: number; quality?: number } = {}): Promise<PreppedImage> {
  const { trimBorder = true, maxSide = 4096, quality = 0.92 } = opts;
  const img = await loadImage(file);
  const sourceSize: [number, number] = [img.naturalWidth, img.naturalHeight];
  const box = trimBorder ? detectBorder(img) : ([0, 0, img.naturalWidth, img.naturalHeight] as [number, number, number, number]);
  let w = box[2] - box[0], h = box[3] - box[1];
  const scale = Math.min(1, maxSide / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(img, box[0], box[1], box[2] - box[0], box[3] - box[1], 0, 0, w, h);
  const dataUrl = c.toDataURL("image/jpeg", quality);
  return { name: file.name.replace(/\.[^.]+$/, "") + ".jpg", mime: "image/jpeg", dataBase64: dataUrl.split(",")[1], width: w, height: h, cropBox: box, sourceSize };
}
