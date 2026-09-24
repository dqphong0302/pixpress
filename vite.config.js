import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Tự phục vụ bộ chạy MediaPipe (WASM) từ chính tên miền PixPress thay vì CDN:
 * ảnh và mô hình AI không bao giờ đi qua máy chủ bên thứ ba. File chỉ được tải khi người dùng bấm tính năng AI.
 */
const WASM_DIR = path.resolve('node_modules/@mediapipe/tasks-vision/wasm');
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'];

function mediapipeWasm() {
  return {
    name: 'pixpress-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe/wasm', (req, res, next) => {
        const name = path.basename(req.url.split('?')[0]);
        if (!WASM_FILES.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(path.join(WASM_DIR, name)));
      });
    },
    generateBundle() {
      for (const name of WASM_FILES) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/wasm/${name}`, source: readFileSync(path.join(WASM_DIR, name)) });
      }
    }
  };
}

export default defineConfig({
  plugins: [mediapipeWasm()],
  build: {
    // heic-to và MediaPipe là chunk lớn nhưng chỉ tải khi cần.
    chunkSizeWarningLimit: 3500
  }
});
