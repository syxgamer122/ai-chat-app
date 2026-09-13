import { describe, it, expect } from 'vitest';
import {
  SHARED_PREAMBLE,
  UNIVERSAL_BLOCKS,
  SUBAGENT_CALIBRATION,
  COMPOSER_CALIBRATION,
  ALL_MODEL_FAMILIES,
  modelFamily,
  calibrationFor,
  assemblePrompt,
} from '@/lib/prompt/protocol';
import type { RouteReceipt } from '@/lib/routing/categories';

describe('Universal Prompt Protocol & Model Family Calibration', () => {
  describe('Byte & Constraint Ceilings', () => {
    it('enforces SHARED_PREAMBLE byte length <= 2770 bytes (UTF-8)', () => {
      const byteLen = Buffer.byteLength(SHARED_PREAMBLE, 'utf-8');
      expect(byteLen).toBeLessThanOrEqual(2770);
    });

    it('enforces SHARED_PREAMBLE constraint count <= 10 rules', () => {
      const numberedRules = (SHARED_PREAMBLE.match(/^\d+\./gm) || []).length;
      expect(numberedRules).toBeGreaterThan(0);
      expect(numberedRules).toBeLessThanOrEqual(10);
    });

    it('enforces each of the 4 UNIVERSAL_BLOCKS has <= 3 constraints', () => {
      for (const [name, block] of Object.entries(UNIVERSAL_BLOCKS)) {
        const numberedRules = (block.match(/^\d+\./gm) || []).length;
        expect(numberedRules, `Block ${name} constraint count`).toBeGreaterThan(0);
        expect(numberedRules, `Block ${name} constraint count`).toBeLessThanOrEqual(3);
      }
    });

    it('enforces ZERO "Bad:" or "Wrong:" negative examples across all blocks and calibrations', () => {
      const allTexts = [
        SHARED_PREAMBLE,
        ...Object.values(UNIVERSAL_BLOCKS),
        ...Object.values(SUBAGENT_CALIBRATION),
        ...Object.values(COMPOSER_CALIBRATION),
      ];

      for (const text of allTexts) {
        expect(text).not.toMatch(/\bBad:/i);
        expect(text).not.toMatch(/\bWrong:/i);
      }
    });
  });

  describe('Model Family Mapping & Calibration Parity', () => {
    it('maps model IDs to correct families', () => {
      expect(modelFamily('gpt-5-6-sol')).toBe('gpt');
      expect(modelFamily('o1')).toBe('gpt');
      expect(modelFamily('o3-mini')).toBe('gpt');
      expect(modelFamily('claude-opus-5')).toBe('claude');
      expect(modelFamily('claude-3-5-sonnet')).toBe('claude');
      expect(modelFamily('gemini-3-1-pro')).toBe('gemini');
      expect(modelFamily('deepseek-reasoner')).toBe('deepseek');
      expect(modelFamily('qwen-max-2-5')).toBe('qwen');
      expect(modelFamily('kimi-k3')).toBe('kimi');
      expect(modelFamily('glm-4-plus')).toBe('glm');
      expect(modelFamily('grok-2-1212')).toBe('grok');
      expect(modelFamily('minimax_m3')).toBe('minimax');
      expect(modelFamily('random-unknown-model')).toBe('unknown');
    });

    it('strips provider prefixes when resolving model family', () => {
      expect(modelFamily('openai/gpt-5-6-sol')).toBe('gpt');
      expect(modelFamily('anthropic/claude-opus-5')).toBe('claude');
      expect(modelFamily('ollama:deepseek-reasoner')).toBe('deepseek');
    });

    it('guarantees 100% key parity between SUBAGENT_CALIBRATION and COMPOSER_CALIBRATION', () => {
      const subKeys = Object.keys(SUBAGENT_CALIBRATION).sort();
      const compKeys = Object.keys(COMPOSER_CALIBRATION).sort();
      expect(subKeys).toEqual(compKeys);

      for (const fam of ALL_MODEL_FAMILIES) {
        expect(SUBAGENT_CALIBRATION[fam]).toBeDefined();
        expect(COMPOSER_CALIBRATION[fam]).toBeDefined();
        expect(SUBAGENT_CALIBRATION[fam].length).toBeGreaterThan(10);
        expect(COMPOSER_CALIBRATION[fam].length).toBeGreaterThan(10);
      }
    });

    it('activates calibration ONLY when effort is high or max', () => {
      const lowRoute: RouteReceipt = {
        category: 'quick',
        selected: { model: 'gpt-5-4-mini', effort: 'low' },
        chainPosition: 0,
        signals: [],
      };
      const medRoute: RouteReceipt = {
        category: 'capable',
        selected: { model: 'claude-3-5-sonnet', effort: 'medium' },
        chainPosition: 0,
        signals: [],
      };
      const highRoute: RouteReceipt = {
        category: 'deep',
        selected: { model: 'deepseek-reasoner', effort: 'high' },
        chainPosition: 0,
        signals: [],
      };
      const maxRoute: RouteReceipt = {
        category: 'ultrabrain',
        selected: { model: 'o1', effort: 'max' },
        chainPosition: 0,
        signals: [],
      };

      expect(calibrationFor(lowRoute, 'subagent')).toBeUndefined();
      expect(calibrationFor(medRoute, 'subagent')).toBeUndefined();

      const highCalib = calibrationFor(highRoute, 'subagent');
      expect(highCalib).toBeDefined();
      expect(highCalib).toContain('[HIỆU CHUẨN DEEPSEEK]');

      const maxCalibComposer = calibrationFor(maxRoute, 'composer');
      expect(maxCalibComposer).toBeDefined();
      expect(maxCalibComposer).toContain('[ĐIỀU PHỐI GPT]');
    });
  });

  describe('assemblePrompt & Volatile Tail Ordering', () => {
    it('places SHARED_PREAMBLE first, universal blocks next, and volatileTail at the very end', () => {
      const route: RouteReceipt = {
        category: 'deep',
        selected: { model: 'deepseek-reasoner', effort: 'high' },
        chainPosition: 0,
        signals: [],
      };

      const tail = 'CURRENT_TIME: 2026-03-01T12:00:00Z\nMODIFIED_FILES: [lib/a.ts, lib/b.ts]';
      const prompt = assemblePrompt({
        route,
        role: 'subagent',
        unitContract: {
          id: 'unit-1',
          fileScope: ['src/core.ts'],
          dependsOn: ['unit-0'],
          doneCriteria: ['Test passes'],
          verificationCommand: 'npm test',
        },
        volatileTail: tail,
      });

      expect(prompt.startsWith(SHARED_PREAMBLE)).toBe(true);
      expect(prompt.includes(UNIVERSAL_BLOCKS.GOAL_ECHO_BACK)).toBe(true);
      expect(prompt.includes(UNIVERSAL_BLOCKS.DONE_CRITERIA)).toBe(true);
      expect(prompt.includes(UNIVERSAL_BLOCKS.BOUNDED_VERIFICATION)).toBe(true);
      expect(prompt.includes(UNIVERSAL_BLOCKS.FAILURE_KIND)).toBe(true);
      expect(prompt.includes('[HỢP ĐỒNG NHÁNH: unit-1]')).toBe(true);
      expect(prompt.endsWith(tail)).toBe(true);
    });

    it('assembles prompt cleanly without unit contract or volatile tail', () => {
      const route: RouteReceipt = {
        category: 'quick',
        selected: { model: 'gpt-4o-mini', effort: 'low' },
        chainPosition: 0,
        signals: [],
      };

      const prompt = assemblePrompt({ route });
      expect(prompt.startsWith(SHARED_PREAMBLE)).toBe(true);
      expect(prompt.includes(UNIVERSAL_BLOCKS.FAILURE_KIND)).toBe(true);
      expect(prompt).not.toContain('[HIỆU CHUẨN');
      expect(prompt).not.toContain('[HỢP ĐỒNG NHÁNH');
    });
  });
});
