/**
 * Structural code-shape outline extractor.
 * Parses classes, methods, functions, interfaces, types, and signatures into a clean structural outline.
 */

import type { CodeShapeItem, CodeShapeResult } from './types';

/**
 * Từ khoá mà regex method-match có thể nuốt nhầm thành tên method khi dòng
 * bắt đầu bằng từ khoá kèm cặp `(...)` (vd `super(...)`, `if (...)`,
 * `throw (...)`). Các từ khoá này là reserved word nên không bao giờ là tên
 * method hợp lệ, loại an toàn.
 */
const CODE_SHAPE_KEYWORD_EXCLUSIONS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'super',
  'return',
  'throw',
  'delete',
  'yield',
]);

export class CodeShapeExtractor {
  /**
   * Extracts structural code outline from file content.
   */
  public static extract(filePath: string, content: string): CodeShapeResult {
    const lines = content.split(/\r?\n/);
    const items: CodeShapeItem[] = [];

    let currentClass: CodeShapeItem | null = null;
    let currentInterface: CodeShapeItem | null = null;
    let braceDepth = 0;
    let classBraceDepth = -1;
    let interfaceBraceDepth = -1;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      // Skip empty lines or full single-line comments
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }

      // Track braces
      const openBraces = (rawLine.match(/\{/g) || []).length;
      const closeBraces = (rawLine.match(/\}/g) || []).length;

      // Class declaration
      const classMatch = trimmed.match(/^(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z0-9_$]+)(<[^>]+>)?(\s+extends\s+[A-Za-z0-9_$.<>]+)?(\s+implements\s+[^{]+)?/);
      if (classMatch && !currentClass) {
        const exported = Boolean(classMatch[1] || classMatch[2]);
        const name = classMatch[4];
        currentClass = {
          type: 'class',
          name,
          exported,
          signature: classMatch[0].trim(),
          line: lineNum,
          children: [],
        };
        items.push(currentClass);
        classBraceDepth = braceDepth;
      }

      // Interface declaration
      const interfaceMatch = trimmed.match(/^(export\s+)?interface\s+([A-Za-z0-9_$]+)(<[^>]+>)?(\s+extends\s+[^{]+)?/);
      if (interfaceMatch && !currentInterface && !currentClass) {
        const exported = Boolean(interfaceMatch[1]);
        const name = interfaceMatch[2];
        currentInterface = {
          type: 'interface',
          name,
          exported,
          signature: interfaceMatch[0].trim(),
          line: lineNum,
          children: [],
        };
        items.push(currentInterface);
        interfaceBraceDepth = braceDepth;
      }

      // Type alias declaration
      const typeMatch = trimmed.match(/^(export\s+)?type\s+([A-Za-z0-9_$]+)(<[^>]+>)?\s*=/);
      if (typeMatch && !currentClass && !currentInterface) {
        items.push({
          type: 'type',
          name: typeMatch[2],
          exported: Boolean(typeMatch[1]),
          signature: trimmed.replace(/;$/, ''),
          line: lineNum,
        });
      }

      // Enum declaration
      const enumMatch = trimmed.match(/^(export\s+)?(const\s+)?enum\s+([A-Za-z0-9_$]+)/);
      if (enumMatch && !currentClass && !currentInterface) {
        items.push({
          type: 'enum',
          name: enumMatch[3],
          exported: Boolean(enumMatch[1]),
          signature: enumMatch[0].trim(),
          line: lineNum,
        });
      }

      // Methods inside a class
      if (currentClass && braceDepth > classBraceDepth) {
        const methodMatch = trimmed.match(/^(public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)(\s*:\s*[^{;]+)?/);
        // Danh sách loại trừ phải bao gồm cả TỪ KHÓA CÂU LỆNH: nếu thiếu, một lời
        // gọi trần như `super();` / `validate();` trong class sẽ bị nhận nhầm là method.
        if (methodMatch && !CODE_SHAPE_KEYWORD_EXCLUSIONS.has(methodMatch[4])) {
          const isConstructor = methodMatch[4] === 'constructor';
          const methodName = methodMatch[4];
          const modifier = methodMatch[1]?.trim() || (isConstructor ? '' : 'public');
          const isStatic = Boolean(methodMatch[2]);
          const isAsync = Boolean(methodMatch[3]);
          const params = methodMatch[5].trim();
          const retType = methodMatch[6]?.replace(/^\s*:\s*/, '').trim() || (isConstructor ? '' : 'void');

          const sig = `${modifier ? `[${modifier}] ` : ''}${isStatic ? '[static] ' : ''}${isAsync ? '[async] ' : ''}${methodName}(${params})${retType ? `: ${retType}` : ''}`.trim();

          currentClass.children = currentClass.children || [];
          currentClass.children.push({
            type: 'method',
            name: methodName,
            exported: false,
            signature: sig,
            line: lineNum,
          });
        }
      }

      // Properties inside an interface
      if (currentInterface && braceDepth > interfaceBraceDepth) {
        const propMatch = trimmed.match(/^([A-Za-z0-9_$?]+)\s*(\(([^)]*)\)\s*:\s*([^;]+)|:\s*([^;]+))/);
        if (propMatch) {
          const propName = propMatch[1];
          const sig = trimmed.replace(/;$/, '');
          currentInterface.children = currentInterface.children || [];
          currentInterface.children.push({
            type: 'property',
            name: propName,
            exported: false,
            signature: sig,
            line: lineNum,
          });
        }
      }

      // Standalone function declaration (outside class/interface)
      if (!currentClass && !currentInterface) {
        const fnMatch = trimmed.match(/^(export\s+)?(default\s+)?(async\s+)?function\s*([A-Za-z0-9_$]+)?\s*\(([^)]*)\)(\s*:\s*[^{;]+)?/);
        if (fnMatch) {
          const fnName = fnMatch[4] || 'anonymous';
          const exported = Boolean(fnMatch[1] || fnMatch[2]);
          const isAsync = Boolean(fnMatch[3]);
          const params = fnMatch[5].trim();
          const retType = fnMatch[6]?.replace(/^\s*:\s*/, '').trim() || 'void';

          items.push({
            type: 'function',
            name: fnName,
            exported,
            signature: `${exported ? '[export] ' : ''}${isAsync ? '[async] ' : ''}function ${fnName}(${params}): ${retType}`.trim(),
            line: lineNum,
          });
        }

        // Arrow function assigned to const/let/var: export const myFunc = (...) => ...
        const arrowMatch = trimmed.match(/^(export\s+)?(const|let)\s+([A-Za-z0-9_$]+)\s*(:\s*[^=]+)?\s*=\s*(async\s+)?\(([^)]*)\)(\s*:\s*[^=]+)?\s*=>/);
        if (arrowMatch) {
          const varName = arrowMatch[3];
          const exported = Boolean(arrowMatch[1]);
          const isAsync = Boolean(arrowMatch[5]);
          const params = arrowMatch[6].trim();
          const retType = arrowMatch[7]?.replace(/^\s*:\s*/, '').trim() || 'void';

          items.push({
            type: 'function',
            name: varName,
            exported,
            signature: `${exported ? '[export] ' : ''}const ${varName} = ${isAsync ? 'async ' : ''}(${params}): ${retType}`.trim(),
            line: lineNum,
          });
        }
      }

      // Update depth
      braceDepth += openBraces - closeBraces;

      // Check if class closed
      if (currentClass && braceDepth <= classBraceDepth) {
        currentClass = null;
        classBraceDepth = -1;
      }

      // Check if interface closed
      if (currentInterface && braceDepth <= interfaceBraceDepth) {
        currentInterface = null;
        interfaceBraceDepth = -1;
      }
    }

    const formatted = this.formatOutline(filePath, items);
    const summary = `${items.length} structural symbols extracted in ${filePath}`;

    return {
      filePath,
      items,
      summary,
      formatted,
    };
  }

  /**
   * Formats extracted items into a hierarchical text tree.
   */
  public static formatOutline(filePath: string, items: CodeShapeItem[]): string {
    const lines: string[] = [];
    lines.push(`Outline: ${filePath}`);

    if (items.length === 0) {
      lines.push('  (no top-level classes, functions, or types found)');
      return lines.join('\n');
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLastItem = i === items.length - 1;
      const branch = isLastItem ? '└── ' : '├── ';
      const exportTag = item.exported ? ' [export]' : '';

      lines.push(`${branch}[${item.type}]${exportTag} ${item.name} (L${item.line})`);

      if (item.children && item.children.length > 0) {
        const childPrefix = isLastItem ? '    ' : '│   ';
        for (let c = 0; c < item.children.length; c++) {
          const child = item.children[c];
          const isLastChild = c === item.children.length - 1;
          const childBranch = isLastChild ? '└── ' : '├── ';
          lines.push(`${childPrefix}${childBranch}${child.signature} (L${child.line})`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Conforms to PROJECT.md interface VisualDiffVisualizer
   */
  public renderCodeShape(filePath: string, content: string): string {
    return CodeShapeExtractor.extract(filePath, content).formatted;
  }
}
