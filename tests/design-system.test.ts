import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('DESIGN.md — Vyen Harness × Pixel/Minecraft Identity verification', () => {
  const globalsCssPath = path.resolve(__dirname, '../app/globals.css');
  const sidebarPath = path.resolve(__dirname, '../components/sidebar.tsx');
  const backupReminderPath = path.resolve(__dirname, '../components/backup-reminder.tsx');
  const tailwindConfigPath = path.resolve(__dirname, '../tailwind.config.ts');

  /** Bảng màu chuẩn — DESIGN.md mục 2 (Dark Core + trạng thái + code block). */
  const PALETTE_TOKENS = new Set([
    '#0d1116', '#161d27', '#212730', '#252f3d',
    '#495059', '#757d89',
    /* #5d666f — bậc viền CONTROL, chèn giữa hairline (#495059) và hover
       (#757d89) để tách viền ô nhập/nút khỏi viền khung. Xem DESIGN.md mục 2. */
    '#5d666f',
    '#ebe7e4', '#9fa4ab',
    '#6a9fcc', '#4b607c',
    '#5db87a', '#e8993a', '#e8704f',
    '#1c2128',
  ]);

  /**
   * Bề mặt chat + composer đã được đưa hết về token. Danh sách này là hợp đồng:
   * thêm màu ngoài bảng vào một trong các file dưới đây là làm đứt test.
   */
  const TOKENIZED_COMPONENTS = [
    '../components/composer.tsx',
    '../components/thinking-menu.tsx',
    '../components/model-selector.tsx',
    '../components/chat-export-menu.tsx',
    '../components/sidebar.tsx',
    '../components/branch-switcher.tsx',
    '../components/staging-panel.tsx',
    '../components/plan-panel.tsx',
    '../components/tools-panel.tsx',
    '../components/subagent-card.tsx',
    '../components/diff-confirm.tsx',
    '../components/shell-confirm.tsx',
    '../components/workspace-checkpoints.tsx',
    '../components/context-meter.tsx',
    '../components/backup-reminder.tsx',
    '../components/chat/message-list.tsx',
    '../components/chat/message-item.tsx',
    '../components/chat/message-usage.tsx',
    '../components/message-status-badge.tsx',
    '../components/chat/status-line.tsx',
    '../components/chat/tool-trace.tsx',
    '../components/chat/orchestrator-badge.tsx',
    '../components/settings-dialog.tsx',
    /* Các section + tab tách ra từ settings-dialog.tsx — cùng thuộc bề mặt
       Settings nên phải chịu chung hợp đồng, nếu không chúng sẽ lệch chuẩn dần. */
    '../components/settings/memories-section.tsx',
    '../components/settings/vision-model-section.tsx',
    '../components/settings/slash-commands-section.tsx',
    '../components/settings/auto-backup-section.tsx',
    '../components/settings/appearance-tab.tsx',
    '../components/settings/providers-tab.tsx',
    '../components/settings/safety-tab.tsx',
    '../components/settings/extensions-tab.tsx',
    '../components/settings/memory-tab.tsx',
    '../components/settings/data-tab.tsx',
    '../components/settings/section-loading.tsx',
    '../components/tool-permissions-table.tsx',
    '../components/provider-manager.tsx',
    '../components/mcp/mcp-settings-panel.tsx',
    '../components/scheduler/scheduler-panel.tsx',
    '../components/routing-settings-panel.tsx',
    '../components/settings-skills.tsx',
    '../components/settings-agent-memory.tsx',
    '../components/usage-stats.tsx',
    '../components/hud/agent-hud.tsx',
    '../components/chat-error-boundary.tsx',
    '../app/globals.css',
    '../app/layout.tsx',
  ];

  /** Họ màu của Tailwind: dùng chúng là đi ra ngoài bảng token DESIGN.md. */
  const TAILWIND_PALETTE =
    /\b(?:text|bg|border|ring|from|to|via|decoration|outline|fill|stroke|shadow|accent|caret|divide|placeholder)-(?:red|blue|green|yellow|amber|orange|rose|purple|violet|indigo|sky|cyan|teal|emerald|lime|pink|fuchsia|zinc|slate|gray|neutral|stone)-[0-9]{2,3}\b/g;

  function collectStyleFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectStyleFiles(full, out);
      else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('globals.css định nghĩa @keyframes blink với bước chuyển opacity 1 và 0', () => {
    const css = fs.readFileSync(globalsCssPath, 'utf8');
    expect(css).toMatch(/@keyframes\s+blink\s*\{/);
    expect(css).toMatch(/0%,\s*100%\s*\{\s*opacity:\s*1;\s*\}/);
    expect(css).toMatch(/50%\s*\{\s*opacity:\s*0;\s*\}/);
  });

  it('globals.css cấu hình .streaming-caret::after chính xác theo DESIGN.md Section 5', () => {
    const css = fs.readFileSync(globalsCssPath, 'utf8');
    expect(css).toMatch(/\.streaming-caret::after\s*\{[^}]*\}/);
    const match = css.match(/\.streaming-caret::after\s*\{([^}]+)\}/);
    expect(match).toBeTruthy();
    const body = match![1];
    expect(body).toContain("content: ' █'");
    expect(body).toContain('color: #6a9fcc');
    expect(body).toContain('var(--font-mono)');
    expect(body).toContain('animation: blink 1s step-end infinite');
  });

  it('globals.css cung cấp tiện ích .terminal-cursor với font mono và blink animation', () => {
    const css = fs.readFileSync(globalsCssPath, 'utf8');
    expect(css).toMatch(/\.terminal-cursor\s*\{[^}]*\}/);
    const match = css.match(/\.terminal-cursor\s*\{([^}]+)\}/);
    expect(match).toBeTruthy();
    const body = match![1];
    expect(body).toContain('color: #6a9fcc');
    expect(body).toContain('var(--font-mono)');
    expect(body).toContain('animation: blink 1s step-end infinite');
  });

  it('globals.css cho phép streaming cursor bám inline ở cuối dòng prose mà không rớt dòng', () => {
    const css = fs.readFileSync(globalsCssPath, 'utf8');
    expect(css).toContain('.claude-prose.streaming-caret .claude-md-root');
    expect(css).toContain('.claude-prose.streaming-caret .claude-md-root > :last-child:is(p, h1, h2, h3, li)');
  });

  it('components/sidebar.tsx: toàn bộ các nút và menu đều sử dụng rounded-none tuyệt đối', () => {
    const sidebarCode = fs.readFileSync(sidebarPath, 'utf8');

    // Tách từng khối <button ... </button>
    const buttonBlocks = sidebarCode.split('<button').slice(1);
    expect(buttonBlocks.length).toBeGreaterThan(5);

    for (const block of buttonBlocks) {
      const tagContent = block.split('</button>')[0];
      // Phải có rounded-none trong className
      expect(tagContent).toMatch(/className=[\s\S]*?rounded-none/);
      // Không được chứa rounded bo tròn lửng lơ
      expect(tagContent).not.toMatch(/className=[\s\S]*?rounded-(?:sm|md|lg|xl|2xl|3xl|full)\b/);
    }
  });

  it('components/sidebar.tsx: tooltip phím tắt chuẩn hóa Ctrl+\\ thành Ctrl+\\ sạch trong JSX', () => {
    const sidebarCode = fs.readFileSync(sidebarPath, 'utf8');
    expect(sidebarCode).not.toContain('title="Thu gọn (Ctrl+\\\\)"');
    expect(sidebarCode).toContain('title="Thu gọn (Ctrl+\\)"');
  });

  it('components/backup-reminder.tsx: toàn bộ button đều dùng rounded-none', () => {
    const code = fs.readFileSync(backupReminderPath, 'utf8');
    const buttonBlocks = code.split('<button').slice(1);
    expect(buttonBlocks.length).toBeGreaterThanOrEqual(3);

    for (const block of buttonBlocks) {
      const tagContent = block.split('</button>')[0];
      expect(tagContent).toMatch(/className=[\s\S]*?rounded-none/);
    }
  });

  it('tailwind.config.ts khóa chặt borderRadius và boxShadow về 0px / none', () => {
    const configCode = fs.readFileSync(tailwindConfigPath, 'utf8');
    expect(configCode).toContain("none: '0px'");
    expect(configCode).toContain("sm: '0px'");
    expect(configCode).toContain("md: '0px'");
    expect(configCode).toContain("lg: '0px'");
    expect(configCode).toContain("xl: '0px'");
    expect(configCode).toContain("'2xl': '0px'");
    expect(configCode).toContain("'3xl': '0px'");
    expect(configCode).toContain("none: 'none'");
  });

  it('bề mặt chat + composer chỉ dùng hex trong bảng màu DESIGN.md mục 2', () => {
    for (const rel of TOKENIZED_COMPONENTS) {
      const code = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      const hexes = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      /*
       * KHÔNG bắt buộc phải còn hex: dùng class token ngữ nghĩa
       * (`bg-panel-bg`, `border-border-hairline`) là trạng thái TỐT HƠN hex thô.
       * Assertion cũ `expect(hexes.length).toBeGreaterThan(0)` vô tình chặn luôn
       * việc migrate sang token. Hợp đồng đúng là: hex nào còn lại cũng phải
       * thuộc bảng màu.
       */
      const offPalette = [...new Set(hexes.map((h) => h.toLowerCase()))].filter(
        (h) => !PALETTE_TOKENS.has(h),
      );
      expect(offPalette, `${rel} dùng màu ngoài bảng: ${offPalette.join(', ')}`).toEqual([]);
    }
  });

  it('bề mặt UI dùng class token ngữ nghĩa thay vì hex thô', () => {
    /*
     * Chốt hướng: mọi file trong hợp đồng phải dùng token (`bg-panel-bg`,
     * `text-text-muted`...). Ngưỡng đặt ở mức tối thiểu để không chặn các file
     * còn ít hex hợp lệ (ví dụ màu gradient của sọc active).
     */
    const missing: string[] = [];
    for (const rel of TOKENIZED_COMPONENTS) {
      if (rel === '../app/globals.css' || rel === '../app/layout.tsx') continue;
      const code = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      const tokenUses = (code.match(
        /\b(?:bg|text|border)-(?:bg-deep|surface-raised|panel-bg|panel-soft|surface-code|text-primary|text-muted|accent-steel|border-hairline|border-subtle|border-control|border-hover|status-(?:success|warning|error))\b/g,
      ) ?? []).length;
      if (tokenUses === 0) missing.push(rel);
    }
    expect(missing, `chưa dùng token ngữ nghĩa: ${missing.join(', ')}`).toEqual([]);
  });


  it('bề mặt chat + composer không dùng họ màu Tailwind (red-500, zinc-400...)', () => {
    for (const rel of TOKENIZED_COMPONENTS) {
      const code = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      const hits = [...new Set(code.match(TAILWIND_PALETTE) ?? [])];
      expect(hits, `${rel} dùng màu Tailwind ngoài bảng: ${hits.join(', ')}`).toEqual([]);
    }
  });

  it('không dùng trắng tinh cho chữ: DESIGN.md mục 2 chốt Moonstone #ebe7e4', () => {
    for (const rel of TOKENIZED_COMPONENTS) {
      const code = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      // `bg-white/[0.04]` là lớp phủ trung tính, không phải màu chữ — vẫn cho phép.
      expect(code, `${rel} còn text-white`).not.toMatch(/\btext-white\b/);
      expect(code, `${rel} còn color: #fff`).not.toMatch(/color:\s*#f{3,6}\b/i);
    }
  });

  it('composer chạy full-bleed: không còn khung max-w-thread căn giữa', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../components/composer.tsx'), 'utf8');
    expect(code).not.toMatch(/max-w-thread/);
    expect(code).toContain('w-full pb-[env(safe-area-inset-bottom)]');
  });

  it('nút có nhãn trong thanh composer nới vùng chạm lên mốc 44px của mobile', () => {
    // Base 16px: nút cao 32px (h-8) nên `after:-inset-[6px]` cho đúng 44px —
    // mốc vùng chạm tối thiểu của WCAG 2.5.5 trên mobile.
    for (const rel of ['../components/thinking-menu.tsx', '../components/model-selector.tsx']) {
      const code = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      const trigger = code.split('aria-haspopup')[1]?.split('>')[0] ?? '';
      expect(trigger, `${rel}: trigger thiếu vùng chạm mở rộng`).toMatch(/after:-inset-\[6px\]/);
    }
  });

  it('#55779b (4.06:1 trên #0d1116 — FAIL WCAG AA) đã bị loại khỏi components/ và app/', () => {
    const roots = ['../components', '../app'].map((r) => path.resolve(__dirname, r));
    const offenders = roots
      .flatMap((root) => collectStyleFiles(root))
      .filter((file) => /#55779b/i.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(path.resolve(__dirname, '..'), file));

    expect(offenders, `còn dùng #55779b: ${offenders.join(', ')}`).toEqual([]);
  });
});
