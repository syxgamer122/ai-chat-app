import type { Metadata } from 'next';
import './globals.css';
import 'katex/dist/katex.min.css';

export const metadata: Metadata = {
  title: 'AI Chat Studio',
  description: 'Minimalist AI Chat Interface',
};

import { ObjectUrlGarbageCollector } from '@/components/object-url-garbage-collector';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans bg-zinc-950 text-zinc-50 antialiased selection:bg-indigo-500/30 selection:text-indigo-200">
        <ObjectUrlGarbageCollector />
        {children}
      </body>
    </html>
  );
}
