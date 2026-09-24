/**
 * Đo độ trung thực sau nén: so ảnh đã nén với ảnh tham chiếu (cùng kích thước, chưa nén).
 * - PSNR (dB) trên kênh RGB
 * - SSIM trên độ sáng (luma), cửa sổ 8×8 không chồng lấp — đủ nhanh để chạy trên trình duyệt
 */

const MAX_PIXELS = 4e6;

function pixels(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function luma(data, n) {
  const y = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) y[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return y;
}

function psnr(a, b) {
  let sum = 0, count = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = a[i] - b[i], dg = a[i + 1] - b[i + 1], db = a[i + 2] - b[i + 2];
    sum += dr * dr + dg * dg + db * db;
    count += 3;
  }
  const mse = sum / count;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

function ssim(ya, yb, w, h) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const B = 8;
  let total = 0, blocks = 0;
  for (let by = 0; by + B <= h; by += B) {
    for (let bx = 0; bx + B <= w; bx += B) {
      let ma = 0, mb = 0;
      for (let y = 0; y < B; y++) {
        const row = (by + y) * w + bx;
        for (let x = 0; x < B; x++) { ma += ya[row + x]; mb += yb[row + x]; }
      }
      const n = B * B;
      ma /= n; mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let y = 0; y < B; y++) {
        const row = (by + y) * w + bx;
        for (let x = 0; x < B; x++) {
          const da = ya[row + x] - ma, db = yb[row + x] - mb;
          va += da * da; vb += db * db; cov += da * db;
        }
      }
      va /= n - 1; vb /= n - 1; cov /= n - 1;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      blocks++;
    }
  }
  return blocks ? total / blocks : 1;
}

export async function measureQuality(referenceCanvas, blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return { ssim: null, psnr: null };
  }
  let w = referenceCanvas.width, h = referenceCanvas.height;
  if (w * h > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.max(8, Math.round(w * k));
    h = Math.max(8, Math.round(h * k));
  }
  const a = pixels(referenceCanvas, w, h);
  const b = pixels(bmp, w, h);
  bmp.close();
  const n = w * h;
  return { psnr: psnr(a, b), ssim: ssim(luma(a, n), luma(b, n), w, h) };
}

/** Nhãn dễ hiểu cho người dùng, dựa trên SSIM. */
export function qualityGrade(ssim) {
  if (ssim == null) return { label: 'Không đo được', tone: 'muted', score: null };
  const score = Math.round(Math.max(0, Math.min(1, ssim)) * 1000) / 10;
  if (ssim >= 0.985) return { label: 'Gần như nguyên bản', tone: 'success', score };
  if (ssim >= 0.96) return { label: 'Rất tốt', tone: 'success', score };
  if (ssim >= 0.92) return { label: 'Tốt', tone: 'primary', score };
  if (ssim >= 0.85) return { label: 'Khá — có thể thấy vỡ nhẹ', tone: 'warning', score };
  return { label: 'Giảm rõ — nên tăng chất lượng', tone: 'danger', score };
}
