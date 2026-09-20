const fs = require('node:fs');
const path = require('node:path');

const TAILWIND_PALETTE =
  /\b(?:text|bg|border|ring|from|to|via|decoration|outline|fill|stroke|shadow|accent|caret|divide|placeholder)-(?:red|blue|green|yellow|amber|orange|rose|purple|violet|indigo|sky|cyan|teal|emerald|lime|pink|fuchsia|zinc|slate|gray|neutral|stone)-[0-9]{2,3}\b/g;

const DARK_VARIANT = /\bdark:[^\s"'`>]+/g;
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/g;

const TARGET_FILES = [
  'components/settings-dialog.tsx',
  'components/tool-permissions-table.tsx',
  'components/mcp/mcp-settings-panel.tsx',
  'components/scheduler/scheduler-panel.tsx',
  'components/routing-settings-panel.tsx',
  'components/settings-agent-memory.tsx',
  'components/settings-skills.tsx',
  'components/usage-stats.tsx',
  'components/provider-manager.tsx',
  'components/hud/agent-hud.tsx',
  'components/recipes/recipes-panel.tsx',
  'components/tools-panel.tsx',
  'components/chat-error-boundary.tsx',
];

const root = path.resolve(__dirname, '..');

console.log('| File | Lines | Hex Count | TW Palette Count | dark: Count |');
console.log('|---|---|---|---|---|');

let totalLines = 0;
let totalHex = 0;
let totalPalette = 0;
let totalDark = 0;

for (const rel of TARGET_FILES) {
  const fullPath = path.join(root, rel);
  if (!fs.existsSync(fullPath)) {
    console.log(`| ${rel} | (MISSING) | - | - | - |`);
    continue;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n').length;
  const hexMatches = content.match(HEX_PATTERN) || [];
  const paletteMatches = content.match(TAILWIND_PALETTE) || [];
  const darkMatches = content.match(DARK_VARIANT) || [];

  totalLines += lines;
  totalHex += hexMatches.length;
  totalPalette += paletteMatches.length;
  totalDark += darkMatches.length;

  console.log(
    `| ${rel} | ${lines} | ${hexMatches.length} | ${paletteMatches.length} | ${darkMatches.length} |`
  );
}

console.log('|---|---|---|---|---|');
console.log(`| **TOTAL** | **${totalLines}** | **${totalHex}** | **${totalPalette}** | **${totalDark}** |`);
