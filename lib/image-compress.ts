/**
 * Nén ảnh client-side trước khi đính kèm — giải quyết vấn đề trần 3MB:
 * ảnh chụp điện thoại thường 3-5MB trong khi LLM chỉ cần ~1-2MP để đọc nội
 * dung. Canvas resize về tối đa MAX_IMAGE_DIMENSION px + mã hóa WebP chất
 * lượng 0.85 → ảnh đầu ra hầu như luôn dưới vài trăm KB, giữ được chữ/số
 * đủ rõ cho cả native vision lẫn vision bridge.
 *
 * Chỉ chạy ở browser (createImageBitmap + canvas). GIF bỏ qua để không mất
 * animation; file nhỏ hơn ngưỡng giữ nguyên để tránh re-encode oan.
 */

export const COMPRESS_THRESHOLD_BYTES = 512 * 1024;
export const MAX_IMAGE_DIMENSION = 2048;
const TARGET_QUALITY = 0.85;

/** Quyết định có nên nén — thuần, test được ở node. */
export function shouldCompressFile(sizeBytes: number, mimeType: string): boolean {
  if (!mimeType.startsWith('image/')) return false;
  if (mimeType === 'image/gif') return false; // canvas mất animation
  return sizeBytes > COMPRESS_THRESHOLD_BYTES;
}

/**
 * Kích thước đích giữ tỷ lệ khung hình, cạnh dài ≤ maxDim.
 * Trả null khi không cần thu nhỏ (đã vừa) — caller giữ nguyên bitmap.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxDim = MAX_IMAGE_DIMENSION,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (width <= maxDim && height <= maxDim) return null;
  const scale = maxDim / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, TARGET_QUALITY));
}

/**
 * Nén một File ảnh. Trả file gốc khi: không phải ảnh nén được, quá nhỏ,
 * decode lỗi, hoặc bản nén lại to hơn bản gốc (ảnh đã tối ưu sẵn).
 */
export async function compressImageFile(file: File): Promise<File> {
  if (!shouldCompressFile(file.size, file.type)) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // ảnh hỏng/codec lạ → giữ nguyên, upstream tự báo lỗi nếu có
  }

  try {
    const dims = targetDimensions(bitmap.width, bitmap.height);
    const w = dims?.width ?? bitmap.width;
    const h = dims?.height ?? bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    // WebP nén chặt hơn JPEG ~25-30% và hỗ trợ phổ biến trên mọi browser
    // hiện đại; một số engine cũ từ chối → fallback JPEG.
    let blob = await canvasToBlob(canvas, 'image/webp');
    if (!blob || blob.type !== 'image/webp') {
      blob = await canvasToBlob(canvas, 'image/jpeg');
    }
    if (!blob || blob.size >= file.size) return file;

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], `${baseName}.${ext}`, {
      type: blob.type,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

/** Nén nhiều file song song — dùng ngay tại chỗ thêm attachment. */
export async function compressImageFiles(files: readonly File[]): Promise<File[]> {
  return Promise.all(files.map((f) => compressImageFile(f)));
}
