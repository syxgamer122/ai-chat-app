/**
 * Template engine tối giản cho recipe (không cần engine nặng — Vyen chỉ cần một
 * tập con nhỏ, KHÔNG eval JS):
 *   {{ param }}        thay bằng giá trị tham số (cho phép space trong braces)
 *   {{ recipe_dir }}   thư mục chứa file recipe trong workspace
 *   {{#if param}}...{{/if}}  chỉ giữ khối khi param truthy
 *
 * An toàn thay thế: ONE-PASS — giá trị tham số bị chèn bằng thay thế literal
 * và KHÔNG BAO GIỜ bị parse lại, nên value chứa "{{x}}" hay cú pháp jinja
 * chỉ là text thường (test khóa hành vi này). Thiếu tham số → chuỗi rỗng.
 */

/** Node của cây template sau khi parse. */
type TemplateNode =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'if'; name: string; children: TemplateNode[] };

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/;
const IF_OPEN_RE = /\{\{#if\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/;
const IF_CLOSE_MARKER = '{{/if}}';

/**
 * Parse template thành cây node. If KHÔNG lồng nhau (tập con cố ý — recipe
 * thực tế chỉ cần if phẳng; lồng nhau sẽ bị coi là text của khối cha).
 */
export function parseTemplate(template: string): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  let rest = template;
  let buffer = '';

  while (rest.length > 0) {
    const ifOpen = IF_OPEN_RE.exec(rest);
    const varMatch = VAR_RE.exec(rest);

    // Chọn marker ĐẦU TIÊN trong chuỗi còn lại.
    const positions: Array<{ at: number; apply: () => void }> = [];
    if (ifOpen) positions.push({ at: ifOpen.index, apply: () => {
      if (buffer) { nodes.push({ kind: 'text', text: buffer }); buffer = ''; }
      // Tìm closing {{/if}} tương ứng của khối này.
      const afterOpen = ifOpen.index + ifOpen[0].length;
      const closeIdx = rest.indexOf(IF_CLOSE_MARKER, afterOpen);
      const inner = closeIdx === -1
        ? rest.slice(afterOpen)
        : rest.slice(afterOpen, closeIdx);
      nodes.push({ kind: 'if', name: ifOpen[1], children: parseTemplate(inner) });
      rest = closeIdx === -1 ? '' : rest.slice(closeIdx + IF_CLOSE_MARKER.length);
    } });
    if (varMatch) positions.push({ at: varMatch.index, apply: () => {
      if (buffer) { nodes.push({ kind: 'text', text: buffer }); buffer = ''; }
      nodes.push({ kind: 'var', name: varMatch[1] });
      rest = rest.slice(varMatch.index + varMatch[0].length);
    } });

    // Không còn marker: phần text còn lại (SAU marker vừa xử lý) thuộc về buffer
    // rồi thoát — trước đây chỉ break, làm mất toàn bộ đuôi sau marker cuối.
    if (positions.length === 0) {
      buffer += rest;
      break;
    }
    positions.sort((a, b) => a.at - b.at);
    const first = positions[0];
    buffer += rest.slice(0, first.at);
    first.apply();
  }
  if (buffer) nodes.push({ kind: 'text', text: buffer });
  return nodes;
}

function isTruthy(v: string | number | boolean | undefined | null): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return v !== 0;
  return v === true;
}

function renderNodes(nodes: TemplateNode[], vars: Record<string, string | number | boolean>): string {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') out.push(node.text);
    else if (node.kind === 'var') out.push(String(vars[node.name] ?? ''));
    else if (isTruthy(vars[node.name])) out.push(renderNodes(node.children, vars));
  }
  return out.join('');
}

/**
 * Render template với bảng biến. One-pass: giá trị chèn vào KHÔNG được parse
 * lại — đây là hàng rào chống template-injection qua giá trị tham số.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | boolean>,
): string {
  return renderNodes(parseTemplate(template), vars);
}

/** Thu thập tên biến mà template tham chiếu (cho form + cảnh báo thiếu). */
export function collectTemplateVars(template: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: TemplateNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'var') names.add(n.name);
      else if (n.kind === 'if') {
        names.add(n.name);
        walk(n.children);
      }
    }
  };
  walk(parseTemplate(template));
  return [...names];
}

/**
 * Biến hoá giá trị người dùng nhập thành kiểu mong muốn của tham số.
 * Sai kiểu → null (caller quyết định báo lỗi hay dùng default).
 */
export function coerceParamValue(
  raw: string,
  inputType: 'string' | 'number' | 'boolean' | 'select',
): string | number | boolean | null {
  const trimmed = raw.trim();
  switch (inputType) {
    case 'string':
    case 'select':
      return trimmed;
    case 'number': {
      if (trimmed === '') return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (['true', '1', 'yes', 'on', 'co', 'có'].includes(lower)) return true;
      if (['false', '0', 'no', 'off', 'khong', 'không'].includes(lower)) return false;
      return null;
    }
  }
}
