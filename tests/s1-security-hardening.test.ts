import { describe, it, expect } from 'vitest';
import { rehypeSanitizer, type HastNode } from '@/lib/rehype-sanitizer';
import {
  canonicalJson,
  sha256Hex,
  computePayloadHash,
  verifyChain,
  AUDIT_LOG_RETENTION_CAP,
  type StoredAuditLogEntry,
} from '@/lib/audit-log';
import { computeSchemaHash } from '@/lib/mcp/ipc-handlers.cjs';

describe('Sprint S1 Security Hardening & Audit Chain', () => {
  describe('1.3: Rehype AST Sanitizer + CSP Schema', () => {
    it('removes script, iframe, object, and embed elements', () => {
      const transform = rehypeSanitizer();
      const tree: HastNode = {
        type: 'root',
        children: [
          { type: 'element', tagName: 'script', properties: { src: 'evil.js' }, children: [] },
          { type: 'element', tagName: 'iframe', properties: { src: 'evil.html' }, children: [] },
          { type: 'element', tagName: 'object', properties: { data: 'evil.swf' }, children: [] },
          { type: 'element', tagName: 'embed', properties: { src: 'evil.swf' }, children: [] },
          {
            type: 'element',
            tagName: 'p',
            children: [{ type: 'text', value: 'Safe text' }],
          },
        ],
      };

      transform(tree);

      expect(tree.children).toHaveLength(1);
      expect(tree.children![0].tagName).toBe('p');
    });

    it('removes all on* HTML event handlers', () => {
      const transform = rehypeSanitizer();
      const tree: HastNode = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'div',
            properties: {
              onclick: 'alert(1)',
              onmouseover: 'alert(2)',
              ONLOAD: 'alert(3)',
              id: 'safe-id',
            },
            children: [],
          },
        ],
      };

      transform(tree);

      const div = tree.children![0];
      expect(div.properties!.onclick).toBeUndefined();
      expect(div.properties!.onmouseover).toBeUndefined();
      expect(div.properties!.ONLOAD).toBeUndefined();
      expect(div.properties!.id).toBe('safe-id');
    });

    it('enforces allowed classes: math/katex prefixes on span & div, language- on code', () => {
      const transform = rehypeSanitizer();
      const tree: HastNode = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'span',
            properties: { className: ['math-inline', 'katex-rule', 'unauthorized-class'] },
            children: [],
          },
          {
            type: 'element',
            tagName: 'div',
            properties: { className: ['katex-display', 'math-block', 'evil-red'] },
            children: [],
          },
          {
            type: 'element',
            tagName: 'code',
            properties: { className: ['language-typescript', 'not-a-lang'] },
            children: [],
          },
          {
            type: 'element',
            tagName: 'p',
            properties: { className: ['some-class', 'language-fake'] },
            children: [],
          },
        ],
      };

      transform(tree);

      expect(tree.children![0].properties!.className).toEqual(['math-inline', 'katex-rule']);
      expect(tree.children![1].properties!.className).toEqual(['katex-display', 'math-block']);
      expect(tree.children![2].properties!.className).toEqual(['language-typescript']);
      expect(tree.children![3].properties!.className).toBeUndefined();
    });

    it('enforces allowed URL protocols: http, https, mailto (rejects javascript, data, vbscript)', () => {
      const transform = rehypeSanitizer();
      const tree: HastNode = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'a',
            properties: { href: 'javascript:alert(1)' },
            children: [{ type: 'text', value: 'JS Link' }],
          },
          {
            type: 'element',
            tagName: 'a',
            properties: { href: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' },
            children: [{ type: 'text', value: 'Data Link' }],
          },
          {
            type: 'element',
            tagName: 'a',
            properties: { href: 'vbscript:msgbox(1)' },
            children: [{ type: 'text', value: 'VBS Link' }],
          },
          {
            type: 'element',
            tagName: 'a',
            properties: { href: 'https://example.com' },
            children: [{ type: 'text', value: 'HTTPS Link' }],
          },
          {
            type: 'element',
            tagName: 'a',
            properties: { href: 'mailto:support@example.com' },
            children: [{ type: 'text', value: 'Mail Link' }],
          },
        ],
      };

      transform(tree);

      expect(tree.children![0].properties!.href).toBeUndefined();
      expect(tree.children![1].properties!.href).toBeUndefined();
      expect(tree.children![2].properties!.href).toBeUndefined();
      expect(tree.children![3].properties!.href).toBe('https://example.com');
      expect(tree.children![4].properties!.href).toBe('mailto:support@example.com');
    });
  });

  describe('1.4: Audit Log Hash Chain & Verification', () => {
    it('produces deterministic canonicalJson independent of key insertion order', () => {
      const obj1 = { z: 1, a: 2, m: { y: 'b', x: 'a' } };
      const obj2 = { a: 2, m: { x: 'a', y: 'b' }, z: 1 };
      expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
      expect(canonicalJson(obj1)).toBe('{"a":2,"m":{"x":"a","y":"b"},"z":1}');
    });

    it('verifies a valid hash chain with Genesis and sequential links', async () => {
      const entries: StoredAuditLogEntry[] = [];
      let prevHash: string | null = null;

      for (let i = 1; i <= 4; i++) {
        const body = {
          id: `entry-${i}`,
          seq: i,
          timestamp: 1700000000000 + i * 1000,
          action: 'file_modification' as const,
          tool: 'fs_write',
          target: `file-${i}.txt`,
          decision: 'executed' as const,
        };
        const canonicalBody = canonicalJson(body);
        const hash = await sha256Hex(`${prevHash ?? 'GENESIS'}\n${canonicalBody}`);
        entries.push({
          ...body,
          prevHash,
          hash,
        });
        prevHash = hash;
      }

      const result = await verifyChain(entries);
      expect(result.valid).toBe(true);
      expect(result.totalChecked).toBe(4);
    });

    it('detects tampering when an entry field is modified', async () => {
      const entries: StoredAuditLogEntry[] = [];
      let prevHash: string | null = null;

      for (let i = 1; i <= 3; i++) {
        const body = {
          id: `entry-${i}`,
          seq: i,
          timestamp: 1700000000000 + i * 1000,
          action: 'approval' as const,
          tool: 'fs_edit',
          decision: 'approved' as const,
        };
        const canonicalBody = canonicalJson(body);
        const hash = await sha256Hex(`${prevHash ?? 'GENESIS'}\n${canonicalBody}`);
        entries.push({
          ...body,
          prevHash,
          hash,
        });
        prevHash = hash;
      }

      // Tamper with second entry
      entries[1].tool = 'fs_write';

      const result = await verifyChain(entries);
      expect(result.valid).toBe(false);
      expect(result.brokenSeq).toBe(2);
      expect(result.reason).toContain('Phát hiện giả mạo');
    });

    it('detects a broken chain link when an entry is missing', async () => {
      const entries: StoredAuditLogEntry[] = [];
      let prevHash: string | null = null;

      for (let i = 1; i <= 3; i++) {
        const body = {
          id: `entry-${i}`,
          seq: i,
          timestamp: 1700000000000 + i * 1000,
          action: 'approval' as const,
          tool: 'shell_run',
          decision: 'approved' as const,
        };
        const canonicalBody = canonicalJson(body);
        const hash = await sha256Hex(`${prevHash ?? 'GENESIS'}\n${canonicalBody}`);
        entries.push({
          ...body,
          prevHash,
          hash,
        });
        prevHash = hash;
      }

      // Drop middle entry
      const broken = [entries[0], entries[2]];

      const result = await verifyChain(broken);
      expect(result.valid).toBe(false);
      expect(result.brokenSeq).toBe(3);
    });

    it('has retention cap configured to 50,000 entries', () => {
      expect(AUDIT_LOG_RETENTION_CAP).toBe(50000);
    });
  });

  describe('1.5: MCP Tool Grant by Schema Hash', () => {
    it('computes deterministic schemaHash irrespective of schema key order', () => {
      const tool1 = {
        name: 'test_tool',
        description: 'Does testing',
        inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
      };
      const tool2 = {
        name: 'test_tool',
        description: 'Does testing',
        inputSchema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' },
      };

      const hash1 = computeSchemaHash(tool1);
      const hash2 = computeSchemaHash(tool2);
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('string');
      expect(hash1).toHaveLength(64);
    });

    it('invalidates schemaHash when description or inputSchema changes', () => {
      const baseTool = {
        name: 'fetch_data',
        description: 'Fetch remote data',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      };
      const baseHash = computeSchemaHash(baseTool);

      const modifiedDesc = {
        ...baseTool,
        description: 'Fetch remote data with credentials',
      };
      expect(computeSchemaHash(modifiedDesc)).not.toBe(baseHash);

      const modifiedSchema = {
        ...baseTool,
        inputSchema: { type: 'object', properties: { url: { type: 'string' }, headers: { type: 'object' } } },
      };
      expect(computeSchemaHash(modifiedSchema)).not.toBe(baseHash);
    });
  });
});
