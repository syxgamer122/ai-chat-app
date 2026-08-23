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
  colorScheme: 'light',
  themeColor: '#F7F9FC',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="vi"
      className={inter.variable}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-surface font-sans text-foreground antialiased overscroll-none selection:bg-brand/20 selection:text-foreground-strong">
        <PWARegister />
        {children}
      </body>
    </html>
  );
}