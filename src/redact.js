/**
 * Che vùng nhạy cảm: người dùng vẽ hình chữ nhật, elip hoặc tô bằng cọ; mỗi vùng mang một hiệu ứng
 * (làm mờ · pixel · tô đen). Tọa độ lưu dạng tỷ lệ 0..1 trên ảnh đã xoay/lật, nên áp được ở mọi độ phân giải.
 *
 * shape = { kind: 'rect'|'ellipse', effect, x, y, w, h }
 *       | { kind: 'brush', effect, size, pts: [[x, y], …] }   // size: tỷ lệ theo cạnh dài
 */

export const EFFECTS = ['blur', 'pixel', 'black'];

/* ---------------- Hiệu ứng ---------------- */

/** Thu nhỏ rồi phóng lại: nhanh, chạy được trên mọi trình duyệt (không cần ctx.filter). */
function scaled(src, factor, smooth) {
  const w = Math.max(1, Math.round(src.width / factor));
  const h = Math.max(1, Math.round(src.height / factor));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const s = small.getContext('2d');
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'high';
  s.drawImage(src, 0, 0, w, h);
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = smooth;
  o.imageSmoothingQuality = 'high';
  o.drawImage(small, 0, 0, src.width, src.height);
  return out;
}

function effectLayer(src, effect) {
  const long = Math.max(src.width, src.height);
  if (effect === 'pixel') return scaled(src, Math.max(6, long / 70), false);
  if (effect === 'black') {
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }
  // Làm mờ mạnh: 2 lần thu nhỏ/phóng để mịn, đủ che chữ và khuôn mặt.
  return scaled(scaled(src, Math.max(8, long / 90), true), Math.max(4, long / 200), true);
}

function tracePath(ctx, shape, W, H) {
  ctx.beginPath();
  if (shape.kind === 'rect') ctx.rect(shape.x * W, shape.y * H, shape.w * W, shape.h * H);
  else if (shape.kind === 'ellipse') {
    ctx.ellipse((shape.x + shape.w / 2) * W, (shape.y + shape.h / 2) * H, Math.abs(shape.w * W) / 2, Math.abs(shape.h * H) / 2, 0, 0, Math.PI * 2);
  }
}

function drawMask(ctx, shape, W, H) {
  if (shape.kind === 'brush') {
    const pts = shape.pts;
    if (!pts.length) return;
    ctx.lineWidth = shape.size * Math.max(W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
    for (const [x, y] of pts.length === 1 ? [pts[0], pts[0]] : pts.slice(1)) ctx.lineTo(x * W, y * H);
    ctx.stroke();
  } else {
    tracePath(ctx, shape, W, H);
    ctx.fill();
  }
}

/**
 * Áp các vùng che lên canvas (sửa tại chỗ).
 * @param {HTMLCanvasElement} canvas
 * @param {Array} shapes
 * @param {Map} [cache] tái dùng lớp hiệu ứng khi vẽ lại liên tục (chế độ chỉnh sửa)
 * @param {HTMLCanvasElement} [base] ảnh gốc để tạo lớp hiệu ứng (mặc định chính canvas)
 */
export function applyRedactions(canvas, shapes, cache, base = canvas) {
  if (!shapes?.length) return canvas;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const effect of EFFECTS) {
    const list = shapes.filter(s => s.effect === effect);
    if (!list.length) continue;
    let layer = cache?.get(effect);
    if (!layer) { layer = effectLayer(base, effect); cache?.set(effect, layer); }
    const mask = document.createElement('canvas');
    mask.width = W;
    mask.height = H;
    const m = mask.getContext('2d');
    m.fillStyle = m.strokeStyle = '#000';
    for (const s of list) drawMask(m, s, W, H);
    m.globalCompositeOperation = 'source-in';
    m.drawImage(layer, 0, 0, W, H);
    ctx.drawImage(mask, 0, 0);
  }
  ctx.restore();
  return canvas;
}

/* ---------------- Biến đổi theo xoay/lật ---------------- */

/** Xoay 90° (cw) hoặc lật ngang toàn bộ vùng che để khớp với ảnh sau khi xoay/lật. */
export function transformShapes(shapes, op) {
  const p = ([x, y]) => (op === 'cw' ? [1 - y, x] : op === 'ccw' ? [y, 1 - x] : [1 - x, y]);
  return (shapes || []).map(s => {
    if (s.kind === 'brush') return { ...s, pts: s.pts.map(p) };
    if (op === 'flip') return { ...s, x: 1 - s.x - s.w };
    return op === 'cw'
      ? { ...s, x: 1 - (s.y + s.h), y: s.x, w: s.h, h: s.w }
      : { ...s, x: s.y, y: 1 - (s.x + s.w), w: s.h, h: s.w };
  });
}

/* ---------------- Trình chỉnh sửa ---------------- */

/**
 * Lớp vẽ vùng che trên bản xem trước.
 * @param {HTMLElement} host
 * @param {() => {tool: string, effect: string, brush: number}} getTool
 */
export function createRedactor(host, getTool) {
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'px-redact-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'px-redact-canvas';
  canvas.setAttribute('aria-label', 'Vẽ vùng cần che: kéo để tạo hình, hoặc tô bằng cọ');
  wrap.append(canvas);
  host.append(wrap);
  const ctx = canvas.getContext('2d');

  let base = null;
  let shapes = [];
  let draft = null;
  const cache = new Map();

  function fit() {
    if (!base) return;
    const k = Math.min(host.clientWidth / base.width, host.clientHeight / base.height);
    if (!Number.isFinite(k) || k <= 0) return;
    wrap.style.width = `${Math.floor(base.width * k)}px`;
    wrap.style.height = `${Math.floor(base.height * k)}px`;
  }
  new ResizeObserver(fit).observe(host);

  function paint() {
    if (!base) return;
    ctx.drawImage(base, 0, 0);
    const all = draft ? [...shapes, draft] : shapes;
    applyRedactions(canvas, all, cache, base);
    // Viền mảnh cho mỗi vùng để người dùng thấy rõ đã che những đâu.
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = Math.max(1.5, canvas.width / 600);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    for (const s of all) {
      if (s.kind === 'brush') continue;
      tracePath(ctx, s, canvas.width, canvas.height);
      ctx.stroke();
    }
    ctx.restore();
  }

  const point = e => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  canvas.addEventListener('pointerdown', e => {
    if (!base) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const { tool, effect, brush } = getTool();
    const [x, y] = point(e);
    draft = tool === 'brush'
      ? { kind: 'brush', effect, size: brush, pts: [[x, y]] }
      : { kind: tool, effect, x, y, w: 0, h: 0, ox: x, oy: y };
    paint();
  });
  const extend = e => {
    const [x, y] = point(e);
    if (draft.kind === 'brush') draft.pts.push([x, y]);
    else Object.assign(draft, { x: Math.min(x, draft.ox), y: Math.min(y, draft.oy), w: Math.abs(x - draft.ox), h: Math.abs(y - draft.oy) });
  };
  canvas.addEventListener('pointermove', e => {
    if (!draft) return;
    extend(e);
    paint();
  });
  const finish = e => {
    if (!draft) return;
    if (e.type === 'pointerup') extend(e); // điểm nhả chuột cũng là điểm cuối của hình
    const { ox, oy, ...shape } = draft;
    draft = null;
    // Bỏ các cú chạm nhầm quá nhỏ.
    if (shape.kind === 'brush' || (shape.w > 0.005 && shape.h > 0.005)) shapes.push(shape);
    paint();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  return {
    /** @param {HTMLCanvasElement} preview ảnh đã xoay/lật ở độ phân giải xem trước */
    load(preview, initial) {
      base = preview;
      canvas.width = preview.width;
      canvas.height = preview.height;
      cache.clear();
      shapes = (initial || []).map(s => ({ ...s, pts: s.pts && s.pts.map(p => [...p]) }));
      fit();
      paint();
    },
    undo() { shapes.pop(); paint(); },
    add(list) { shapes.push(...list); paint(); },
    clear() { shapes = []; paint(); },
    get shapes() { return shapes.map(s => ({ ...s })); }
  };
}
