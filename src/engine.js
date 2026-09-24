/**
 * PixPress — client-side image pipeline
 * decode → xoay/lật → cắt → resize → encode → đo chất lượng
 * Designed by Quoc-Phong Dang, M.Sc. (phongdang.io.vn)
 */

import { measureQuality } from './quality.js';
import { exactPixels } from './crop.js';
import { isHeic, decodeHeic } from './heic.js';
import { stripLossless, addGaussianNoise } from './metadata.js';
import { applyRedactions } from './redact.js';
import { whitenBackground } from './ai.js';

export const LIMITS = {
  maxFiles: 30,
  maxFileSize: 50 * 1024 * 1024,
  maxPixels: 80 * 1e6
};

export const FB_MAX_SIDE = 2048;

/**
 * Ảnh visa điện tử Việt Nam (evisa.gov.vn): 4×6 cm, JPG/JPEG, ≤ 2 MB, nhìn thẳng, không mũ, không kính, nền trắng.
 * Cổng không quy định số pixel; 600×900 (≈ 381 dpi) đủ nét cho bước nhận diện khuôn mặt và rất nhẹ.
 */
export const VISA_VN = { w: 600, h: 900, maxBytes: 2 * 1024 * 1024 };

/** Độ lệch chuẩn nhiễu Gauss (thang 0–255) cho chế độ khử watermark AI. */
export const NOISE_SIGMA = { light: 1.5, medium: 3, strong: 5 };

export const FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG', lossy: true },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP', lossy: true },
  avif: { mime: 'image/avif', ext: 'avif', label: 'AVIF', lossy: true },
  png: { mime: 'image/png', ext: 'png', label: 'PNG', lossy: false }
};

/** Kiểm tra trình duyệt có mã hóa được định dạng này qua canvas không (AVIF thường chỉ có trên Safari/Firefox mới). */
export async function detectEncoders() {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const out = {};
  for (const [key, f] of Object.entries(FORMATS)) {
    out[key] = await new Promise(res => c.toBlob(b => res(Boolean(b && b.type === f.mime)), f.mime, 0.8));
  }
  return out;
}

export async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Chrome/Firefox không đọc được HEIC của iPhone → giải mã bằng libheif.
    if (await isHeic(file)) {
      try { return await decodeHeic(file); } catch { /* rơi xuống thông báo chung */ }
    }
    throw new Error('Không giải mã được ảnh (file hỏng hoặc trình duyệt không hỗ trợ định dạng này).');
  }
}

const LABEL_BY_MIME = { 'image/jpeg': ['JPG', 'jpg'], 'image/png': ['PNG', 'png'], 'image/webp': ['WebP', 'webp'] };

/** Chế độ "Chỉ xóa metadata": bỏ khối metadata trên byte, không giải mã/nén lại. Trả null nếu định dạng không hỗ trợ. */
export async function processLossless(file, bitmap) {
  const blob = await stripLossless(file);
  if (!blob) return null;
  const [formatLabel, ext] = LABEL_BY_MIME[blob.type];
  return {
    blob, mime: blob.type, ext, formatLabel,
    w: bitmap.width, h: bitmap.height, origW: bitmap.width, origH: bitmap.height,
    origSize: file.size, newSize: blob.size,
    deltaPct: file.size > 0 ? ((file.size - blob.size) / file.size) * 100 : 0,
    ssim: 1, psnr: Infinity, lossless: true
  };
}

export function formatKeyFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/avif') return 'avif';
  return 'jpeg';
}

/** Vẽ bitmap: xoay (0/90/180/270) trước, rồi lật ngang ảnh đã xoay. */
export function orient(bitmap, rotate = 0, flipH = false) {
  const rot = ((rotate % 360) + 360) % 360;
  const swap = rot % 180 !== 0;
  const w = swap ? bitmap.height : bitmap.width;
  const h = swap ? bitmap.width : bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.translate(w / 2, h / 2);
  if (flipH) ctx.scale(-1, 1);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // người vẽ tiếp (vd. vùng che) dùng tọa độ gốc
  return canvas;
}

/** Tính kích thước đích theo chế độ resize (không bao giờ phóng to trừ chế độ "exact"). */
export function targetSize(w, h, opt) {
  const mode = opt.resizeMode;
  if (mode === 'visa') return { w: VISA_VN.w, h: VISA_VN.h };
  let limit = 0;
  if (mode === 'fb') limit = FB_MAX_SIDE;
  else if (mode === 'max') limit = Math.max(16, opt.maxSide | 0);
  if (limit) {
    const long = Math.max(w, h);
    if (long <= limit) return { w, h };
    const k = limit / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  if (mode === 'exact') {
    let tw = Math.max(1, opt.exactW | 0);
    let th = Math.max(1, opt.exactH | 0);
    if (opt.keepRatio) th = Math.max(1, Math.round((tw * h) / w));
    return { w: tw, h: th };
  }
  if (mode === 'percent') {
    const k = Math.min(100, Math.max(1, opt.percent | 0)) / 100;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  return { w, h };
}

/** Cắt vùng (sx,sy,sw,sh) rồi thu nhỏ từng nấc ×0.5 để tránh răng cưa khi giảm mạnh. */
function cropAndResize(src, sx, sy, sw, sh, tw, th) {
  let cur = src;
  let cx = sx, cy = sy, cw = sw, ch = sh;
  while (cw / 2 >= tw && ch / 2 >= th) {
    const nw = Math.round(cw / 2);
    const nh = Math.round(ch / 2);
    const step = document.createElement('canvas');
    step.width = nw;
    step.height = nh;
    const sctx = step.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    cur = step;
    cx = 0; cy = 0; cw = nw; ch = nh;
  }
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, cx, cy, cw, ch, 0, 0, tw, th);
  return out;
}

/** Dựng canvas tham chiếu (đã xoay, cắt, resize) — chưa nén. */
export function render(bitmap, edit, opt) {
  const oriented = orient(bitmap, edit.rotate, edit.flipH);
  // Nền trắng bằng AI (ảnh visa): mặt nạ người đã tính sẵn cho đúng hướng xoay/lật hiện tại.
  if (opt.whiteBg && edit.bgMask) whitenBackground(oriented, edit.bgMask);
  // Che vùng nhạy cảm trên ảnh đủ độ phân giải, trước khi cắt/thu nhỏ.
  applyRedactions(oriented, edit.redact);
  const crop = edit.crop || { x: 0, y: 0, w: 1, h: 1 };
  let { w: sw, h: sh } = exactPixels(crop, oriented.width, oriented.height);
  let sx = Math.min(oriented.width - sw, Math.max(0, Math.round(crop.x * oriented.width)));
  let sy = Math.min(oriented.height - sh, Math.max(0, Math.round(crop.y * oriented.height)));
  if (opt.resizeMode === 'visa') {
    // Vùng chọn chưa đúng 2:3 → cắt giữa cho đúng tỷ lệ 4×6, không kéo méo khuôn mặt.
    const ratio = VISA_VN.w / VISA_VN.h;
    if (Math.abs(sw / sh - ratio) > 0.005) {
      const nw = Math.min(sw, Math.round(sh * ratio));
      const nh = Math.round(nw / ratio);
      sx += Math.round((sw - nw) / 2);
      sy += Math.round((sh - nh) / 2);
      sw = nw;
      sh = nh;
    }
  }
  const t = targetSize(sw, sh, opt);
  const canvas = cropAndResize(oriented, sx, sy, sw, sh, t.w, t.h);
  return { canvas, cropW: sw, cropH: sh };
}

/**
 * Ước lượng nền có trắng không, xét riêng hai mép bên (nửa trên ảnh, nơi thường là phông)
 * và dải trên cùng (chạm tóc nếu ảnh chụp quá sát). Đạt khi sáng (luma ≥ 225) và gần như không màu (chroma ≤ 18).
 */
export function checkWhiteBackground(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const side = Math.max(1, Math.round(W * 0.07));
  const measure = regions => {
    let luma = 0, chroma = 0, n = 0;
    for (const [x, y, w, h] of regions) {
      const d = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        luma += 0.299 * r + 0.587 * g + 0.114 * b;
        chroma += Math.max(r, g, b) - Math.min(r, g, b);
        n++;
      }
    }
    return luma / n >= 225 && chroma / n <= 18;
  };
  const sides = measure([[0, 0, side, Math.round(H * 0.5)], [W - side, 0, side, Math.round(H * 0.5)]]);
  const top = measure([[0, 0, W, Math.max(1, Math.round(H * 0.04))]]);
  return { ok: sides && top, sides, top };
}

function encode(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Mã hóa ảnh thất bại.'))), mime, mime === 'image/png' ? undefined : quality);
  });
}

/** JPG không có kênh alpha → lót nền trắng để vùng trong suốt không thành màu đen. */
function flatten(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

/**
 * Xử lý trọn gói 1 ảnh.
 * @param {File} file
 * @param {ImageBitmap} bitmap
 * @param {{rotate:number, flipH:boolean, crop:null|{x,y,w,h}}} edit
 * @param {{format:string, quality:number, resizeMode:string, maxSide:number, exactW:number, exactH:number, keepRatio:boolean, percent:number}} opt
 */
export async function processImage(file, bitmap, edit, opt) {
  const fmtKey = opt.format === 'keep' ? formatKeyFromMime(file.type) : opt.format;
  const fmt = FORMATS[fmtKey] || FORMATS.jpeg;

  const { canvas } = render(bitmap, edit, opt);
  const source = fmt.mime === 'image/jpeg' ? flatten(canvas) : canvas;
  // Khử watermark ẩn: thêm nhiễu vào bản sao; chất lượng vẫn đo so với ảnh chưa nhiễu.
  let target = source;
  if (opt.privacy === 'paranoid') {
    target = document.createElement('canvas');
    target.width = source.width;
    target.height = source.height;
    target.getContext('2d').drawImage(source, 0, 0);
    addGaussianNoise(target, NOISE_SIGMA[opt.noise] ?? NOISE_SIGMA.light);
  }
  let blob = await encode(target, fmt.mime, opt.quality);
  let visa = null;
  if (opt.resizeMode === 'visa') {
    // Bảo đảm ≤ 2 MB (thực tế 600×900 chỉ vài trăm KB) và báo các điểm cổng evisa hay từ chối.
    for (let q = opt.quality; blob.size > VISA_VN.maxBytes && q > 0.5 && fmt.lossy; q -= 0.08) blob = await encode(target, fmt.mime, q);
    visa = { background: checkWhiteBackground(source), jpeg: fmt.mime === 'image/jpeg', sizeOk: blob.size <= VISA_VN.maxBytes };
  }

  const quality = fmt.lossy || target !== source ? await measureQuality(source, blob) : { ssim: 1, psnr: Infinity };

  const origSize = file.size;
  const newSize = blob.size;
  return {
    blob,
    mime: fmt.mime,
    ext: fmt.ext,
    formatLabel: fmt.label,
    w: canvas.width,
    h: canvas.height,
    origW: bitmap.width,
    origH: bitmap.height,
    origSize,
    newSize,
    deltaPct: origSize > 0 ? ((origSize - newSize) / origSize) * 100 : 0,
    visa,
    ...quality
  };
}
