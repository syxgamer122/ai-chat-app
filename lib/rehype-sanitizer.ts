/**
 * Rehype AST Sanitizer for Markdown Renderer.
 * Adheres to strict CSP and HTML sanitization schema:
 * - Removes forbidden tags: script, object, embed, iframe.
 * - Strips all HTML event handlers (attributes matching /^on/i).
 * - Restricts class names:
 *   - span & div: only classes with 'math' or 'katex' prefixes.
 *   - code: only classes with 'language-' prefix.
 *   - other tags: no class attributes allowed.
 * - Restricts URL protocols (href, src, etc.):
 *   - Allowed protocols: http, https, mailto (and relative/hash links).
 *   - Forbidden protocols (javascript, data, vbscript, etc.) are stripped.
 */

export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, any>;
  children?: HastNode[];
  value?: string;
  [key: string]: any;
}

const FORBIDDEN_TAGS = new Set(['script', 'object', 'embed', 'iframe']);

const ALLOWED_PROTOCOLS = new Set(['http', 'https', 'mailto']);

const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'cite',
  'poster',
  'data',
  'xlinkhref',
  'xlink:href',
]);

const PROTOCOL_REGEX = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/;

function sanitizeProperties(node: HastNode): void {
  if (!node.properties || typeof node.properties !== 'object') return;

  const props = node.properties;
  const tag = (node.tagName || '').toLowerCase();

  for (const key of Object.keys(props)) {
    // 1. Remove any HTML event handlers (on*, onclick, onload, etc.)
    if (/^on/i.test(key)) {
      delete props[key];
      continue;
    }

    const lowerKey = key.toLowerCase();

    // 2. Class name sanitization
    if (lowerKey === 'classname' || lowerKey === 'class') {
      const raw = props[key];
      let classes: string[] = [];
      if (Array.isArray(raw)) {
        classes = raw.map(String);
      } else if (typeof raw === 'string') {
        classes = raw.split(/\s+/).filter(Boolean);
      }

      const allowedClasses = classes.filter((cls) => {
        if (tag === 'span' || tag === 'div') {
          return cls.startsWith('math') || cls.startsWith('katex');
        }
        if (tag === 'code') {
          return cls.startsWith('language-');
        }
        return false;
      });

      if (allowedClasses.length > 0) {
        props.className = allowedClasses;
        if (key !== 'className') {
          delete props[key];
        }
      } else {
        delete props[key];
        delete props.className;
      }
      continue;
    }

    // 3. URL protocol checking
    const val = props[key];
    if (typeof val === 'string') {
      // Immediate rejection of dangerous schemes ignoring all whitespace and control chars
      const valNoCtrl = val.replace(/[\u0000-\u001f\u007f-\u009f\s]/g, '').toLowerCase();
      if (
        valNoCtrl.startsWith('javascript:') ||
        valNoCtrl.startsWith('vbscript:') ||
        valNoCtrl.startsWith('data:')
      ) {
        delete props[key];
        continue;
      }

      const cleanVal = val.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
      const match = PROTOCOL_REGEX.exec(cleanVal);
      if (match) {
        const protocol = match[1].toLowerCase();
        if (
          URL_ATTRIBUTES.has(lowerKey) ||
          protocol === 'javascript' ||
          protocol === 'vbscript' ||
          protocol === 'data'
        ) {
          if (!ALLOWED_PROTOCOLS.has(protocol)) {
            delete props[key];
            continue;
          }
        }
      }
    }
  }
}

function sanitizeChildren(children?: HastNode[]): HastNode[] {
  if (!Array.isArray(children)) return [];

  const result: HastNode[] = [];
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;

    if (child.type === 'element') {
      const tag = (child.tagName || '').toLowerCase();
      if (FORBIDDEN_TAGS.has(tag)) {
        // Drop forbidden tag completely
        continue;
      }
      sanitizeProperties(child);
      if (child.children) {
        child.children = sanitizeChildren(child.children);
      }
    } else if (child.children) {
      child.children = sanitizeChildren(child.children);
    }

    result.push(child);
  }
  return result;
}

export function rehypeSanitizer() {
  return function transform(tree: HastNode): void {
    if (!tree || typeof tree !== 'object') return;
    if (tree.type === 'element') {
      const tag = (tree.tagName || '').toLowerCase();
      if (FORBIDDEN_TAGS.has(tag)) {
        tree.type = 'text';
        tree.value = '';
        delete tree.tagName;
        delete tree.properties;
        tree.children = [];
        return;
      }
      sanitizeProperties(tree);
    }
    if (tree.children) {
      tree.children = sanitizeChildren(tree.children);
    }
  };
}

export default rehypeSanitizer;
