import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { PWARegister } from '@/components/pwa-register';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'Vyen — Minimal Agent Harness',
  description: 'Trợ lý AI cá nhân với hội thoại phân nhánh và công cụ mở rộng — dữ liệu lưu ngay trên thiết bị của bạn.',
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
  colorScheme: 'dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0d1116' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1116' },
  ],
};

/**
 * Chống FOUC: gắn cứng class `dark` lên <html> trước first-paint.
 */
const THEME_NO_FLASH_SCRIPT = `(document.documentElement.classList.add('dark'));`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="vi"
      className={`dark ${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400..700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="relative min-h-dvh bg-[#0d1116] font-sans text-[#ebe7e4] antialiased overscroll-none selection:bg-[#6a9fcc]/30 selection:text-[#ebe7e4]">
        <script dangerouslySetInnerHTML={{ __html: THEME_NO_FLASH_SCRIPT }} />
        <PWARegister />
        {children}
      </body>
    </html>
  );
}