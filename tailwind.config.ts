import type { Config } from 'tailwindcss'
import defaultTheme from 'tailwindcss/defaultTheme'

/**
 * Ramp zinc dẫn qua CSS variables (`--zinc-*` trong globals.css).
 * Class sẵn có (`text-zinc-800`, `hover:bg-zinc-100`...) nhờ đó tự thích
 * ứng cả hai theme mà không phải sửa từng component: giá trị biến bị LẬT
 * bậc trong theme tối (zinc-100 sáng ↔ nền tối) để giữ đúng vai trò
 * "nền nhạt / chữ đậm" thay vì đúng mã hex gốc.
 */
const zincRamp = (suffix = '') =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [
      step,
      `rgb(var(--zinc-${step}${suffix}) / <alpha-value>)`,
    ]),
  )

/**
 * Design tokens dùng chung. Màu khai báo dạng channel RGB trong globals.css
 * (`--brand: 10 126 140`) để Tailwind vẫn áp dụng được modifier opacity
 * (`bg-brand/20`) mà CSS thuần cũng dùng lại được cùng một biến.
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        /** Thang xám chủ đạo — theo theme qua --zinc-*. */
        zinc: zincRamp(),
        /** Canvas & các mặt phẳng nổi. */
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          bubble: 'rgb(var(--surface-bubble) / <alpha-value>)',
          muted: 'rgb(var(--surface-muted) / <alpha-value>)',
          code: 'rgb(var(--surface-code) / <alpha-value>)',
          'code-header': 'rgb(var(--surface-code-header) / <alpha-value>)',
        },
        /** Thương hiệu KODA. */
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          hover: 'rgb(var(--brand-hover) / <alpha-value>)',
          accent: 'rgb(var(--brand-accent) / <alpha-value>)',
          border: 'rgb(var(--brand-border) / <alpha-value>)',
        },
        foreground: {
          DEFAULT: 'rgb(var(--foreground) / <alpha-value>)',
          strong: 'rgb(var(--foreground-strong) / <alpha-value>)',
          muted: 'rgb(var(--muted-foreground) / <alpha-value>)',
        },
        /** Đường kẻ dùng chung (bảng, hr, viền panel nhạt). */
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
        aurora: {
          from: 'rgb(var(--aurora-from) / <alpha-value>)',
          via: 'rgb(var(--aurora-via) / <alpha-value>)',
          to: 'rgb(var(--aurora-to) / <alpha-value>)',
          accent: 'rgb(var(--aurora-accent) / <alpha-value>)',
        },
      },
      boxShadow: {
        /** Nút/chip mang màu thương hiệu. */
        brand: '0 4px 16px -6px rgb(var(--brand) / 0.6)',
        'brand-lg': '0 8px 32px -8px rgb(var(--brand) / 0.35)',
        /** Panel nổi (dropdown, menu, dialog). */
        panel: '0 12px 32px -16px rgb(15 23 42 / 0.18)',
        card: '0 8px 24px -12px rgb(15 23 42 / 0.18)',
      },
      fontFamily: {
        /*
         * `next/font` chỉ tạo biến `--font-sans`; nếu không map vào đây thì
         * `font-sans` của Tailwind vẫn là font hệ thống và Inter (đã tải kèm
         * subset tiếng Việt) không bao giờ được dùng.
         */
        sans: ['var(--font-sans)', ...defaultTheme.fontFamily.sans],
      },
      maxWidth: {
        /** Chiều rộng cột hội thoại — dùng chung cho message list & composer. */
        thread: '48rem',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.94)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'pop-in': 'pop-in 160ms ease-out',
        'slide-up': 'slide-up 180ms ease-out',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
export default config
