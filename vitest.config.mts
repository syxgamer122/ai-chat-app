import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /* Dọn env backend tìm kiếm trước mỗi file — nếu không, key thật trên máy
       dev đổi thứ tự engine và làm test đỏ (xem tests/setup-env.ts). */
    setupFiles: ['./tests/setup-env.ts'],
  },
});
