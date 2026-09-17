/**
 * Mixture-of-models routing theo hạng mục công việc.
 *
 * Mỗi hạng mục (Category) ánh xạ sang một chuỗi dự phòng (Chain) các entry { model, effort }.
 * Người dùng có thể cấu hình chuỗi này trong Settings -> Routing hoặc override qua file JSON.
 * HUD hiển thị: category:name(model:effort).
 */

import { enforceContractEffort, resolveContract, EFFORT_LEVELS, type Effort } from '@/lib/model-contracts';

export type { Effort };

export type CategoryId =
  | 'ultrabrain'
  | 'deep'
  | 'architect'
  | 'capable'
  | 'quick'
  | 'writing'
  | 'visual-engineering'
  | 'simple-work';

export interface ChainEntry {
  model: string;
  effort: Effort;
}

export interface RouteReceipt {
  category: CategoryId;
  selected: ChainEntry;
  chainPosition: number;
  signals: string[];
  effortChange?: { kind: 'floor_raised' | 'unsupported_dropped'; from: Effort; to: Effort };
}

/**
 * Chuỗi model & effort mặc định ánh xạ vào 6 model OpenAI trong Vyen.
 * Tầng gateway miễn phí đã gỡ — chỉ còn model chính gốc OpenAI.
 */
export const DEFAULT_CHAINS: Record<CategoryId, ChainEntry[]> = {
  ultrabrain: [
    { model: 'o1', effort: 'max' },
    { model: 'o3-mini', effort: 'max' },
  ],
  architect: [
    { model: 'o1', effort: 'high' },
    { model: 'gpt-4o', effort: 'high' },
  ],
  deep: [
    { model: 'o1', effort: 'high' },
    { model: 'o3-mini', effort: 'high' },
  ],
  capable: [
    { model: 'gpt-4o', effort: 'medium' },
    { model: 'chatgpt-4o-latest', effort: 'medium' },
  ],
  quick: [
    { model: 'gpt-4o-mini', effort: 'low' },
    { model: 'o1-mini', effort: 'low' },
  ],
  writing: [
    { model: 'gpt-4o', effort: 'medium' },
    { model: 'chatgpt-4o-latest', effort: 'medium' },
  ],
  'visual-engineering': [
    { model: 'gpt-4o', effort: 'high' },
    { model: 'chatgpt-4o-latest', effort: 'high' },
  ],
  'simple-work': [
    { model: 'gpt-4o-mini', effort: 'low' },
    { model: 'o1-mini', effort: 'low' },
  ],
};

/** Nhãn hiển thị mô tả cho từng hạng mục trong UI */
export const CATEGORY_DESCRIPTIONS: Record<CategoryId, { label: string; description: string }> = {
  ultrabrain: {
    label: 'Ultrabrain',
    description: 'Bài toán hóc búa, suy luận tối đa, giải thuật phức tạp',
  },
  architect: {
    label: 'Kiến trúc (Architect)',
    description: 'Thiết kế hệ thống, refactor nhiều file, Plan Mode',
  },
  deep: {
    label: 'Suy luận sâu (Deep)',
    description: 'Debug nguyên nhân gốc rễ, logic & toán học, phân tích lỗi',
  },
  capable: {
    label: 'Năng lực chuẩn (Capable)',
    description: 'Lập trình thông thường, giải quyết tính năng cân bằng',
  },
  quick: {
    label: 'Nhanh (Quick)',
    description: 'Sửa lỗi nhỏ, đổi tên 1 file, phản hồi tức thì',
  },
  writing: {
    label: 'Viết tài liệu (Writing)',
    description: 'Viết README, tài liệu, dịch thuật, giải thích prose',
  },
  'visual-engineering': {
    label: 'Giao diện & Mỹ thuật (Visual UI)',
    description: 'CSS, Tailwind, layout, frontend component, visual inspection',
  },
  'simple-work': {
    label: 'Tác vụ đơn giản (Simple)',
    description: 'Kiểm tra cú pháp, format văn bản, tác vụ phụ trợ nhẹ nhất',
  },
};

export const ALL_CATEGORIES: readonly CategoryId[] = [
  'ultrabrain',
  'deep',
  'architect',
  'capable',
  'quick',
  'writing',
  'visual-engineering',
  'simple-work',
] as const;

/**
 * Phân giải RouteReceipt cho một hạng mục cụ thể:
 * - Chọn entry ở thứ tự chainPosition (mặc định 0)
 * - Nếu entry đầu bị lỗi (404/not found), caller tăng chainPosition để fallback
 * - Áp dụng sàn effort từ ModelContract nếu có
 */
export function resolveRoute(
  category: CategoryId,
  options?: {
    customChains?: Partial<Record<CategoryId, ChainEntry[]>>;
    position?: number;
    signals?: string[];
  },
): RouteReceipt {
  const chains = options?.customChains?.[category]?.length
    ? options.customChains[category]!
    : DEFAULT_CHAINS[category] ?? DEFAULT_CHAINS.capable;

  const requestedPos = Math.max(0, Math.floor(options?.position ?? 0));
  const safePos = Math.min(requestedPos, chains.length - 1);
  const entry = chains[safePos] ?? chains[0];

  const contract = resolveContract(entry.model);
  const { effectiveEffort, changed } = enforceContractEffort(contract, entry.effort);

  return {
    category,
    selected: {
      model: entry.model,
      effort: effectiveEffort,
    },
    chainPosition: safePos,
    signals: options?.signals ?? [],
    ...(changed ? { effortChange: changed } : {}),
  };
}

/**
 * Xác thực và chuẩn hóa cấu hình chuỗi modelChains nhập từ JSON.
 * Ném lỗi rõ ràng nếu payload bị hỏng hoặc sai cấu trúc để bảo vệ settings store.
 */
export function validateModelChains(input: unknown): Record<CategoryId, ChainEntry[]> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Dữ liệu cấu hình phải là một JSON Object.');
  }

  const validCategories = new Set(ALL_CATEGORIES);
  const validEfforts = new Set(EFFORT_LEVELS);
  const result: Record<CategoryId, ChainEntry[]> = { ...DEFAULT_CHAINS };
  let importedCount = 0;

  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    if (!validCategories.has(key as CategoryId)) continue;
    if (!Array.isArray(val) || val.length === 0) {
      throw new Error(`Hạng mục "${key}" phải là mảng chứa ít nhất 1 chuỗi model:effort.`);
    }

    const validatedEntries: ChainEntry[] = [];
    for (const item of val) {
      if (typeof item !== 'object' || item === null) {
        throw new Error(`Entry trong hạng mục "${key}" không đúng định dạng.`);
      }
      const model = String((item as any).model ?? '').trim();
      const effort = String((item as any).effort ?? '').toLowerCase() as Effort;
      if (!model) {
        throw new Error(`Hạng mục "${key}" có entry thiếu tên model.`);
      }
      if (!validEfforts.has(effort)) {
        throw new Error(`Mức effort "${effort}" trong "${key}" không hợp lệ (chỉ chấp nhận low/medium/high/max).`);
      }
      validatedEntries.push({ model, effort });
    }

    result[key as CategoryId] = validatedEntries;
    importedCount++;
  }

  if (importedCount === 0) {
    throw new Error('Không tìm thấy cấu hình hạng mục hợp lệ nào trong file JSON.');
  }

  return result;
}
