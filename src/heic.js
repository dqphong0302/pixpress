/**
 * Ảnh iPhone (HEIC/HEIF).
 * Safari giải mã HEIC sẵn; Chrome/Firefox thì không → dùng libheif (WASM, qua heic-to).
 * Bộ giải mã ~3 MB nên chỉ tải khi thực sự gặp ảnh HEIC.
 */

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** Nhận diện theo MIME, đuôi file hoặc "ftyp" brand trong 12 byte đầu (iPhone đôi khi gửi MIME rỗng). */
export async function isHeic(file) {
  if (/image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '')) return true;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ftyp = String.fromCharCode(...head.subarray(4, 8));
  const brand = String.fromCharCode(...head.subarray(8, 12));
  return ftyp === 'ftyp' && HEIC_BRANDS.has(brand);
}

let loader = null;

/** Giải mã HEIC thành ImageBitmap (libheif tự áp dụng hướng xoay lưu trong file). */
export async function decodeHeic(file) {
  loader ??= import('heic-to/csp');
  const { heicTo } = await loader;
  return heicTo({ blob: file, type: 'bitmap' });
}
