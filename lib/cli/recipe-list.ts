/**
 * `vyen recipe list` — quét .vyen/recipes của workspace, parse qua schema,
 * in bảng recipe kèm tham số. Thuần node fs, không đụng LLM.
 */

import path from 'node:path';
import fs from 'node:fs';
import { parseRecipeText } from '@/lib/recipes';

export function listWorkspaceRecipes(workspaceRoot: string): string {
  const dir = path.join(workspaceRoot, '.vyen', 'recipes');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(ya?ml|json)$/i.test(f)).sort();
  } catch {
    return `Không có thư mục ${path.join('.vyen', 'recipes')} — tạo recipe tại đó (file .yaml/.json) rồi chạy lại lệnh này.`;
  }

  const lines: string[] = [`Recipe trong ${path.join('.vyen', 'recipes')}: ${files.length} file`];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const text = fs.readFileSync(full, 'utf8');
      const parsed = parseRecipeText(text);
      if (!parsed.ok || !parsed.recipe) {
        lines.push(`  ✗ ${file} — ${parsed.error}`);
        continue;
      }
      const params = (parsed.recipe.parameters ?? [])
        .map((p) => `${p.key}${p.requirement === 'required' ? '' : '?'}`)
        .join(' ');
      lines.push(`  🍳 ${file} — ${parsed.recipe.title}${params ? ` (${params})` : ''}`);
      lines.push(`      ${parsed.recipe.description.split('\n')[0]!.slice(0, 100)}`);
    } catch (err) {
      lines.push(`  ✗ ${file} — không đọc được: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  lines.push('', 'Chạy: vyen run --recipe <file> --params k=v --output json');
  return lines.join('\n');
}
