/**
 * Khung cắt ảnh kéo-thả (chuột, cảm ứng, bàn phím).
 * Tọa độ nội bộ tính theo pixel ảnh; xuất ra dạng tỷ lệ 0..1 để độc lập độ phân giải.
 */

const MIN = 16;

/** Đổi vùng cắt tỷ lệ 0..1 sang pixel thật; nếu có khóa tỷ lệ thì ép đúng tỷ lệ (tránh lệch 1px do làm tròn). */
export function exactPixels(c, realW, realH) {
  let w = Math.max(1, Math.min(realW, Math.round(c.w * realW)));
  let h = Math.max(1, Math.min(realH, Math.round(c.h * realH)));
  if (c.aspect) {
    h = Math.round(w / c.aspect);
    if (h > realH) { h = realH; w = Math.round(h * c.aspect); }
  }
  return { w, h };
}
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function createCropper(host, onChange) {
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'px-crop-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'px-crop-canvas';
  const box = document.createElement('div');
  box.className = 'px-crop-box';
  box.tabIndex = 0;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Vùng cắt — dùng phím mũi tên để di chuyển, Shift để di chuyển nhanh');
  // px-crop-face: khung gợi ý vị trí đầu/mắt cho ảnh thẻ (bật bằng setGuide).
  box.innerHTML = '<span class="px-crop-grid"></span><span class="px-crop-face" hidden><span class="px-crop-face-oval"></span><span class="px-crop-face-eyes"><em>Mắt</em></span><span class="px-crop-face-tip">Đặt mắt trên vạch 2/3, mặt trong khung</span></span><span class="px-crop-size"></span>';
  for (const h of HANDLES) {
    const el = document.createElement('span');
    el.className = `px-crop-handle px-h-${h}`;
    el.dataset.h = h;
    box.appendChild(el);
  }
  wrap.append(canvas, box);
  host.appendChild(wrap);
  const sizeLabel = box.querySelector('.px-crop-size');

  let W = 1, H = 1;
  let realW = 1, realH = 1;
  let ratio = null;
  let r = { x: 0, y: 0, w: 1, h: 1 };
  let drag = null;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Khung hiển thị luôn vừa khít vùng chứa và giữ đúng tỷ lệ ảnh.
  function fit() {
    const cw = host.clientWidth, ch = host.clientHeight;
    if (!cw || !ch) return;
    const k = Math.min(cw / W, ch / H);
    wrap.style.width = `${Math.floor(W * k)}px`;
    wrap.style.height = `${Math.floor(H * k)}px`;
  }
  new ResizeObserver(fit).observe(host);

  function paint() {
    box.style.left = `${(r.x / W) * 100}%`;
    box.style.top = `${(r.y / H) * 100}%`;
    box.style.width = `${(r.w / W) * 100}%`;
    box.style.height = `${(r.h / H) * 100}%`;
    const px = pixelSize();
    sizeLabel.textContent = `${px.w} × ${px.h} px`;
    box.classList.toggle('px-crop-locked', ratio != null);
  }

  function pixelSize() {
    return exactPixels(get(), realW, realH);
  }

  function emit() {
    paint();
    onChange?.(get());
  }

  function fitRatio() {
    if (!ratio) return;
    let w = W, h = W / ratio;
    if (h > H) { h = H; w = H * ratio; }
    r = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  function toImage(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - rect.left) / rect.width) * W, 0, W),
      y: clamp(((e.clientY - rect.top) / rect.height) * H, 0, H)
    };
  }

  function onDown(e) {
    const handle = e.target.closest('.px-crop-handle')?.dataset.h || (e.target.closest('.px-crop-box') ? 'move' : null);
    if (!handle) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    drag = { handle, start: toImage(e), orig: { ...r } };
  }

  function onMove(e) {
    if (!drag) return;
    const p = toImage(e);
    const o = drag.orig;
    const h = drag.handle;

    if (h === 'move') {
      r.x = clamp(o.x + p.x - drag.start.x, 0, W - o.w);
      r.y = clamp(o.y + p.y - drag.start.y, 0, H - o.h);
      return emit();
    }

    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    if (h.includes('w')) x0 = clamp(p.x, 0, x1 - MIN);
    if (h.includes('e')) x1 = clamp(p.x, x0 + MIN, W);
    if (h.includes('n')) y0 = clamp(p.y, 0, y1 - MIN);
    if (h.includes('s')) y1 = clamp(p.y, y0 + MIN, H);

    if (ratio && h.length === 2) {
      // Góc kéo khi khóa tỷ lệ: neo góc đối diện, giữ đúng tỷ lệ và nằm trong ảnh.
      const ax = h.includes('w') ? o.x + o.w : o.x;
      const ay = h.includes('n') ? o.y + o.h : o.y;
      const maxW = h.includes('w') ? ax : W - ax;
      const maxH = h.includes('n') ? ay : H - ay;
      let w = x1 - x0, hh = y1 - y0;
      if (w / hh > ratio) w = hh * ratio; else hh = w / ratio;
      if (w > maxW) { w = maxW; hh = w / ratio; }
      if (hh > maxH) { hh = maxH; w = hh * ratio; }
      x0 = h.includes('w') ? ax - w : ax;
      y0 = h.includes('n') ? ay - hh : ay;
      x1 = x0 + w;
      y1 = y0 + hh;
    }
    r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    emit();
  }

  function onUp() { drag = null; }

  function onKey(e) {
    const step = (e.shiftKey ? 0.1 : 0.01) * Math.max(W, H);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    r.x = clamp(r.x + d[0], 0, W - r.w);
    r.y = clamp(r.y + d[1], 0, H - r.h);
    emit();
  }

  box.addEventListener('pointerdown', onDown);
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', onUp);
  box.addEventListener('pointercancel', onUp);
  box.addEventListener('keydown', onKey);

  function get() {
    const c = { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H };
    if (ratio) c.aspect = ratio;
    return c;
  }

  return {
    /**
     * @param {HTMLCanvasElement} source bản xem trước (đã xoay/lật, có thể đã thu nhỏ)
     * @param {{x,y,w,h}|null} crop tỷ lệ 0..1
     * @param {number} realWidth, realHeight kích thước thật của ảnh để hiển thị vùng cắt đúng pixel
     */
    load(source, crop, aspect = null, realWidth = source.width, realHeight = source.height) {
      realW = realWidth;
      realH = realHeight;
      W = source.width;
      H = source.height;
      canvas.width = W;
      canvas.height = H;
      canvas.getContext('2d').drawImage(source, 0, 0);
      fit();
      ratio = aspect;
      r = crop ? { x: crop.x * W, y: crop.y * H, w: crop.w * W, h: crop.h * H } : { x: 0, y: 0, w: W, h: H };
      if (!crop && ratio) fitRatio();
      emit();
    },
    setAspect(a) {
      ratio = a;
      if (ratio) fitRatio();
      else r = { x: 0, y: 0, w: W, h: H };
      emit();
      box.focus({ preventScroll: true });
    },
    reset() {
      ratio = null;
      r = { x: 0, y: 0, w: W, h: H };
      emit();
    },
    get,
    setGuide(on) {
      // Giữ lưới 3×3: vạch trên của lưới chính là vạch 2/3 (tính từ đáy) dành cho mắt.
      box.querySelector('.px-crop-face').hidden = !on;
    },
    get isFull() { return r.x < 1 && r.y < 1 && r.w > W - 1 && r.h > H - 1; },
    get pixelSize() { return pixelSize(); }
  };
}
