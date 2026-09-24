/**
 * PixPress — metadata & dấu vết AI (hợp nhất từ ClearShot)
 *  - inspectMetadata(file): liệt kê EXIF, GPS, thiết bị, C2PA, prompt AI… trong ảnh gốc
 *  - stripLossless(file): xóa metadata trực tiếp trên byte, không giải mã/nén lại (JPEG, PNG, WebP)
 *  - addGaussianNoise(ctx): nhiễu Gauss nhẹ để phá watermark ẩn (SynthID…) khi vẽ lại
 * Ảnh đi qua canvas (mọi chế độ trừ lossless) vốn đã mất toàn bộ metadata.
 */
import exifr from 'exifr';

/* ---------------- Phát hiện ---------------- */

const AI_TEXT_KEYS = {
  parameters: 'Tham số Stable Diffusion (A1111/WebUI)',
  prompt: 'Prompt / node graph ComfyUI',
  workflow: 'Workflow ComfyUI',
  invokeai_metadata: 'Metadata InvokeAI',
  invokeai_graph: 'Graph InvokeAI',
  'sd-metadata': 'Metadata Stable Diffusion',
  dream: 'Chuỗi dream InvokeAI'
};

/** Nhóm hiển thị: ai (dấu vết AI) · location · device · other */
function tagsToFindings(tags) {
  const f = [];
  if (tags.latitude !== undefined || tags.GPSLatitude !== undefined) {
    const lat = Number(tags.latitude ?? tags.GPSLatitude);
    const lon = Number(tags.longitude ?? tags.GPSLongitude);
    f.push({ group: 'location', label: 'Tọa độ GPS', detail: Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` : 'Có' });
  }
  if (tags.Make || tags.Model) f.push({ group: 'device', label: 'Thiết bị chụp', detail: [tags.Make, tags.Model].filter(Boolean).join(' ') });
  if (tags.LensModel) f.push({ group: 'device', label: 'Ống kính', detail: String(tags.LensModel) });
  if (tags.BodySerialNumber || tags.LensSerialNumber || tags.SerialNumber) f.push({ group: 'device', label: 'Số serial thiết bị' });
  if (tags.DateTimeOriginal || tags.CreateDate) {
    const d = tags.DateTimeOriginal || tags.CreateDate;
    f.push({ group: 'other', label: 'Thời điểm chụp', detail: d instanceof Date ? d.toLocaleString('vi-VN') : String(d) });
  }
  if (tags.Software) f.push({ group: 'other', label: 'Phần mềm', detail: String(tags.Software).slice(0, 60) });
  if (tags.DigitalSourceType) {
    const v = String(tags.DigitalSourceType);
    f.push({ group: /trainedAlgorithmicMedia|composite/i.test(v) ? 'ai' : 'other', label: 'Nhãn IPTC DigitalSourceType', detail: v.split('/').pop() });
  }
  const desc = tags.ImageDescription || tags.Description;
  if (desc) {
    const text = String(desc);
    if (/--ar |--v \d|--stylize|midjourney/i.test(text)) f.push({ group: 'ai', label: 'Prompt Midjourney', detail: text.slice(0, 80) });
    else f.push({ group: 'other', label: 'Mô tả ảnh', detail: text.slice(0, 60) });
  }
  if (tags.UserComment) f.push({ group: 'other', label: 'Chú thích ẩn (UserComment)' });
  for (const [key, label] of Object.entries(AI_TEXT_KEYS)) {
    if (tags[key] !== undefined) f.push({ group: 'ai', label, detail: typeof tags[key] === 'string' ? tags[key].slice(0, 80) : undefined });
  }
  return f;
}

const ascii = (u8, start, len) => String.fromCharCode(...u8.subarray(start, Math.min(start + len, u8.length)));
const decodeText = (u8, start, end) => new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(start, end));

function scanJpeg(u8, view) {
  const f = [];
  let o = 2;
  while (o + 4 <= u8.length && u8[o] === 0xff) {
    const m = u8[o + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    if (m === 0xda || m === 0xd9) break;
    const len = view.getUint16(o + 2);
    if (m === 0xeb) f.push({ group: 'ai', label: 'C2PA / Content Credentials', detail: 'Khai báo nguồn gốc (OpenAI, Adobe, Google…)' });
    else if (m === 0xfe && /stable diffusion|midjourney|comfyui|dall-?e|novelai|c2pa/i.test(decodeText(u8, o + 4, o + 2 + len))) {
      f.push({ group: 'ai', label: 'Chữ ký AI trong comment JPEG' });
    }
    o += 2 + len;
  }
  return f;
}

function scanPng(u8, view) {
  const f = [];
  let o = 8;
  while (o + 8 <= u8.length) {
    const len = view.getUint32(o);
    const type = ascii(u8, o + 4, 4);
    if (type === 'caBX') f.push({ group: 'ai', label: 'C2PA / Content Credentials', detail: 'Khai báo nguồn gốc (OpenAI, Adobe, Google…)' });
    else if (/^[tiz]TXt$|^tEXt$/.test(type)) {
      const text = decodeText(u8, o + 8, Math.min(o + 8 + len, o + 208));
      if (/prompt|workflow|parameters|midjourney|dall-?e|c2pa/i.test(text)) f.push({ group: 'ai', label: `Dấu vết AI trong PNG (${type})`, detail: text.slice(0, 80) });
    }
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return f;
}

function scanWebp(u8) {
  const f = [];
  if (ascii(u8, 0, 4) !== 'RIFF' || ascii(u8, 8, 4) !== 'WEBP') return f;
  let o = 12;
  while (o + 8 <= u8.length) {
    const type = ascii(u8, o, 4).trim().toUpperCase();
    const size = (u8[o + 4] | (u8[o + 5] << 8) | (u8[o + 6] << 16) | (u8[o + 7] * 16777216)) >>> 0;
    if (type === 'XMP' && /c2pa|openai|dall|midjourney|trainedalgorithmicmedia/i.test(decodeText(u8, o + 8, Math.min(o + 8 + size, o + 400)))) {
      f.push({ group: 'ai', label: 'Nguồn gốc AI trong XMP' });
    }
    o += 8 + size + (size & 1);
  }
  return f;
}

export async function inspectMetadata(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);
  const findings = [];
  let orientation = 1;
  try {
    const tags = await exifr.parse(buf, true); // đọc mọi khối (EXIF, GPS, XMP, IPTC, text PNG) như ClearShot
    if (tags) {
      findings.push(...tagsToFindings(tags));
      orientation = Number(tags.Orientation) || (typeof tags.Orientation === 'string' && !/horizontal \(normal\)/i.test(tags.Orientation) ? 0 : 1);
    }
  } catch { /* không có metadata đọc được */ }
  if (u8[0] === 0xff && u8[1] === 0xd8) findings.push(...scanJpeg(u8, view));
  else if (u8[0] === 0x89 && u8[1] === 0x50) {
    // exifr đã đọc được prompt từ text chunk thì không cần báo lại lần nữa.
    if (!findings.some(x => x.group === 'ai')) findings.push(...scanPng(u8, view));
  }
  else findings.push(...scanWebp(u8));
  // Gộp trùng nhãn (vd. C2PA thấy qua cả XMP và APP11)
  const seen = new Set();
  // orientation ≠ 1: ảnh dựa vào thẻ EXIF để xoay — xóa byte sẽ làm ảnh nằm sai hướng.
  const clean = t => t && t.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return {
    findings: findings.filter(x => (seen.has(x.label) ? false : seen.add(x.label))).map(x => ({ ...x, detail: clean(x.detail) })),
    orientation
  };
}

/* ---------------- Xóa không nén lại ---------------- */

// Giữ iCCP (hồ sơ màu, vd. Display P3) — không chứa thông tin riêng tư, bỏ đi sẽ làm lệch màu.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs', 'sBIT', 'hIST', 'sPLT', 'acTL', 'fcTL', 'fdAT']);

function concat(parts, head) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, head.length));
  out.set(head, 0);
  let p = head.length;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

function stripJpeg(u8) {
  const keep = [];
  let o = 2;
  while (o + 4 <= u8.length && u8[o] === 0xff) {
    const m = u8[o + 1];
    if (m === 0xd9) break;
    if (m === 0xda) { keep.push(u8.subarray(o)); break; }
    if (m >= 0xd0 && m <= 0xd7) { keep.push(u8.subarray(o, o + 2)); o += 2; continue; }
    const len = (u8[o + 2] << 8) | u8[o + 3];
    const end = o + 2 + len;
    if (len < 2 || end > u8.length) throw new Error('JPEG hỏng');
    // Bỏ APP1 và APP3–APP15 (EXIF, XMP, C2PA, IPTC…) cùng COM; giữ APP0 (JFIF), APP2 (ICC) và mọi segment ảnh.
    const isIcc = m === 0xe2 && ascii(u8, o + 4, 11) === 'ICC_PROFILE';
    if (!(((m >= 0xe1 && m <= 0xef) && !isIcc) || m === 0xfe)) keep.push(u8.subarray(o, end));
    o = end;
  }
  return new Blob([concat(keep, u8.subarray(0, 2))], { type: 'image/jpeg' });
}

function stripPng(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const keep = [];
  let o = 8;
  while (o + 8 <= u8.length) {
    const len = view.getUint32(o);
    const type = ascii(u8, o + 4, 4);
    if (o + 12 + len > u8.length) throw new Error('PNG hỏng');
    if (PNG_KEEP.has(type)) keep.push(u8.subarray(o, o + 12 + len));
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return new Blob([concat(keep, u8.subarray(0, 8))], { type: 'image/png' });
}

function stripWebp(u8) {
  const keep = [];
  let o = 12;
  while (o + 8 <= u8.length) {
    const type = ascii(u8, o, 4);
    const size = (u8[o + 4] | (u8[o + 5] << 8) | (u8[o + 6] << 16) | (u8[o + 7] * 16777216)) >>> 0;
    const end = o + 8 + size + (size & 1);
    if (end > u8.length) throw new Error('WebP hỏng');
    const upper = type.trim().toUpperCase();
    if (upper !== 'EXIF' && upper !== 'XMP') {
      let chunk = u8.subarray(o, end);
      if (type === 'VP8X') { chunk = chunk.slice(); chunk[8] &= ~(0x08 | 0x04); } // tắt cờ EXIF/XMP
      keep.push(chunk);
    }
    o = end;
  }
  const body = concat(keep, new Uint8Array(0));
  const out = new Uint8Array(12 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set(body, 12);
  return new Blob([out], { type: 'image/webp' });
}

/** Trả về Blob đã xóa metadata, hoặc null nếu định dạng không hỗ trợ (vd. HEIC, AVIF, GIF). */
export async function stripLossless(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  if (u8[0] === 0xff && u8[1] === 0xd8) return stripJpeg(u8);
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return stripPng(u8);
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return stripWebp(u8);
  return null;
}

/* ---------------- Khử watermark ẩn ---------------- */

/** Nhiễu Gauss (Box–Muller) σ≈1.5 trên kênh RGB — mắt thường không thấy, đủ phá watermark ẩn dạng tần số. */
export function addGaussianNoise(canvas, sigma = 1.5) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const u1 = Math.random() || 1e-6;
      const z = sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
      d[i + c] = Math.min(255, Math.max(0, Math.round(d[i + c] + z)));
    }
  }
  ctx.putImageData(img, 0, 0);
}
