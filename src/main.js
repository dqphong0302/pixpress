/**
 * PixPress — UI controller
 * Designed by Quoc-Phong Dang, M.Sc. (phongdang.io.vn)
 */

import JSZip from 'jszip';
import { LIMITS, FB_MAX_SIDE, VISA_VN, decode, orient, render, processImage, processLossless, detectEncoders } from './engine.js';
import { inspectMetadata } from './metadata.js';
import { createRedactor, transformShapes, applyRedactions } from './redact.js';
import { openCollage } from './collage.js';

// AI chỉ nạp khi người dùng bấm tính năng AI.
const ai = () => import('./ai.js');
import { qualityGrade } from './quality.js';
import { createCropper } from './crop.js';

const $ = id => document.getElementById(id);
const toast = (msg, type = 'success') => window.PDUI?.Toast.show(msg, type, 3000);

/* ---------------- Settings ---------------- */

const PRESETS = {
  none: { format: 'keep', quality: 92, resizeMode: 'none' },
  fb: { format: 'jpeg', quality: 92, resizeMode: 'fb' },
  web: { format: 'webp', quality: 80, resizeMode: 'max', maxSide: 1600 },
  tiny: { format: 'webp', quality: 65, resizeMode: 'max', maxSide: 1280 }
};

// Mặc định: không dùng mẫu — giữ định dạng và kích thước gốc.
const DEFAULTS = { privacy: 'clean', noise: 'light', aiWhiteBg: false, format: 'keep', quality: 92, resizeMode: 'none', maxSide: 1920, percent: 50, exactW: 1200, exactH: 630, keepRatio: true };
const STORE_KEY = 'pixpress_settings';

let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch {}
// Ảnh visa giờ là tab riêng; bỏ lựa chọn cũ đã lưu.
if (settings.resizeMode === 'visa') settings.resizeMode = 'none';

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch {}
}

/* ---------------- Tab công cụ ---------------- */

const MODES = { edit: '', visa: 'visa', redact: 'che-vung' };
let mode = Object.keys(MODES).find(m => MODES[m] && `#${MODES[m]}` === location.hash) || 'edit';

/** Tùy chọn thực tế theo tab: tab visa luôn xuất JPG 600×900 ≤ 2 MB, không phụ thuộc tùy chọn nén. */
function opts() {
  return mode === 'visa' ? { ...settings, privacy: 'clean', format: 'jpeg', quality: 92, resizeMode: 'visa' } : settings;
}

function engineOptions() {
  const o = opts();
  return { ...o, quality: o.quality / 100 };
}

let encoders = { jpeg: true, png: true, webp: true, avif: false };

/* ---------------- State ---------------- */

/** @type {Array<{id:number,file:File,name:string,bitmap:ImageBitmap|null,preview:ImageBitmap|null,thumb:string,edit:{rotate:number,flipH:boolean,crop:null|object},result:any,url:string|null,status:string,error?:string,runs:number}>} */
let items = [];
let active = null;
let nextId = 1;

const fmtBytes = b => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};
const baseName = n => n.replace(/\.[^.]+$/, '') || 'image';
const pctText = p => `${p >= 0 ? '−' : '+'}${Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0)}%`;

/* ---------------- Processing queue ---------------- */

const pending = new Set();
let pumping = false;

function enqueue(list) {
  list.forEach(it => { pending.add(it); it.status = 'pending'; renderQueueItem(it); });
  if (list.includes(active)) $('busy').hidden = false;
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (pending.size) {
    const it = pending.has(active) ? active : pending.values().next().value;
    pending.delete(it);
    if (!items.includes(it)) continue;
    await runItem(it);
  }
  pumping = false;
  updateSummary();
}

async function runItem(it) {
  it.status = 'busy';
  const run = ++it.runs;
  renderQueueItem(it);
  if (it === active) $('busy').hidden = false;
  try {
    if (!it.bitmap) await loadBitmap(it);
    let res = null;
    it.fallback = '';
    if (opts().privacy === 'lossless') {
      const edited = it.edit.rotate || it.edit.flipH || it.edit.crop;
      if (edited) it.fallback = 'Ảnh đã được cắt/xoay nên phải vẽ lại thay vì chỉ xóa metadata.';
      else if (it.meta?.orientation !== 1) it.fallback = 'Ảnh dùng thẻ xoay EXIF (thường gặp ở ảnh điện thoại) nên được vẽ lại để giữ đúng hướng.';
      else {
        res = await processLossless(it.file, it.bitmap);
        if (!res) it.fallback = 'Định dạng này (vd. HEIC của iPhone) không xóa trực tiếp được nên được vẽ lại thành JPG.';
      }
    }
    const whiteBg = opts().resizeMode === 'visa' && settings.aiWhiteBg;
    if (whiteBg && !res) await ensureBgMask(it);
    // Vẽ lại qua canvas luôn làm mất toàn bộ metadata; khi dự phòng cho "chỉ xóa" thì giữ nguyên kích thước, chất lượng cao.
    res ??= await processImage(it.file, it.bitmap, it.edit, opts().privacy === 'lossless'
      ? { ...engineOptions(), resizeMode: 'none', quality: 0.95, privacy: 'clean' }
      : { ...engineOptions(), whiteBg });
    if (run !== it.runs || !items.includes(it)) return;
    if (it.url) URL.revokeObjectURL(it.url);
    it.result = res;
    it.url = URL.createObjectURL(res.blob);
    it.status = 'done';
  } catch (err) {
    it.status = 'error';
    it.error = err.message || String(err);
  }
  renderQueueItem(it);
  if (it === active) { $('busy').hidden = !pending.has(it); renderActive(); }
  updateSummary();
}

/** Mặt nạ người cho nền trắng; tính lại khi ảnh đổi hướng xoay/lật. */
async function ensureBgMask(it) {
  const key = `${it.edit.rotate}|${it.edit.flipH}`;
  if (it.bgMaskKey === key) return;
  try {
    const { personMask } = await ai();
    it.edit.bgMask = await personMask(orient(it.preview, it.edit.rotate, it.edit.flipH));
    it.bgMaskKey = key;
    it.aiError = '';
  } catch (err) {
    it.edit.bgMask = null;
    it.aiError = 'Không tải được AI đổi nền (kiểm tra kết nối mạng ở lần dùng đầu).';
    console.warn(err);
  }
}

/** Giải mã một lần dù được gọi song song (hàng đợi và công cụ của tab cùng cần ảnh). */
function loadBitmap(it) {
  it.loading ??= decodeItem(it).catch(err => { it.loading = null; throw err; });
  return it.loading;
}

async function decodeItem(it) {
  const metaTask = inspectMetadata(it.file).catch(() => ({ findings: [], orientation: 1 }));
  it.bitmap = await decode(it.file);
  it.meta = await metaTask;
  if (it.bitmap.width * it.bitmap.height > LIMITS.maxPixels) {
    it.bitmap.close();
    it.bitmap = null;
    throw new Error('Ảnh quá lớn (> 80 megapixel).');
  }
  const long = Math.max(it.bitmap.width, it.bitmap.height);
  const k = Math.min(1, 1600 / long);
  it.preview = await createImageBitmap(it.bitmap, {
    resizeWidth: Math.max(1, Math.round(it.bitmap.width * k)),
    resizeHeight: Math.max(1, Math.round(it.bitmap.height * k)),
    resizeQuality: 'high'
  });
  const tk = Math.min(1, 160 / long);
  const tc = document.createElement('canvas');
  tc.width = Math.max(1, Math.round(it.bitmap.width * tk));
  tc.height = Math.max(1, Math.round(it.bitmap.height * tk));
  tc.getContext('2d').drawImage(it.preview, 0, 0, tc.width, tc.height);
  it.thumb = tc.toDataURL('image/jpeg', 0.7);
}

/* ---------------- Adding files ---------------- */

function addFiles(fileList, { select: focus = false } = {}) {
  const files = [...fileList].filter(f => f.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name));
  if (!files.length) return toast('Không tìm thấy file ảnh hợp lệ.', 'warning');
  const room = LIMITS.maxFiles - items.length;
  if (room <= 0) return toast(`Tối đa ${LIMITS.maxFiles} ảnh mỗi lượt.`, 'warning');
  const accepted = [];
  for (const file of files.slice(0, room)) {
    if (file.size > LIMITS.maxFileSize) { toast(`${file.name} vượt quá 50 MB.`, 'warning'); continue; }
    const it = { id: nextId++, file, name: file.name || `pasted-${Date.now()}.png`, bitmap: null, preview: null, thumb: '', edit: { rotate: 0, flipH: false, crop: null }, result: null, url: null, status: 'pending', runs: 0 };
    items.push(it);
    accepted.push(it);
  }
  if (files.length > room) toast(`Chỉ nhận thêm ${room} ảnh (giới hạn ${LIMITS.maxFiles}).`, 'warning');
  if (!accepted.length) return;
  $('work').hidden = false;
  $('batch').hidden = false;
  document.body.classList.add('px-has-items');
  accepted.forEach(it => $('queue').appendChild(buildQueueItem(it)));
  if (!active || focus) select(accepted[0]);
  enqueue(accepted);
}

/* ---------------- Queue UI ---------------- */

function buildQueueItem(it) {
  const li = document.createElement('li');
  li.className = 'px-q';
  li.dataset.id = it.id;
  li.innerHTML = `
    <button type="button" class="px-q-main">
      <span class="px-q-thumb"></span>
      <span class="px-q-info">
        <span class="px-q-name"></span>
        <span class="px-q-meta"></span>
      </span>
      <span class="px-q-badge"></span>
    </button>
    <button type="button" class="px-q-dl" title="Tải ảnh này" aria-label="Tải ảnh này"><svg class="px-ico"><use href="#i-download"/></svg></button>
    <button type="button" class="px-q-del" title="Xóa khỏi danh sách" aria-label="Xóa ảnh"><svg class="px-ico"><use href="#i-x"/></svg></button>`;
  li.querySelector('.px-q-name').textContent = it.name;
  li.querySelector('.px-q-main').addEventListener('click', () => select(it));
  li.querySelector('.px-q-dl').addEventListener('click', () => downloadOne(it));
  li.querySelector('.px-q-del').addEventListener('click', () => removeItem(it));
  return li;
}

function renderQueueItem(it) {
  const li = $('queue').querySelector(`[data-id="${it.id}"]`);
  if (!li) return;
  li.classList.toggle('active', it === active);
  li.classList.toggle('busy', it.status === 'busy' || it.status === 'pending');
  const thumb = li.querySelector('.px-q-thumb');
  if (it.thumb && !thumb.firstChild) {
    const img = new Image();
    img.src = it.thumb;
    img.alt = '';
    thumb.appendChild(img);
  }
  const meta = li.querySelector('.px-q-meta');
  const badge = li.querySelector('.px-q-badge');
  badge.className = 'px-q-badge';
  li.querySelector('.px-q-dl').disabled = it.status !== 'done';
  if (it.status === 'error') {
    meta.textContent = it.error;
    badge.textContent = 'Lỗi';
    badge.classList.add('bad');
  } else if (it.status === 'done') {
    const r = it.result;
    const g = qualityGrade(r.ssim);
    const ai = it.meta?.findings.some(f => f.group === 'ai') ? ' · đã xóa dấu vết AI' : '';
    meta.textContent = `${fmtBytes(r.origSize)} → ${fmtBytes(r.newSize)} · ${r.w}×${r.h} · ${r.formatLabel} · Q ${g.score ?? '—'}${ai}`;
    badge.textContent = pctText(r.deltaPct);
    badge.classList.add(r.deltaPct >= 0 ? 'good' : 'warn');
  } else {
    meta.textContent = 'Đang xử lý…';
    badge.textContent = '';
  }
}

function removeItem(it) {
  items = items.filter(x => x !== it);
  pending.delete(it);
  if (it.url) URL.revokeObjectURL(it.url);
  it.bitmap?.close();
  it.preview?.close();
  $('queue').querySelector(`[data-id="${it.id}"]`)?.remove();
  if (active === it) {
    if (cropping) exitCrop(false);
    if (redacting) exitRedact(false);
    active = null;
    if (items.length) select(items[0]);
  }
  if (!items.length) clearAll();
  updateSummary();
}

function clearAll() {
  if (cropping) exitCrop(false);
  if (redacting) exitRedact(false);
  items.forEach(it => { if (it.url) URL.revokeObjectURL(it.url); it.bitmap?.close(); it.preview?.close(); });
  items = [];
  pending.clear();
  active = null;
  $('queue').innerHTML = '';
  $('work').hidden = true;
  $('batch').hidden = true;
  document.body.classList.remove('px-has-items');
  $('previewImg').removeAttribute('src');
}

function updateSummary() {
  const done = items.filter(i => i.status === 'done');
  const before = done.reduce((s, i) => s + i.result.origSize, 0);
  const after = done.reduce((s, i) => s + i.result.newSize, 0);
  $('sumCount').textContent = `${done.length}/${items.length}`;
  $('sumBefore').textContent = done.length ? fmtBytes(before) : '—';
  $('sumAfter').textContent = done.length ? fmtBytes(after) : '—';
  const pct = before ? ((before - after) / before) * 100 : 0;
  const el = $('sumPct');
  el.textContent = done.length ? pctText(pct) : '—';
  el.classList.toggle('px-good', pct >= 0);
  el.classList.toggle('px-warn', pct < 0);
  $('zipBtn').disabled = !done.length || pending.size > 0;
}

/* ---------------- Active image ---------------- */

function select(it) {
  if (cropping) exitCrop(false);
  if (redacting) exitRedact(false);
  const prev = active;
  active = it;
  if (prev) renderQueueItem(prev);
  renderQueueItem(it);
  $('busy').hidden = it.status === 'done' || it.status === 'error';
  renderActive();
  openModeTool();
}

/** Mỗi tab mở sẵn công cụ của nó: visa → khung 4×6 (tự căn mặt lần đầu), che vùng → lớp vẽ. */
async function openModeTool() {
  const it = active;
  if (!it) return;
  if (mode === 'visa' && !it.edit.crop) {
    await enterCrop();
    if (cropping && active === it && !it.autoAligned) { it.autoAligned = true; alignFace(); }
  } else if (mode === 'redact' && !it.edit.redact) {
    enterRedact();
  }
}

function renderActive() {
  const it = active;
  if (!it) return;
  const img = $('previewImg');
  if (it.url && img.src !== it.url) img.src = it.url;
  const r = it.result;
  const set = (id, v) => { $(id).textContent = v; };
  const warn = $('warnNote');
  warn.hidden = true;

  if (it.status === 'error') {
    ['stDelta', 'stQuality', 'stDim', 'stFmt'].forEach(id => set(id, '—'));
    $('stSaveBar').style.width = '0';
    set('stSize', it.error);
    img.removeAttribute('src');
    $('busy').hidden = true;
    return;
  }
  if (!r) return;

  const delta = $('stDelta');
  delta.textContent = pctText(r.deltaPct);
  delta.className = `px-tile-num ${r.deltaPct >= 0 ? 'px-good' : 'px-warn'}`;
  const bar = $('stSaveBar');
  bar.style.width = `${Math.max(0, Math.min(100, r.deltaPct))}%`;
  set('stSize', `${fmtBytes(r.origSize)} → ${fmtBytes(r.newSize)}`);

  const g = qualityGrade(r.ssim);
  const q = $('stQuality');
  q.textContent = g.score == null ? '—' : `${g.score}/100`;
  q.className = `px-tile-num px-tile-num--md px-tone-${g.tone}`;
  set('stQualityLbl', g.label);
  const meter = $('stMeter');
  meter.style.width = `${g.score ?? 0}%`;
  meter.className = `px-tone-bg-${g.tone}`;

  set('stDim', `${r.w} × ${r.h}`);
  const cropped = it.edit.crop ? ' · đã cắt' : '';
  set('stDimSub', `Gốc ${r.origW} × ${r.origH}${cropped}`);
  set('stFmt', r.formatLabel);
  set('stPsnr', Number.isFinite(r.psnr) ? `PSNR ${r.psnr.toFixed(1)} dB` : 'Không mất dữ liệu (lossless)');

  renderMeta(it);

  const notes = [];
  if (it.fallback) notes.push(it.fallback);
  if (it.aiError && opts().resizeMode === 'visa') notes.push(it.aiError);
  if (r.visa) {
    const v = r.visa;
    const issues = [];
    const f = it.faceCheck;
    if (f) {
      if (f.faces > 1) issues.push(`có ${f.faces} khuôn mặt trong ảnh (chỉ được một người)`);
      if (Math.abs(f.yaw) > 10) issues.push(`mặt quay ngang khoảng ${Math.abs(f.yaw)}°`);
      if (Math.abs(f.pitch) > 12) issues.push(`đầu ngửa/cúi khoảng ${Math.abs(f.pitch)}°`);
      if (Math.abs(f.roll) > 6) issues.push(`đầu nghiêng khoảng ${Math.abs(f.roll)}°`);
      if (!f.eyesOpen) issues.push('mắt có vẻ đang nhắm');
      if (it.faceTight) issues.push('ảnh chụp quá sát, không đủ chỗ phía trên đầu — nên chụp lùi xa hơn');
    }
    if (!v.background.sides) issues.push(settings.aiWhiteBg ? 'mép nền vẫn chưa trắng hẳn, hãy xem lại vùng quanh vai/tóc' : 'nền ảnh có vẻ chưa trắng (cổng evisa yêu cầu phông nền trắng) — thử bật "Đổi nền trắng bằng AI"');
    else if (!v.background.top) issues.push('đầu/tóc chạm mép trên ảnh — nên chụp lùi xa để có khoảng trống phía trên đầu');
    if (!v.jpeg) issues.push('định dạng phải là JPG');
    if (!v.sizeOk) issues.push('dung lượng phải ≤ 2 MB');
    notes.push(issues.length
      ? `Ảnh visa: ${issues.join('; ')}.`
      : f
        ? 'Ảnh visa đạt khổ 4×6 (600×900 px), JPG, ≤ 2 MB, nền sáng; AI thấy một khuôn mặt, nhìn thẳng, mắt mở. Tự kiểm tra thêm: không đội mũ, không đeo kính, trang phục lịch sự.'
        : 'Ảnh visa đạt khổ 4×6 (600×900 px), JPG, ≤ 2 MB, nền sáng. Tự kiểm tra thêm: nhìn thẳng, không đội mũ, không đeo kính, trang phục lịch sự.');
    if (!it.edit.crop) notes.push('Mẹo: bấm Căn khung rồi "Tự căn mặt · AI" để mắt nằm đúng vạch 2/3.');
  }
  if (r.deltaPct < 0 && !r.lossless) notes.push('Ảnh xuất lớn hơn ảnh gốc — ảnh gốc đã được nén sẵn, hoặc bạn đang xuất PNG / chất lượng cao. Thử giảm chất lượng hoặc chọn WebP.');
  if (opts().resizeMode === 'visa' && Math.min(r.origW, r.origH) < 600) notes.push('Ảnh gốc nhỏ hơn 600 px nên phải phóng to lên 600×900; nên chụp lại ảnh nét hơn.');
  if (opts().resizeMode === 'fb' && Math.max(r.w, r.h) < FB_MAX_SIDE) notes.push(`Vùng ảnh nhỏ hơn ${FB_MAX_SIDE} px nên được giữ nguyên kích thước (PixPress không phóng to ảnh).`);
  if (notes.length) { warn.textContent = notes.join(' '); warn.hidden = false; }
}

const GROUP_LABEL = { ai: 'Dấu vết AI', location: 'Vị trí', device: 'Thiết bị', other: 'Khác' };
const GROUP_ORDER = ['ai', 'location', 'device', 'other'];

function renderMeta(it) {
  const box = $('metaBox');
  const list = $('metaList');
  const findings = [...(it.meta?.findings || [])].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  box.hidden = false;
  list.textContent = '';
  const status = $('metaStatus');
  if (!findings.length) {
    status.textContent = 'Không có metadata nhạy cảm';
    status.className = 'px-badge';
    return;
  }
  status.textContent = `Đã xóa ${findings.length} mục trong ảnh xuất`;
  status.className = 'px-badge px-badge--good';
  for (const f of findings) {
    const li = document.createElement('li');
    li.className = `px-meta-item px-meta-item--${f.group}`;
    const tag = document.createElement('span');
    tag.className = 'px-meta-tag';
    tag.textContent = GROUP_LABEL[f.group];
    const label = document.createElement('span');
    label.className = 'px-meta-label';
    label.textContent = f.label;
    li.append(tag, label);
    if (f.detail) {
      const d = document.createElement('span');
      d.className = 'px-meta-detail';
      d.textContent = f.detail;
      li.append(d);
    }
    list.append(li);
  }
}

/* ---------------- Rotate / flip ---------------- */

function rotateCrop(c, cw) {
  if (!c) return null;
  const r = cw ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
  if (c.aspect) r.aspect = 1 / c.aspect;
  return r;
}

function rotate(cw) {
  const it = active;
  if (!it) return;
  // orient() xoay trước rồi lật, nên khi đang lật phải xoay ngược chiều để ảnh hiển thị quay đúng hướng.
  const d = cw ? 90 : -90;
  it.edit.rotate = (it.edit.rotate + (it.edit.flipH ? -d : d) + 360) % 360;
  it.edit.crop = rotateCrop(it.edit.crop, cw);
  it.edit.redact = transformShapes(redacting ? redactor.shapes : it.edit.redact, cw ? 'cw' : 'ccw');
  afterEdit(it);
}

function flip() {
  const it = active;
  if (!it) return;
  it.edit.flipH = !it.edit.flipH;
  const c = it.edit.crop;
  if (c) it.edit.crop = { ...c, x: 1 - c.x - c.w };
  it.edit.redact = transformShapes(redacting ? redactor.shapes : it.edit.redact, 'flip');
  afterEdit(it);
}

function afterEdit(it) {
  if (redacting) {
    loadRedactor(it);
  } else if (cropping) {
    const pendingCrop = cropper.isFull ? null : cropper.get();
    loadCropper(it, pendingCrop);
  } else {
    enqueue([it]);
  }
}

/* ---------------- Crop ---------------- */

let cropping = false;
let cropper = null;
let cropBackup = null;

function realOriented(it) {
  const swap = it.edit.rotate % 180 !== 0;
  return swap ? { w: it.bitmap.height, h: it.bitmap.width } : { w: it.bitmap.width, h: it.bitmap.height };
}

function syncFaceGuide() {
  const visa = $('aspectChips').querySelector('.on')?.dataset.a === 'visa';
  cropper?.setGuide(visa);
  $('aiAlignBtn').hidden = !visa;
}

/** Nút AI: bật trạng thái đang chạy, báo lỗi dễ hiểu (lần đầu cần tải ~12 MB). */
async function runAi(btn, label, job) {
  const text = btn.lastChild;
  btn.disabled = true;
  text.textContent = ' Đang chạy AI…';
  try {
    return await job();
  } catch (err) {
    console.warn(err);
    toast('Không chạy được AI. Lần dùng đầu cần mạng để tải bộ AI (~12 MB).', 'error');
    return null;
  } finally {
    btn.disabled = false;
    text.textContent = label;
  }
}

async function alignFace() {
  const it = active;
  if (!it || !cropping) return;
  await runAi($('aiAlignBtn'), ' Tự căn mặt · AI', async () => {
    const { analyzeFace, visaCrop } = await ai();
    const prev = orient(it.preview, it.edit.rotate, it.edit.flipH);
    const face = await analyzeFace(prev);
    if (!face) { toast('AI không tìm thấy khuôn mặt trong ảnh.', 'warning'); return; }
    it.faceCheck = face;
    const real = realOriented(it);
    const crop = visaCrop(face, real.w, real.h, VISA_VN.w / VISA_VN.h);
    cropper.load(applyRedactions(prev, it.edit.redact), crop, crop.aspect, real.w, real.h);
    syncFaceGuide();
    it.faceTight = crop.fitted;
    toast(crop.fitted ? 'Đã căn mắt theo vạch 2/3, nhưng ảnh chụp quá sát nên mặt to hơn khung gợi ý.' : 'Đã căn mặt theo vạch 2/3. Bấm Áp dụng để dùng.', crop.fitted ? 'warning' : 'success');
  });
}

function loadCropper(it, crop) {
  // Hiện luôn các vùng đã che để khung cắt khớp với ảnh xuất.
  const prev = applyRedactions(orient(it.preview, it.edit.rotate, it.edit.flipH), it.edit.redact);
  const real = realOriented(it);
  let aspect = aspectValue($('aspectChips').querySelector('.on')?.dataset.a || 'free', real);
  if (crop?.aspect) {
    // Giữ khóa tỷ lệ của lần cắt trước và đánh dấu đúng nút tỷ lệ.
    aspect = crop.aspect;
    const match = [...$('aspectChips').querySelectorAll('button')].find(b => Math.abs(aspectValue(b.dataset.a, real) - aspect) < 0.002);
    $('aspectChips').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === match));
  }
  cropper.load(prev, crop, aspect, real.w, real.h);
  syncFaceGuide();
}

function aspectValue(a, real) {
  if (a === 'free') return null;
  if (a === 'visa') return VISA_VN.w / VISA_VN.h;
  if (a === 'orig') return real.w / real.h;
  return Number(a);
}

async function enterCrop() {
  const it = active;
  if (!it || cropping) return;
  if (redacting) exitRedact(true);
  if (!it.bitmap) {
    try { await loadBitmap(it); } catch { return; }
  }
  cropping = true;
  cropBackup = { ...it.edit, crop: it.edit.crop && { ...it.edit.crop } };
  cropper ??= createCropper($('cropHost'));
  // Đang dùng mẫu visa thì mở sẵn khung 4×6 kèm hướng dẫn vị trí khuôn mặt.
  const startChip = mode === 'visa' ? 'visa' : 'free';
  $('aspectChips').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.a === startChip));
  $('cropHost').hidden = false;
  $('previewImg').hidden = true;
  $('cropBar').hidden = false;
  $('cropBtn').classList.add('on');
  $('stage').classList.add('px-stage--crop');
  const keep = mode !== 'visa' || Math.abs((it.edit.crop?.aspect ?? 0) - VISA_VN.w / VISA_VN.h) < 0.002;
  loadCropper(it, keep ? it.edit.crop : null);
}

function exitCrop(apply) {
  if (!cropping) return;
  const it = active;
  cropping = false;
  $('cropHost').hidden = true;
  $('previewImg').hidden = false;
  $('cropBar').hidden = true;
  $('cropBtn').classList.remove('on');
  $('stage').classList.remove('px-stage--crop');
  if (!it) return;
  if (apply) {
    it.edit.crop = cropper.isFull ? null : cropper.get();
    enqueue([it]);
  } else if (cropBackup) {
    const changed = cropBackup.rotate !== it.edit.rotate || cropBackup.flipH !== it.edit.flipH;
    it.edit = cropBackup;
    if (changed) enqueue([it]);
  }
  cropBackup = null;
}

/* ---------------- Che vùng nhạy cảm ---------------- */

let redacting = false;
let redactor = null;
let redactBackup = null;
const redactTool = { tool: 'rect', effect: 'blur', brush: 0.04 };

function loadRedactor(it, shapes = it.edit.redact) {
  redactor.load(orient(it.preview, it.edit.rotate, it.edit.flipH), shapes);
}

async function enterRedact() {
  const it = active;
  if (!it || redacting) return;
  if (cropping) exitCrop(true);
  if (!it.bitmap) {
    try { await loadBitmap(it); } catch { return; }
  }
  redacting = true;
  redactBackup = { ...it.edit };
  redactor ??= createRedactor($('redactHost'), () => redactTool);
  $('redactHost').hidden = false;
  $('previewImg').hidden = true;
  $('redactBar').hidden = false;
  $('redactBtn').classList.add('on');
  $('stage').classList.add('px-stage--crop');
  syncRedactBar();
  loadRedactor(it);
}

function exitRedact(apply) {
  if (!redacting) return;
  const it = active;
  redacting = false;
  $('redactHost').hidden = true;
  $('previewImg').hidden = false;
  $('redactBar').hidden = true;
  $('redactBtn').classList.remove('on');
  $('stage').classList.remove('px-stage--crop');
  if (!it) return;
  if (apply) {
    const shapes = redactor.shapes;
    it.edit.redact = shapes.length ? shapes : null;
    enqueue([it]);
  } else if (redactBackup) {
    const changed = redactBackup.rotate !== it.edit.rotate || redactBackup.flipH !== it.edit.flipH;
    it.edit = redactBackup;
    if (changed) enqueue([it]);
  }
  redactBackup = null;
}

async function blurFaces() {
  const it = active;
  if (!it || !redacting) return;
  await runAi($('aiFacesBtn'), ' Tìm khuôn mặt · AI', async () => {
    const { findFaces } = await ai();
    const faces = await findFaces(orient(it.preview, it.edit.rotate, it.edit.flipH));
    if (!faces.length) { toast('AI không tìm thấy khuôn mặt nào.', 'info'); return; }
    // Nới rộng khung ~35% để che cả tóc, tai, cằm.
    const effect = redactTool.effect;
    redactor.add(faces.map(f => {
      const w = f.w * 1.35, h = f.h * 1.5;
      return { kind: 'ellipse', effect, x: f.x + f.w / 2 - w / 2, y: f.y + f.h * 0.45 - h / 2, w, h };
    }));
    toast(`Đã che ${faces.length} khuôn mặt. Mặt quá nhỏ hoặc nghiêng mạnh có thể bị sót — dùng cọ để che thêm rồi bấm Áp dụng.`, 'success');
  });
}

function syncRedactBar() {
  for (const [id, key] of [['redactToolSeg', 'tool'], ['redactEffectSeg', 'effect']]) {
    $(id).querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.v === redactTool[key]);
      b.setAttribute('aria-pressed', String(b.dataset.v === redactTool[key]));
    });
  }
  $('brushRow').hidden = redactTool.tool !== 'brush';
  $('redactNote').hidden = redactTool.effect !== 'blur';
}

/* ---------------- Settings UI ---------------- */

const PRIVACY_HINT = {
  clean: 'Nên dùng. Xóa vị trí GPS, ngày chụp, tên máy, dấu "tạo bởi AI" (C2PA, prompt) rồi nén ảnh theo tùy chọn bên dưới.',
  lossless: 'Chỉ xóa các thông tin ẩn đó, không nén lại: ảnh giữ nguyên 100%, dung lượng gần như không đổi. Tùy chọn định dạng, chất lượng, kích thước tạm tắt.',
  paranoid: 'Dành cho ảnh do AI tạo: ngoài xóa thông tin, thêm một lớp nhiễu nhỏ để làm hỏng watermark vô hình (như SynthID của Google). Nhiễu càng mạnh càng hiệu quả nhưng ảnh càng sần; không đảm bảo 100%.'
};

function syncSettingsUI() {
  $('privacySeg').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === settings.privacy);
    b.setAttribute('aria-pressed', String(b.dataset.v === settings.privacy));
  });
  $('privacyHint').textContent = PRIVACY_HINT[settings.privacy] || PRIVACY_HINT.clean;
  $('noiseRow').hidden = settings.privacy !== 'paranoid';
  $('noiseSeg').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === settings.noise);
    b.setAttribute('aria-pressed', String(b.dataset.v === settings.noise));
  });
  const lossless = settings.privacy === 'lossless';
  ['groupPresets', 'groupFormat', 'groupSize'].forEach(id => $(id).classList.toggle('px-dim', lossless));
  $('fmtSeg').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === settings.format);
    b.setAttribute('aria-pressed', String(b.dataset.v === settings.format));
  });
  $('quality').value = settings.quality;
  syncRangeFill();
  $('qualityOut').textContent = `${settings.quality}%`;
  $('qualityGroup').classList.toggle('px-dim', lossless || settings.format === 'png');
  $('resizeMode').value = settings.resizeMode;
  document.querySelectorAll('.px-sub').forEach(el => { el.hidden = el.dataset.for !== settings.resizeMode; });
  $('fbTip').hidden = settings.resizeMode !== 'fb';
  $('aiWhiteBg').checked = settings.aiWhiteBg;
  $('maxSide').value = settings.maxSide;
  $('percent').value = settings.percent;
  $('exactW').value = settings.exactW;
  $('exactH').value = settings.exactH;
  $('exactH').disabled = settings.keepRatio;
  $('keepRatio').checked = settings.keepRatio;

  $('presets').querySelectorAll('.px-preset').forEach(b => {
    const p = PRESETS[b.dataset.p];
    const on = Object.entries(p).every(([k, v]) => settings[k] === v);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function syncRangeFill() {
  const el = $('quality');
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--fill', `${pct}%`);
}

let debounce = null;
function changeSettings(patch, delay = 250) {
  Object.assign(settings, patch);
  if (settings.format === 'avif' && !encoders.avif) settings.format = 'webp';
  saveSettings();
  syncSettingsUI();
  clearTimeout(debounce);
  debounce = setTimeout(() => items.length && enqueue([...items]), delay);
}

function bindSettings() {
  $('privacySeg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) changeSettings({ privacy: b.dataset.v }, 0);
  });
  $('noiseSeg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) changeSettings({ noise: b.dataset.v }, 0);
  });
  $('presets').addEventListener('click', e => {
    const b = e.target.closest('.px-preset');
    if (b) changeSettings({ ...PRESETS[b.dataset.p] }, 0);
  });
  $('fmtSeg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b && !b.disabled) changeSettings({ format: b.dataset.v }, 0);
  });
  $('quality').addEventListener('input', e => {
    $('qualityOut').textContent = `${e.target.value}%`;
    syncRangeFill();
    changeSettings({ quality: Number(e.target.value) }, 350);
  });
  $('resizeMode').addEventListener('change', e => changeSettings({ resizeMode: e.target.value }, 0));
  const num = (id, key, min, max) => $(id).addEventListener('change', e => {
    const v = Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min)));
    changeSettings({ [key]: v });
  });
  num('maxSide', 'maxSide', 16, 16000);
  num('percent', 'percent', 1, 100);
  num('exactW', 'exactW', 1, 16000);
  num('exactH', 'exactH', 1, 16000);
  $('keepRatio').addEventListener('change', e => changeSettings({ keepRatio: e.target.checked }));
}

/* ---------------- Downloads ---------------- */

function outName(it) {
  return `${baseName(it.name)}-${it.result.visa ? 'visa' : 'pixpress'}.${it.result.ext}`;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadOne(it) {
  if (!it || it.status !== 'done') return toast('Ảnh chưa xử lý xong.', 'info');
  downloadBlob(it.result.blob, outName(it));
}

async function downloadZip() {
  const done = items.filter(i => i.status === 'done');
  if (!done.length) return;
  const btn = $('zipBtn');
  btn.disabled = true;
  try {
    const zip = new JSZip();
    const used = new Set();
    for (const it of done) {
      let name = outName(it);
      for (let n = 2; used.has(name); n++) name = `${baseName(it.name)}-pixpress-${n}.${it.result.ext}`;
      used.add(name);
      zip.file(name, it.result.blob);
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    downloadBlob(blob, 'pixpress-images.zip');
    toast(`Đã đóng gói ${done.length} ảnh.`);
  } catch {
    toast('Không tạo được file .zip.', 'error');
  } finally {
    updateSummary();
  }
}

/* ---------------- Compare modal ---------------- */

let cmpBeforeUrl = null;

async function openCompare() {
  const it = active;
  if (!it || it.status !== 'done') return toast('Ảnh chưa xử lý xong.', 'info');
  const { canvas } = render(it.bitmap, it.edit, engineOptions());
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (cmpBeforeUrl) URL.revokeObjectURL(cmpBeforeUrl);
  cmpBeforeUrl = URL.createObjectURL(blob);
  $('cmpBefore').src = cmpBeforeUrl;
  $('cmpAfter').src = it.url;
  const r = it.result;
  $('cmpSub').textContent = `${r.w}×${r.h} · ${fmtBytes(r.origSize)} → ${fmtBytes(r.newSize)} (${pctText(r.deltaPct)}) · chất lượng ${qualityGrade(r.ssim).score ?? '—'}/100`;
  $('cmpBox').style.aspectRatio = `${r.w} / ${r.h}`;
  setSplit(50);
  $('cmpModal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('cmpHandle').focus();
}

function closeCompare() {
  $('cmpModal').hidden = true;
  document.body.style.overflow = '';
  $('compareBtn').focus();
}

let split = 50;
function setSplit(p) {
  split = Math.min(100, Math.max(0, p));
  $('cmpAfterWrap').style.clipPath = `inset(0 0 0 ${split}%)`;
  $('cmpHandle').style.left = `${split}%`;
  $('cmpHandle').setAttribute('aria-valuenow', String(Math.round(split)));
}

function bindCompare() {
  const box = $('cmpBox');
  const handle = $('cmpHandle');
  handle.tabIndex = 0;
  handle.setAttribute('role', 'slider');
  handle.setAttribute('aria-label', 'Vị trí so sánh');
  handle.setAttribute('aria-valuemin', '0');
  handle.setAttribute('aria-valuemax', '100');
  let dragging = false;
  const move = e => {
    const rect = box.getBoundingClientRect();
    setSplit(((e.clientX - rect.left) / rect.width) * 100);
  };
  box.addEventListener('pointerdown', e => { dragging = true; box.setPointerCapture(e.pointerId); move(e); });
  box.addEventListener('pointermove', e => dragging && move(e));
  box.addEventListener('pointerup', () => { dragging = false; });
  handle.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { setSplit(split - 5); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setSplit(split + 5); e.preventDefault(); }
  });
  $('cmpClose').addEventListener('click', closeCompare);
  $('cmpModal').addEventListener('click', e => { if (e.target.id === 'cmpModal') closeCompare(); });
}

/* ---------------- Wiring ---------------- */

function bindInput() {
  const drop = $('drop');
  const input = $('fileInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => {
    e.preventDefault();
    if (t === 'drop' || !e.relatedTarget) drop.classList.remove('over');
  }));
  document.addEventListener('drop', e => e.dataTransfer?.files?.length && addFiles(e.dataTransfer.files));
  document.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
}

function bindTools() {
  $('cropBtn').addEventListener('click', () => (cropping ? exitCrop(true) : enterCrop()));
  $('rotLBtn').addEventListener('click', () => rotate(false));
  $('rotRBtn').addEventListener('click', () => rotate(true));
  $('flipBtn').addEventListener('click', flip);
  $('compareBtn').addEventListener('click', openCompare);
  $('dlOneBtn').addEventListener('click', () => downloadOne(active));
  $('addMoreBtn').addEventListener('click', () => $('fileInput').click());
  $('removeOneBtn').addEventListener('click', () => active && removeItem(active));
  $('cropApply').addEventListener('click', () => exitCrop(true));
  $('cropCancel').addEventListener('click', () => exitCrop(false));
  $('cropReset').addEventListener('click', () => {
    $('aspectChips').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.a === 'free'));
    cropper.reset();
  });
  $('aspectChips').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !active) return;
    $('aspectChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    cropper.setAspect(aspectValue(b.dataset.a, realOriented(active)));
  });
  $('redactBtn').addEventListener('click', () => (redacting ? exitRedact(true) : enterRedact()));
  $('redactApply').addEventListener('click', () => exitRedact(true));
  $('redactCancel').addEventListener('click', () => exitRedact(false));
  $('redactUndo').addEventListener('click', () => redactor?.undo());
  $('redactClear').addEventListener('click', () => redactor?.clear());
  for (const [id, key] of [['redactToolSeg', 'tool'], ['redactEffectSeg', 'effect']]) {
    $(id).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      redactTool[key] = b.dataset.v;
      syncRedactBar();
    });
  }
  $('brushSize').addEventListener('input', e => { redactTool.brush = Number(e.target.value) / 1000; });
  $('collageBtn').addEventListener('click', async () => {
    // Ghép cần ảnh đã giải mã; giải mã những ảnh còn đang chờ.
    await Promise.all(items.filter(it => !it.bitmap).map(it => loadBitmap(it).catch(() => {})));
    const ok = openCollage(items, file => addFiles([file], { select: true }));
    if (!ok) toast('Cần ít nhất 2 ảnh để ghép.', 'info');
  });
  $('aspectChips').addEventListener('click', syncFaceGuide);
  $('aiAlignBtn').addEventListener('click', alignFace);
  $('aiFacesBtn').addEventListener('click', blurFaces);
  $('aiWhiteBg').addEventListener('change', e => changeSettings({ aiWhiteBg: e.target.checked }, 0));
  $('zipBtn').addEventListener('click', downloadZip);
  $('clearBtn').addEventListener('click', clearAll);

  document.addEventListener('keydown', e => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (!$('cmpModal').hidden) { if (e.key === 'Escape') closeCompare(); return; }
    if (redacting && e.key === 'Escape') return exitRedact(false);
    if (redacting && e.key === 'Enter') return exitRedact(true);
    if (cropping && e.key === 'Escape') return exitCrop(false);
    if (!cropping && !redacting && active && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); return removeItem(active); }
    if (cropping && e.key === 'Enter') return exitCrop(true);
    if (!active || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === 'c' || e.key === 'C') && mode !== 'redact') cropping ? exitCrop(true) : enterCrop();
    if ((e.key === 'b' || e.key === 'B') && mode === 'redact') redacting ? exitRedact(true) : enterRedact();
  });
}

const MODE_COPY = {
  edit: {
    title: 'Nén, resize và cắt ảnh — vừa khít mọi nơi',
    lead: 'Giảm dung lượng, đổi định dạng, cắt theo tỷ lệ, xuất đúng chuẩn <strong>Facebook HD 2048&nbsp;px</strong> và xóa sạch metadata cùng dấu vết AI. Nhận cả ảnh <strong>HEIC của iPhone</strong>. Mọi xử lý diễn ra ngay trên trình duyệt của bạn.',
    drop: 'Kéo thả ảnh vào đây'
  },
  visa: {
    title: 'Ảnh thẻ visa Việt Nam 4×6 — đúng chuẩn evisa',
    lead: 'Tải ảnh chân dung lên: AI tự căn <strong>mắt đúng vạch 2/3</strong>, đổi <strong>nền trắng</strong>, kiểm tra nhìn thẳng, mắt mở, rồi xuất <strong>JPG 600×900&nbsp;px ≤ 2&nbsp;MB</strong>. Ảnh không rời máy bạn.',
    drop: 'Kéo thả ảnh chân dung vào đây'
  },
  redact: {
    title: 'Che thông tin nhạy cảm trước khi chia sẻ',
    lead: 'Làm mờ, làm pixel hoặc tô đen <strong>CCCD, biển số, số điện thoại, khuôn mặt</strong> bằng khung, elip hay cọ tô. AI tìm và che mọi khuôn mặt chỉ với một chạm. Ảnh không rời máy bạn.',
    drop: 'Kéo thả ảnh cần che vào đây'
  }
};

function setMode(next, { initial = false } = {}) {
  if (!MODE_COPY[next]) next = 'edit';
  if (!initial && next === mode) return;
  if (cropping) exitCrop(true);
  if (redacting) exitRedact(true);
  mode = next;
  for (const m of Object.keys(MODES)) document.body.classList.toggle(`px-mode-${m}`, m === mode);
  $('modeTabs').querySelectorAll('[role="tab"]').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const copy = MODE_COPY[mode];
  $('heroTitle').textContent = copy.title;
  $('heroLead').innerHTML = copy.lead;
  $('dropTitle').textContent = copy.drop;
  $('cropBtn').dataset.tip = mode === 'visa' ? 'Căn khung 4×6 · C' : 'Cắt · C';
  $('cropBtn').setAttribute('aria-label', mode === 'visa' ? 'Căn khung ảnh visa 4×6' : 'Cắt ảnh');
  if (!initial) {
    history.replaceState(null, '', MODES[mode] ? `#${MODES[mode]}` : location.pathname + location.search);
    syncSettingsUI();
    if (items.length) enqueue([...items]);
    openModeTool();
  }
}

function bindModes() {
  const tabs = [...$('modeTabs').querySelectorAll('[role="tab"]')];
  $('modeTabs').addEventListener('click', e => {
    const b = e.target.closest('[role="tab"]');
    if (b) setMode(b.dataset.mode);
  });
  $('modeTabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = tabs.findIndex(b => b.dataset.mode === mode);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setMode(next.dataset.mode);
    next.focus();
  });
  window.addEventListener('hashchange', () => setMode(Object.keys(MODES).find(m => MODES[m] && `#${MODES[m]}` === location.hash) || 'edit'));
}

async function init() {
  encoders = await detectEncoders();
  const avifBtn = $('fmtSeg').querySelector('[data-v="avif"]');
  if (!encoders.avif) {
    avifBtn.disabled = true;
    avifBtn.title = 'Trình duyệt này chưa hỗ trợ xuất AVIF (dùng Safari 17+ hoặc Firefox mới).';
    if (settings.format === 'avif') settings.format = 'webp';
  }
  if (!encoders.webp) {
    const b = $('fmtSeg').querySelector('[data-v="webp"]');
    b.disabled = true;
    if (settings.format === 'webp') settings.format = 'jpeg';
  }
  setMode(mode, { initial: true });
  syncSettingsUI();
  bindSettings();
  bindModes();
  bindInput();
  bindTools();
  bindCompare();
}

init();
