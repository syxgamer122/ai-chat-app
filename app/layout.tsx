import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: 'AI Chat Studio',
  description: 'Minimalist AI Chat Interface',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
  colorScheme: 'dark',
  themeColor: '#0f0f10',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="vi"
      className={`dark ${inter.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh font-sans bg-[#0f0f10] text-[#e4e4e7] antialiased overscroll-none selection:bg-[#c96442]/30 selection:text-white">
        {children}
      </body>
    </html>
  );
}