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
  title: 'KODA — AI Innovations',
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
    title: 'KODA',
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
 * Chống FOUC: đọc theme từ zustand persist (localStorage) và gắn class
 * `dark` lên <html> TRƯỚC first-paint. Phải là script inline đồng bộ đặt
 * đầu <body> — nếu đợi React hydrate thì theme sáng sẽ chớp một nhịp.
 */
const THEME_NO_FLASH_SCRIPT = `(function(){try{var raw=localStorage.getItem('ai-chat-settings');var t='system';if(raw){var p=JSON.parse(raw);if(p&&p.state&&(p.state.theme==='light'||p.state.theme==='dark'||p.state.theme==='system'))t=p.state.theme;}var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="vi"
      className={inter.variable}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-surface font-sans text-foreground antialiased overscroll-none selection:bg-brand/20 selection:text-foreground-strong">
        <script dangerouslySetInnerHTML={{ __html: THEME_NO_FLASH_SCRIPT }} />
        <PWARegister />
        {children}
      </body>
    </html>
  );
}