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
        /** Thương hiệu Vyen. */
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
        /** DESIGN.md Pi Harness x Pixel Tokens */
        'bg-deep': 'rgb(var(--bg-deep) / <alpha-value>)',
        'bg-canvas': 'rgb(var(--bg-canvas) / <alpha-value>)',
        'panel-bg': 'rgb(var(--panel-bg) / <alpha-value>)',
        'panel-soft': 'rgb(var(--panel-soft) / <alpha-value>)',
        'border-hairline': 'rgb(var(--border-hairline) / <alpha-value>)',
        'border-hover': 'rgb(var(--border-hover) / <alpha-value>)',
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        'text-muted': 'rgb(var(--text-muted) / <alpha-value>)',
        'accent-steel': 'rgb(var(--accent-steel) / <alpha-value>)',
        'accent-thread': 'rgb(var(--accent-thread) / <alpha-value>)',
        'status-success': 'rgb(var(--status-success) / <alpha-value>)',
        'status-warning': 'rgb(var(--status-warning) / <alpha-value>)',
        'status-error': 'rgb(var(--status-error) / <alpha-value>)',
      },
      borderRadius: {
        none: '0px',
        sm: '0px',
        DEFAULT: '0px',
        md: '0px',
        lg: '0px',
        xl: '0px',
        '2xl': '0px',
        '3xl': '0px',
        full: '9999px',
      },
      boxShadow: {
        none: 'none',
        DEFAULT: 'none',
        sm: 'none',
        md: 'none',
        lg: 'none',
        xl: 'none',
        '2xl': 'none',
        inner: 'none',
        brand: 'none',
        'brand-lg': 'none',
        panel: 'none',
        card: 'none',
      },
      fontFamily: {
        /*
         * `next/font` chỉ tạo biến `--font-sans`; nếu không map vào đây thì
         * `font-sans` của Tailwind vẫn là font hệ thống và Inter (đã tải kèm
         * subset tiếng Việt) không bao giờ được dùng.
         */
        sans: ['var(--font-sans)', ...defaultTheme.fontFamily.sans],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        pixel: ['var(--font-pixel)', 'Pixelify Sans', 'Minecraft', 'monospace'],
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
        /*
         * Ba keyframes dưới thay framer-motion trong components/effects —
         * tham số (giá trị/duration/ease) copy nguyên từ transition cũ để
         * HÀNH VI hiệu ứng không đổi, chỉ đổi cách triển khai (CSS thuần).
         */
        'fx-bar-bounce': {
          '0%, 100%': { height: '4px' },
          '50%': { height: '22px' },
        },
        'fx-dot-bounce': {
          '0%, 100%': { transform: 'translateY(0)', opacity: '0.4' },
          '50%': { transform: 'translateY(-5px)', opacity: '1' },
        },
        // Vệt quét ShimmerLine: framer chạy 1.4s + repeatDelay 0.4s — CSS
        // không có repeatDelay nên gộp độ trễ vào cuối chu kỳ 1.8s: quét
        // chiếm 1.4/1.8 ≈ 77.8% chu kỳ rồi đứng yên 0.4s.
        'fx-sweep': {
          '0%': { transform: 'translateX(-120%)' },
          '77.8%': { transform: 'translateX(360%)' },
          '100%': { transform: 'translateX(360%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'pop-in': 'pop-in 160ms ease-out',
        'slide-up': 'slide-up 180ms ease-out',
        'fx-bar-bounce': 'fx-bar-bounce 1.1s ease-in-out infinite',
        'fx-dot-bounce': 'fx-dot-bounce 0.9s ease-in-out infinite',
        'fx-sweep': 'fx-sweep 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
export default config
