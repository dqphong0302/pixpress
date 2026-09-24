# PixPress — Nén · Đổi định dạng · Resize · Cắt ảnh · Xóa metadata AI

> Hợp nhất tính năng của **ClearShot** (xóa metadata & dấu vết AI) từ 2026-09-24.

> UI nền tảng: **PhongDang UI (PDUI) v1.6.0** · profile `tool` · triển khai trên **Cloudflare Workers (Static Assets)**.

**PixPress** làm cho ảnh "vừa khít" mọi nơi: nhẹ hơn, đúng kích thước, vẫn nét. Mọi xử lý diễn ra 100% trong trình duyệt, ảnh không bao giờ được tải lên máy chủ.

## ✨ Tính năng

| Tên tính năng | Chức năng |
|---|---|
| 🗜️ **SlimMode** — Nén | Giảm dung lượng, báo **% giảm** cho từng ảnh và tổng cả lô |
| 🔁 **SwapMode** — Đổi định dạng | JPG ⇄ PNG ⇄ WebP ⇄ AVIF (AVIF khi trình duyệt hỗ trợ), hoặc giữ định dạng gốc |
| 📐 **FitMode** — Resize | Cạnh dài tối đa, theo %, hoặc Rộng × Cao chính xác (có khóa tỷ lệ) |
| 📘 **FB-HD 2048** | Một chạm: cạnh dài ≤ 2048 px, JPG 92% — cỡ Facebook giữ nét, không nén lại |
| ✂️ **CropMode** — Cắt ảnh | Kéo thả khung cắt, tỷ lệ Tự do / Gốc / 1:1 / 4:5 / 16:9 / 9:16 / 3:2 / 3:4 / 1.91:1, xoay 90°, lật ngang |
| 🛡️ **ClearMode** — Metadata & AI | Phát hiện rồi xóa EXIF, GPS, thiết bị, C2PA/Content Credentials, prompt AI (Midjourney, Stable Diffusion, ComfyUI…). 3 chế độ: *Xóa + nén*, *Chỉ xóa* (gỡ metadata trên byte, không nén lại — JPEG/PNG/WebP, giữ hồ sơ màu ICC), *Chống AI* (thêm nhiễu Gauss Nhẹ/Vừa/Mạnh phá watermark ẩn kiểu SynthID) |
| 📱 **Ảnh iPhone** | Nhận HEIC/HEIF; Safari giải mã sẵn, Chrome/Firefox dùng libheif (WASM, `heic-to`) chỉ tải khi gặp ảnh HEIC |
| 🙈 **Che vùng nhạy cảm** | Vẽ hình chữ nhật, elip hoặc tô cọ; hiệu ứng làm mờ, pixel hóa hoặc tô đen; áp trên ảnh gốc độ phân giải đầy đủ, xoay/lật theo ảnh (phím `B`) |
| 🪪 **Ảnh visa Việt Nam** | Theo evisa.gov.vn: 4×6 cm, JPG/JPEG, ≤ 2 MB, nền trắng, nhìn thẳng, không mũ, không kính. Xuất 600×900 px, khung cắt có hướng dẫn vị trí mặt, tự kiểm tra nền trắng |
| 🧩 **Ghép ảnh** | 12 bố cục sẵn (lưới, 1 lớn + nhỏ, dải dọc) hoặc tự do; kéo để căn/đổi chỗ, cuộn để phóng; tỷ lệ khung, khoảng cách, lề, bo góc, màu nền; ảnh ghép quay lại hàng đợi để nén như ảnh thường |
| ✨ **AI trên máy** | MediaPipe Tasks Vision (Apache-2.0), chạy trong trình duyệt, ảnh không rời máy: *Tự căn mặt* ảnh visa (mắt đúng vạch 2/3, mặt giữa khung), *kiểm tra* một khuôn mặt / nhìn thẳng / mắt mở, *đổi nền trắng* (tách người), *tìm & che mọi khuôn mặt* một chạm. Bộ chạy WASM và mô hình được phục vụ từ chính PixPress (`/mediapipe/wasm`, `/models`), chỉ tải ở lần đầu dùng AI (~4–8 MB nén) |
| 🔬 **QualityScore** | Đo **SSIM** (thang 0–100) và **PSNR** (dB) giữa ảnh trước và sau nén, kèm nhận xét dễ hiểu |

Ngoài ra: xử lý hàng loạt (≤ 30 ảnh, ≤ 50 MB/ảnh), dán ảnh bằng `Ctrl+V`, so sánh Trước/Sau bằng thanh trượt, tải từng ảnh hoặc cả lô `.zip`, sáng/tối đồng bộ `pd_theme`.

Phím tắt: `C` bật/tắt cắt · `B` che vùng · `Enter` áp dụng · `Esc` hủy · phím mũi tên di chuyển khung cắt (giữ `Shift` để đi nhanh).

## 🧠 Cách hoạt động

```
File → createImageBitmap (tự xoay theo EXIF) → xoay/lật → cắt → thu nhỏ từng nấc ×0.5 (chống răng cưa)
     → canvas.toBlob(JPG/WebP/AVIF/PNG, quality) → giải mã lại → so SSIM/PSNR với ảnh chưa nén
```

- Không bao giờ phóng to ảnh ở các chế độ "cạnh dài tối đa" / FB-HD.
- JPG được lót nền trắng cho vùng trong suốt.
- Metadata (EXIF/GPS) bị loại bỏ tự nhiên khi mã hóa lại qua canvas.
- Chất lượng đo trên tối đa 4 megapixel để giữ tốc độ.

## 🚀 Chạy & triển khai

```bash
cd PixPress
npm install
npm run dev        # http://localhost:5173
npm run build      # xuất ra dist/
npm run deploy     # build + wrangler deploy lên Cloudflare Workers
```

Lần đầu deploy cần `npx wrangler login`. Để gắn tên miền (ví dụ `pixpress.phongdang.io.vn`), thêm vào `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "pixpress.phongdang.io.vn", "custom_domain": true }]
```

Header bảo mật và cache cho `/assets/*` nằm trong `public/_headers`.

## 📁 Cấu trúc

```
PixPress/
├── index.html          # Giao diện
├── css/app.css         # Style riêng (trên nền PDUI)
├── src/
│   ├── main.js         # Điều khiển UI, hàng đợi, tải về, so sánh
│   ├── engine.js       # Giải mã, xoay/lật, cắt, resize, mã hóa
│   ├── quality.js      # SSIM / PSNR + nhãn chất lượng
│   ├── crop.js         # Khung cắt kéo-thả
│   ├── metadata.js     # Phát hiện/xóa metadata & dấu vết AI (từ ClearShot)
│   ├── redact.js       # Che vùng nhạy cảm (vẽ + áp hiệu ứng)
│   ├── collage.js      # Ghép ảnh
│   ├── ai.js           # AI trên máy: tìm mặt, phân tích mặt, tách nền (MediaPipe)
│   └── heic.js         # Giải mã HEIC iPhone (tải khi cần)
├── public/_headers     # Header cho Cloudflare static assets
├── public/models/      # Mô hình AI (.tflite/.task) của MediaPipe
├── vite.config.js      # Đưa bộ chạy MediaPipe WASM vào bản build
├── vendor/pdui/        # PhongDang UI
└── wrangler.jsonc
```

## 👨‍🏫 Tác giả

ThS. Đặng Quốc Phong — [phongdang.io.vn](https://phongdang.io.vn) · Giấy phép [MIT](LICENSE).
