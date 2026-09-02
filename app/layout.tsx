import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { PWARegister } from '@/components/pwa-register';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: 'Vyen — AI Innovations',
  description: 'Trợ lý AI cá nhân với hội thoại phân nhánh — dữ liệu lưu ngay trên thiết bị của bạn.',
  /**
   * CDN media của Qwen (cdn.qwenlm.ai) chặn hotlink theo `Referer`: request
   * kèm Referer khác domain của họ bị trả 403, nên <img>/<video> ảnh/video do
   * AI tạo không hiển thị. `no-referrer` bỏ Referer cho MỌI subresource (kể cả
   * <video>, vốn không có thuộc tính referrerPolicy riêng). App không dùng
   * analytics bên thứ ba và các API nội bộ xác thực qua Origin/sec-fetch-site,
   * nên bỏ Referer không ảnh hưởng gì.
   */
  referrer: 'no-referrer',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Vyen',
  },
  icons: {
    apple: '/icons/icon-180.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F9FC' },
    { media: '(prefers-color-scheme: dark)', color: '#09090B' },
  ],
};

/**
 * Chống FOUC: gắn cứng class `dark` lên <html> trước first-paint. Vyen đã
 * commit dark-only (aurora dark là bản sắc, 18/32 component hardcode màu
 * tối, việc hỗ trợ light mode đòi đập đi viết lại nửa codebase). Phải là
 * script inline đồng bộ đặt đầu <body> — class đã có sẵn trên <html> rồi
 * nhưng giữ script này phòng React mount chậm hoặc streaming SSR làm nhịp
 * repaint chớp giữa nền sáng/tối.
 */
const THEME_NO_FLASH_SCRIPT = `(document.documentElement.classList.add('dark'));`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="vi"
      className={`dark ${inter.variable}`}
      suppressHydrationWarning
    >
      <body className="relative min-h-dvh bg-slate-950 font-sans text-slate-200 antialiased overscroll-none selection:bg-emerald-500/30 selection:text-white">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-700/20 via-cyan-900/10 to-slate-950 blur-3xl -z-10" />
        <script dangerouslySetInnerHTML={{ __html: THEME_NO_FLASH_SCRIPT }} />
        <PWARegister />
        {children}
      </body>
    </html>
  );
}