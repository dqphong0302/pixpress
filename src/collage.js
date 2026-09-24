/**
 * Ghép nhiều ảnh: bố cục định sẵn (lưới, 1 lớn + nhỏ, dải) hoặc tự do.
 * Ảnh ghép xuất ra PNG rồi được đưa lại vào hàng đợi PixPress, nên vẫn nén, đổi định dạng và xóa metadata như ảnh thường.
 * Ảnh nguồn đã áp cắt/xoay/che vùng của từng ảnh (dùng chung render() của engine).
 */
import { render } from './engine.js';

/** Mỗi ô: [cột, hàng, số cột chiếm, số hàng chiếm] trên lưới cols × rows. */
export const LAYOUTS = [
  { id: 'h2', name: '2 ngang', cols: 2, rows: 1, cells: [[0, 0, 1, 1], [1, 0, 1, 1]] },
  { id: 'v2', name: '2 dọc', cols: 1, rows: 2, cells: [[0, 0, 1, 1], [0, 1, 1, 1]] },
  { id: 'h3', name: '3 ngang', cols: 3, rows: 1, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1]] },
  { id: 'l3', name: '1 lớn trái + 2', cols: 2, rows: 2, cells: [[0, 0, 1, 2], [1, 0, 1, 1], [1, 1, 1, 1]] },
  { id: 't3', name: '1 lớn trên + 2', cols: 2, rows: 2, cells: [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
  { id: 'g4', name: 'Lưới 2×2', cols: 2, rows: 2, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
  { id: 'l4', name: '1 lớn + 3', cols: 3, rows: 3, cells: [[0, 0, 2, 3], [2, 0, 1, 1], [2, 1, 1, 1], [2, 2, 1, 1]] },
  { id: 't4', name: '1 lớn trên + 3', cols: 3, rows: 3, cells: [[0, 0, 3, 2], [0, 2, 1, 1], [1, 2, 1, 1], [2, 2, 1, 1]] },
  { id: 'g6', name: 'Lưới 3×2', cols: 3, rows: 2, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
  { id: 'g6v', name: 'Lưới 2×3', cols: 2, rows: 3, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [0, 2, 1, 1], [1, 2, 1, 1]] },
  { id: 'g9', name: 'Lưới 3×3', cols: 3, rows: 3, cells: Array.from({ length: 9 }, (_, i) => [i % 3, Math.floor(i / 3), 1, 1]) },
  { id: 'strip', name: 'Dải dọc (mọi ảnh)', strip: true },
  { id: 'free', name: 'Tự do', free: true }
];

export const RATIOS = [
  { id: '1:1', v: 1 }, { id: '4:5', v: 4 / 5 }, { id: '3:4', v: 3 / 4 }, { id: '9:16', v: 9 / 16 },
  { id: '16:9', v: 16 / 9 }, { id: '3:2', v: 3 / 2 }, { id: 'A4', v: 1 / Math.SQRT2 }
];

const PREVIEW_LONG = 900;

/* ---------------- Hình học ---------------- */

/** Ô tính bằng pixel cho khung W×H với lề ngoài pad và khe hở gap. */
function cellRects(layout, count, W, H, pad, gap) {
  const L = layout.strip ? { cols: 1, rows: count, cells: Array.from({ length: count }, (_, i) => [0, i, 1, 1]) } : layout;
  const cw = (W - 2 * pad - (L.cols - 1) * gap) / L.cols;
  const ch = (H - 2 * pad - (L.rows - 1) * gap) / L.rows;
  return L.cells.map(([c, r, cs, rs]) => ({
    x: pad + c * (cw + gap),
    y: pad + r * (ch + gap),
    w: cs * cw + (cs - 1) * gap,
    h: rs * ch + (rs - 1) * gap
  }));
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, rr) : ctx.rect(x, y, w, h);
}

/** Vẽ ảnh phủ kín ô (cover), có phóng to và dịch chuyển theo pan ∈ [-1, 1]. */
function drawCover(ctx, img, rect, view, radius) {
  const s = Math.max(rect.w / img.width, rect.h / img.height) * view.zoom;
  const dw = img.width * s, dh = img.height * s;
  const ox = (dw - rect.w) / 2, oy = (dh - rect.h) / 2;
  const dx = rect.x - ox + view.px * ox;
  const dy = rect.y - oy + view.py * oy;
  ctx.save();
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

/* ---------------- Trình ghép ---------------- */

/**
 * @param {Array<{name:string, bitmap:ImageBitmap, edit:object}>} items ảnh đã giải mã trong hàng đợi
 * @param {(file: File) => void} onCreate
 */
export function openCollage(items, onCreate) {
  const sources = items.filter(it => it.bitmap);
  if (sources.length < 2) return false;

  // Bản xem trước của từng ảnh (đã áp cắt/xoay/che), tạo một lần.
  const previews = sources.map(it => render(it.bitmap, it.edit, { resizeMode: 'max', maxSide: 1200 }).canvas);

  const state = {
    layout: sources.length >= 4 ? 'g4' : sources.length === 3 ? 'l3' : 'h2',
    ratio: '1:1',
    gap: 12, pad: 12, radius: 0, // tính theo khung cạnh dài 1000 px, tự co giãn khi xuất
    bg: '#ffffff',
    outLong: 2048,
    slots: sources.map((_, i) => i), // ô thứ k hiển thị ảnh slots[k]
    views: sources.map(() => ({ zoom: 1, px: 0, py: 0 })),
    layers: [], // chế độ tự do: { src, x, y, w } tỷ lệ theo bề ngang khung
    selected: 0
  };

  /* ---------- DOM ---------- */
  const modal = document.createElement('div');
  modal.className = 'px-modal px-collage';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'collageTitle');
  modal.innerHTML = `
    <div class="px-modal-box px-collage-box">
      <div class="px-modal-head">
        <div>
          <h3 id="collageTitle">Ghép ảnh</h3>
          <p class="px-modal-sub">Kéo ảnh trong ô để căn · kéo sang ô khác để đổi chỗ · cuộn chuột để phóng to</p>
        </div>
        <button type="button" class="px-icon-btn" data-act="close" aria-label="Đóng"><svg class="px-ico"><use href="#i-x"/></svg></button>
      </div>
      <div class="px-collage-body">
        <div class="px-collage-stage"><canvas class="px-collage-canvas"></canvas></div>
        <aside class="px-collage-side">
          <div class="px-group">
            <h4 class="px-group-title">Bố cục</h4>
            <div class="px-layouts"></div>
          </div>
          <div class="px-group">
            <h4 class="px-group-title">Tỷ lệ khung</h4>
            <div class="px-seg px-seg--wrap" data-role="ratio"></div>
          </div>
          <div class="px-group px-collage-sliders">
            <label>Khoảng cách <input type="range" class="px-range" min="0" max="60" data-k="gap"></label>
            <label>Lề ngoài <input type="range" class="px-range" min="0" max="80" data-k="pad"></label>
            <label>Bo góc <input type="range" class="px-range" min="0" max="80" data-k="radius"></label>
          </div>
          <div class="px-group">
            <h4 class="px-group-title">Màu nền</h4>
            <div class="px-swatches">
              ${['#ffffff', '#faf8f5', '#1c1917', '#1d4f91', '#8a5a34', '#f4ece3'].map(c => `<button type="button" class="px-swatch" data-bg="${c}" style="background:${c}" aria-label="Nền ${c}"></button>`).join('')}
              <label class="px-swatch px-swatch--pick" aria-label="Chọn màu khác"><input type="color" data-role="bg"></label>
            </div>
          </div>
          <div class="px-group">
            <h4 class="px-group-title">Ảnh <small data-role="hint"></small></h4>
            <div class="px-collage-thumbs"></div>
          </div>
          <div class="px-group">
            <h4 class="px-group-title">Kích thước xuất</h4>
            <div class="px-seg px-seg--fill" data-role="out">
              ${[1080, 2048, 3000, 4096].map(v => `<button type="button" data-v="${v}">${v}</button>`).join('')}
            </div>
          </div>
          <button type="button" class="px-btn px-btn--primary px-collage-create" data-act="create"><svg class="px-ico"><use href="#i-download"/></svg>Tạo ảnh ghép</button>
        </aside>
      </div>
    </div>`;
  document.body.append(modal);
  document.body.style.overflow = 'hidden';

  const q = sel => modal.querySelector(sel);
  const canvas = q('.px-collage-canvas');
  const ctx = canvas.getContext('2d');

  // Nút bố cục có hình minh họa nhỏ.
  const layoutsEl = q('.px-layouts');
  for (const L of LAYOUTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'px-layout';
    b.dataset.id = L.id;
    b.title = L.name;
    b.setAttribute('aria-label', L.name);
    let svg = '';
    if (L.free) svg = '<rect x="3" y="4" width="11" height="9" rx="1"/><rect x="10" y="11" width="11" height="9" rx="1"/>';
    else {
      const rects = cellRects(L, 3, 24, 24, 2, 2);
      svg = rects.map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="1"/>`).join('');
    }
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>`;
    layoutsEl.append(b);
  }
  const ratioEl = q('[data-role="ratio"]');
  ratioEl.innerHTML = RATIOS.map(r => `<button type="button" data-v="${r.id}">${r.id}</button>`).join('');

  const thumbs = q('.px-collage-thumbs');
  previews.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'px-collage-thumb';
    b.dataset.i = i;
    b.title = sources[i].name;
    const t = document.createElement('canvas');
    const k = 96 / Math.max(p.width, p.height);
    t.width = Math.round(p.width * k);
    t.height = Math.round(p.height * k);
    t.getContext('2d').drawImage(p, 0, 0, t.width, t.height);
    b.append(t);
    thumbs.append(b);
  });

  /* ---------- Trạng thái suy ra ---------- */
  const layout = () => LAYOUTS.find(l => l.id === state.layout);
  const frameSize = long => {
    const r = RATIOS.find(x => x.id === state.ratio).v;
    return r >= 1 ? { W: long, H: Math.round(long / r) } : { W: Math.round(long * r), H: long };
  };
  const cellsFor = (W, H, scale) => {
    const L = layout();
    const n = L.strip ? state.slots.length : L.cells.length;
    return cellRects(L, n, W, H, state.pad * scale, state.gap * scale);
  };

  function initFreeLayers() {
    if (state.layers.length) return;
    const n = sources.length;
    const cols = Math.ceil(Math.sqrt(n));
    state.layers = sources.map((_, i) => ({ src: i, x: 0.06 + (i % cols) * (0.88 / cols), y: 0.06 + Math.floor(i / cols) * (0.88 / cols), w: 0.8 / cols }));
  }

  /* ---------- Vẽ ---------- */
  function draw(target, long, imgs) {
    const { W, H } = frameSize(long);
    target.width = W;
    target.height = H;
    const c = target.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.fillStyle = state.bg;
    c.fillRect(0, 0, W, H);
    const scale = Math.max(W, H) / 1000;
    const L = layout();
    if (L.free) {
      for (const l of state.layers) {
        const img = imgs[l.src];
        const w = l.w * W, h = w * img.height / img.width;
        c.save();
        roundRect(c, l.x * W, l.y * H, w, h, state.radius * scale);
        c.clip();
        c.drawImage(img, l.x * W, l.y * H, w, h);
        c.restore();
      }
      return [];
    }
    const rects = cellsFor(W, H, scale);
    rects.forEach((r, k) => {
      const src = state.slots[k];
      if (src === undefined) {
        c.fillStyle = 'rgba(128,128,128,0.15)';
        roundRect(c, r.x, r.y, r.w, r.h, state.radius * scale);
        c.fill();
        return;
      }
      drawCover(c, imgs[src], r, state.views[src], state.radius * scale);
    });
    return rects;
  }

  let rects = [];
  function paint() {
    rects = draw(canvas, PREVIEW_LONG, previews);
    // Viền ô/lớp đang chọn.
    const L = layout();
    ctx.save();
    ctx.strokeStyle = '#7fb0ee';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    if (L.free) {
      const l = state.layers.find(x => x.src === state.selected);
      if (l) {
        const img = previews[l.src], w = l.w * canvas.width;
        ctx.strokeRect(l.x * canvas.width, l.y * canvas.height, w, w * img.height / img.width);
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        ctx.fillRect(l.x * canvas.width + w - 9, l.y * canvas.height + w * img.height / img.width - 9, 14, 14);
        ctx.strokeRect(l.x * canvas.width + w - 9, l.y * canvas.height + w * img.height / img.width - 9, 14, 14);
      }
    } else if (rects[state.selected]) {
      const r = rects[state.selected];
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
    }
    ctx.restore();
    syncControls();
  }

  function syncControls() {
    modal.querySelectorAll('.px-layout').forEach(b => b.classList.toggle('on', b.dataset.id === state.layout));
    ratioEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === state.ratio));
    q('[data-role="out"]').querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === state.outLong));
    modal.querySelectorAll('.px-swatch[data-bg]').forEach(b => b.classList.toggle('on', b.dataset.bg === state.bg));
    modal.querySelectorAll('.px-collage-sliders input').forEach(inp => {
      inp.value = state[inp.dataset.k];
      inp.style.setProperty('--fill', `${(inp.value / inp.max) * 100}%`);
    });
    const L = layout();
    const used = L.free ? state.layers.map(l => l.src) : state.slots.slice(0, L.strip ? state.slots.length : L.cells.length);
    thumbs.querySelectorAll('.px-collage-thumb').forEach(b => b.classList.toggle('used', used.includes(Number(b.dataset.i))));
    q('[data-role="hint"]').textContent = L.free ? '· bấm để thêm/bớt' : '· bấm để đặt vào ô đang chọn';
  }

  /* ---------- Tương tác ---------- */
  const toCanvas = e => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  };
  const hitCell = p => rects.findIndex(r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
  const hitLayer = p => {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i], img = previews[l.src];
      const x = l.x * canvas.width, y = l.y * canvas.height, w = l.w * canvas.width, h = w * img.height / img.width;
      if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return { i, handle: p.x > x + w - 22 && p.y > y + h - 22 };
    }
    return null;
  };

  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    const p = toCanvas(e);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* con trỏ đã nhả */ }
    if (layout().free) {
      const hit = hitLayer(p);
      if (!hit) return;
      const [l] = state.layers.splice(hit.i, 1);
      state.layers.push(l); // đưa lên trên cùng
      state.selected = l.src;
      drag = { mode: hit.handle ? 'resize' : 'move', start: p, orig: { ...l }, layer: l };
    } else {
      const k = hitCell(p);
      if (k < 0) return;
      state.selected = k;
      drag = { mode: 'pan', start: p, cell: k, src: state.slots[k], orig: state.slots[k] !== undefined ? { ...state.views[state.slots[k]] } : null };
    }
    paint();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = toCanvas(e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (drag.mode === 'move') {
      drag.layer.x = drag.orig.x + dx / canvas.width;
      drag.layer.y = drag.orig.y + dy / canvas.height;
    } else if (drag.mode === 'resize') {
      drag.layer.w = Math.max(0.05, drag.orig.w + dx / canvas.width);
    } else if (drag.mode === 'pan' && drag.orig) {
      const k = hitCell(p);
      drag.swapTo = k >= 0 && k !== drag.cell ? k : null;
      if (drag.swapTo === null) {
        // Kéo trong ô → dịch ảnh; biên độ tính theo phần ảnh thừa ra khỏi ô.
        const r = rects[drag.cell], img = previews[drag.src], v = state.views[drag.src];
        const s = Math.max(r.w / img.width, r.h / img.height) * v.zoom;
        const ox = (img.width * s - r.w) / 2 || 1, oy = (img.height * s - r.h) / 2 || 1;
        v.px = Math.max(-1, Math.min(1, drag.orig.px + dx / ox));
        v.py = Math.max(-1, Math.min(1, drag.orig.py + dy / oy));
      }
    }
    paint();
    if (drag.swapTo != null) {
      const r = rects[drag.swapTo];
      ctx.save();
      ctx.fillStyle = 'rgba(29,79,145,0.35)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  });
  const endDrag = () => {
    if (drag?.swapTo != null) {
      const a = drag.cell, b = drag.swapTo;
      [state.slots[a], state.slots[b]] = [state.slots[b], state.slots[a]];
      state.selected = b;
    }
    drag = null;
    paint();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', e => {
    if (layout().free) return;
    const k = hitCell(toCanvas(e));
    const src = state.slots[k];
    if (k < 0 || src === undefined) return;
    e.preventDefault();
    const v = state.views[src];
    v.zoom = Math.max(1, Math.min(4, v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    state.selected = k;
    paint();
  }, { passive: false });

  modal.addEventListener('click', e => {
    const t = e.target.closest('button, [data-bg]');
    if (e.target === modal) return close();
    if (!t) return;
    if (t.dataset.act === 'close') return close();
    if (t.dataset.act === 'create') return create();
    if (t.classList.contains('px-layout')) {
      state.layout = t.dataset.id;
      if (layout().free) initFreeLayers();
      state.selected = 0;
    } else if (t.closest('[data-role="ratio"]')) state.ratio = t.dataset.v;
    else if (t.closest('[data-role="out"]')) state.outLong = Number(t.dataset.v);
    else if (t.dataset.bg) state.bg = t.dataset.bg;
    else if (t.classList.contains('px-collage-thumb')) {
      const i = Number(t.dataset.i);
      if (layout().free) {
        const at = state.layers.findIndex(l => l.src === i);
        if (at >= 0) state.layers.splice(at, 1);
        else state.layers.push({ src: i, x: 0.25, y: 0.25, w: 0.5 });
        state.selected = i;
      } else {
        // Đặt ảnh vào ô đang chọn; nếu ảnh đã ở ô khác thì đổi chỗ.
        const other = state.slots.indexOf(i);
        const cur = state.slots[state.selected];
        if (other >= 0) state.slots[other] = cur;
        state.slots[state.selected] = i;
      }
    } else return;
    paint();
  });
  modal.addEventListener('input', e => {
    if (e.target.dataset.k) state[e.target.dataset.k] = Number(e.target.value);
    else if (e.target.dataset.role === 'bg') state.bg = e.target.value;
    paint();
  });
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  function close() {
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    modal.remove();
  }

  async function create() {
    const btn = q('[data-act="create"]');
    btn.disabled = true;
    btn.lastChild.textContent = 'Đang tạo…';
    await new Promise(r => setTimeout(r));
    // Ảnh nguồn ở độ phân giải đủ cho kích thước xuất.
    const full = sources.map(it => render(it.bitmap, it.edit, { resizeMode: 'max', maxSide: state.outLong }).canvas);
    const out = document.createElement('canvas');
    draw(out, state.outLong, full);
    const blob = await new Promise(r => out.toBlob(r, 'image/png'));
    close();
    onCreate(new File([blob], `anh-ghep-${state.layout}-${Date.now().toString(36)}.png`, { type: 'image/png' }));
  }

  paint();
  modal.querySelector('.px-layout.on')?.focus();
  return true;
}
