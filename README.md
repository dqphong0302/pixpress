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
| 🛡️ **ClearMode** — Metadata & AI | Phát hiện rồi xóa EXIF, GPS, thiết bị, C2PA/Content Credentials, prompt AI (Midjourney, Stable Diffusion, ComfyUI…). 3 chế độ: *Xóa sạch*, *Khử watermark AI* (thêm nhiễu Gauss σ≈1.5 phá watermark ẩn kiểu SynthID), *Chỉ xóa* (gỡ metadata trên byte, không nén lại — JPEG/PNG/WebP, giữ hồ sơ màu ICC) |
| 📱 **Ảnh iPhone** | Nhận HEIC/HEIF; Safari giải mã sẵn, Chrome/Firefox dùng libheif (WASM, `heic-to`) chỉ tải khi gặp ảnh HEIC |
| 🔬 **QualityScore** | Đo **SSIM** (thang 0–100) và **PSNR** (dB) giữa ảnh trước và sau nén, kèm nhận xét dễ hiểu |

Ngoài ra: xử lý hàng loạt (≤ 30 ảnh, ≤ 50 MB/ảnh), dán ảnh bằng `Ctrl+V`, so sánh Trước/Sau bằng thanh trượt, tải từng ảnh hoặc cả lô `.zip`, sáng/tối đồng bộ `pd_theme`.

Phím tắt: `C` bật/tắt cắt · `Enter` áp dụng · `Esc` hủy · phím mũi tên di chuyển khung cắt (giữ `Shift` để đi nhanh).

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
│   └── heic.js         # Giải mã HEIC iPhone (tải khi cần)
├── public/_headers     # Header cho Cloudflare static assets
├── vendor/pdui/        # PhongDang UI
└── wrangler.jsonc
```

## 👨‍🏫 Tác giả

ThS. Đặng Quốc Phong — [phongdang.io.vn](https://phongdang.io.vn) · Giấy phép [MIT](LICENSE).
