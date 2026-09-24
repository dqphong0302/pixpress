/**
 * AI chạy ngay trên máy người dùng (MediaPipe Tasks Vision, Apache-2.0). Ảnh không rời trình duyệt.
 * Bộ chạy WASM (~11 MB) và mô hình được phục vụ từ chính PixPress, chỉ tải ở lần đầu dùng tính năng AI.
 *  - findFaces:   tìm mọi khuôn mặt (che mặt một chạm)
 *  - analyzeFace: điểm mốc khuôn mặt → căn khung visa, kiểm tra số mặt, hướng nhìn, mắt mở
 *  - personMask:  tách người khỏi nền → đổi nền trắng cho ảnh visa
 */

const asset = p => new URL(p, document.baseURI).href;
const MODELS = {
  detector: asset('models/blaze_face_short_range.tflite'),
  landmarker: asset('models/face_landmarker.task'),
  segmenter: asset('models/selfie_segmenter.tflite')
};

let visionP = null;
const tasks = {};

function vision() {
  visionP ??= (async () => {
    const mp = await import('@mediapipe/tasks-vision');
    const files = await mp.FilesetResolver.forVisionTasks(asset('mediapipe/wasm'));
    return { mp, files };
  })().catch(err => { visionP = null; throw err; });
  return visionP;
}

/** Tạo task một lần; CPU cho ổn định trên mọi máy (GPU delegate hay lỗi trên trình duyệt cũ). */
function task(name, create) {
  tasks[name] ??= vision().then(({ mp, files }) => create(mp, files)).catch(err => { delete tasks[name]; throw err; });
  return tasks[name];
}

/** Thu nhỏ để AI chạy nhanh; tọa độ trả về dạng tỷ lệ 0..1 nên không phụ thuộc kích thước. */
function downscale(src, maxSide) {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (k === 1) return src;
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * k);
  c.height = Math.round(src.height * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function crop(src, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

/* ---------------- Tìm khuôn mặt ---------------- */

/**
 * Mô hình "short range" nhìn ảnh ở 128 px nên bỏ sót mặt nhỏ (ảnh lớp học, sự kiện).
 * Vì vậy quét cả ảnh + các ô cố định 960/640/420/280 px chồng lấn 35% (mặt đủ lớn trong từng ô), rồi gộp trùng.
 * @returns {Promise<Array<{x,y,w,h,score}>>} tỷ lệ 0..1 trên ảnh đưa vào
 */
export async function findFaces(image) {
  const detector = await task('detector', (mp, files) => mp.FaceDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODELS.detector, delegate: 'CPU' },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.7
  }));
  const src = downscale(image, 2400);
  const W = src.width, H = src.height;
  const found = [];
  const run = (canvas, ox, oy, minScore = 0.7) => {
    for (const d of detector.detect(canvas).detections) {
      const b = d.boundingBox;
      if ((d.categories[0]?.score ?? 0) < minScore) continue;
      found.push({ x: (ox + b.originX) / W, y: (oy + b.originY) / H, w: b.width / W, h: b.height / H, score: d.categories[0]?.score ?? 0 });
    }
  };
  run(src, 0, 0);
  for (const size of [960, 640, 420, 280]) {
    if (size >= Math.max(W, H)) continue;
    const tw = Math.min(size, W), th = Math.min(size, H);
    const stride = Math.round(size * 0.65);
    for (let y = 0; ; y += stride) {
      const yy = Math.min(y, H - th);
      for (let x = 0; ; x += stride) {
        const xx = Math.min(x, W - tw);
        // Ô nhỏ dễ báo nhầm (mắt, hoa văn…) nên đòi độ tin cậy cao hơn.
        run(crop(src, xx, yy, tw, th), xx, yy, size <= 280 ? 0.8 : size <= 420 ? 0.75 : 0.7);
        if (xx >= W - tw) break;
      }
      if (yy >= H - th) break;
    }
  }
  // Gộp trùng (NMS): giữ khung điểm cao nhất.
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  const overlaps = (k, f) => iou(k, f) > 0.3
    || (Math.abs(k.x + k.w / 2 - f.x - f.w / 2) < Math.max(k.w, f.w) / 2 && Math.abs(k.y + k.h / 2 - f.y - f.h / 2) < Math.max(k.h, f.h) / 2);
  for (const f of found) if (!kept.some(k => overlaps(k, f))) kept.push(f);
  return kept;
}

/* ---------------- Phân tích khuôn mặt (visa) ---------------- */

const deg = r => (r * 180) / Math.PI;

/**
 * @returns {Promise<null | {faces:number, eyes:{x,y}, chin:{x,y}, eyeDist:number, yaw:number, pitch:number, roll:number, eyesOpen:boolean}>}
 *   tọa độ tỷ lệ 0..1; góc tính bằng độ
 */
export async function analyzeFace(image) {
  const lm = await task('landmarker', (mp, files) => mp.FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODELS.landmarker, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 3,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true
  }));
  const src = downscale(image, 1280);
  const r = lm.detect(src);
  if (!r.faceLandmarks.length) return null;
  // Chọn mặt lớn nhất làm chủ thể.
  const size = pts => Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));
  let best = 0;
  r.faceLandmarks.forEach((pts, i) => { if (size(pts) > size(r.faceLandmarks[best])) best = i; });
  const P = r.faceLandmarks[best];
  const aspect = src.width / src.height;
  // 468/473: tâm mống mắt; 152: cằm.
  const L = P[468], R = P[473];
  const eyes = { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 };
  const roll = deg(Math.atan2((R.y - L.y), (R.x - L.x) * aspect));
  let yaw = 0, pitch = 0;
  const m = r.facialTransformationMatrixes?.[best]?.data;
  if (m) {
    // Ma trận 4×4 lưu theo cột: r20 = m[2], r21 = m[6], r22 = m[10].
    pitch = deg(Math.atan2(m[6], m[10]));
    yaw = deg(Math.atan2(-m[2], Math.hypot(m[6], m[10])));
  }
  const shapes = Object.fromEntries((r.faceBlendshapes?.[best]?.categories || []).map(c => [c.categoryName, c.score]));
  const eyesOpen = (shapes.eyeBlinkLeft ?? 0) < 0.5 && (shapes.eyeBlinkRight ?? 0) < 0.5;
  return {
    faces: r.faceLandmarks.length,
    eyes,
    chin: { x: P[152].x, y: P[152].y },
    eyeDist: Math.hypot((R.x - L.x) * aspect, R.y - L.y),
    yaw: Math.round(yaw),
    pitch: Math.round(pitch),
    roll: Math.round(roll),
    eyesOpen
  };
}

/* ---------------- Tách người khỏi nền ---------------- */

/**
 * Mặt nạ người (độ tin cậy 0..1 → kênh alpha), kích thước bằng ảnh đầu vào đã thu nhỏ; phóng lên khi dùng.
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function personMask(image) {
  const seg = await task('segmenter', (mp, files) => mp.ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODELS.segmenter, delegate: 'CPU' },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
    outputCategoryMask: false
  }));
  const src = downscale(image, 1024);
  return new Promise((resolve, reject) => {
    seg.segment(src, result => {
      try {
        const mask = result.confidenceMasks[0];
        const data = mask.getAsFloat32Array();
        const c = document.createElement('canvas');
        c.width = mask.width;
        c.height = mask.height;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(c.width, c.height);
        for (let i = 0; i < data.length; i++) {
          // Làm gắt vùng chuyển tiếp để mép tóc/vai gọn, không lem nền cũ.
          const a = Math.min(1, Math.max(0, (data[i] - 0.25) / 0.5));
          img.data[i * 4 + 3] = Math.round(a * 255);
        }
        ctx.putImageData(img, 0, 0);
        resolve(c);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Đặt người lên nền trắng (sửa canvas tại chỗ). */
export function whitenBackground(canvas, mask) {
  const W = canvas.width, H = canvas.height;
  const person = document.createElement('canvas');
  person.width = W;
  person.height = H;
  const p = person.getContext('2d');
  p.drawImage(canvas, 0, 0);
  p.globalCompositeOperation = 'destination-in';
  p.imageSmoothingEnabled = true;
  p.imageSmoothingQuality = 'high';
  p.drawImage(mask, 0, 0, W, H);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(person, 0, 0);
  ctx.restore();
  return canvas;
}

/**
 * Khung cắt 4×6: mắt đúng vạch 2/3 (1/3 từ trên), mặt ở giữa, cằm ở ~62% chiều cao.
 * Nếu ảnh chụp quá sát không đủ chỗ, thu nhỏ khung (mặt to hơn gợi ý) chứ không dời mắt khỏi vạch.
 */
export function visaCrop(face, imgW, imgH, ratio = 2 / 3) {
  const eyeY = face.eyes.y * imgH, eyeX = face.eyes.x * imgW, chinY = face.chin.y * imgH;
  const ideal = (chinY - eyeY) / (0.62 - 1 / 3);
  // Giới hạn để khung nằm trọn trong ảnh khi mắt cố định ở 1/3 chiều cao và ở giữa bề ngang.
  const h = Math.min(ideal, eyeY * 3, (imgH - eyeY) * 1.5, (2 * Math.min(eyeX, imgW - eyeX)) / ratio);
  const w = h * ratio;
  return {
    x: (eyeX - w / 2) / imgW,
    y: (eyeY - h / 3) / imgH,
    w: w / imgW,
    h: h / imgH,
    aspect: ratio,
    fitted: h < ideal * 0.97 // ảnh chụp quá sát: mặt sẽ chiếm nhiều hơn khung gợi ý
  };
}
