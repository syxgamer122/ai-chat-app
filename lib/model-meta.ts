/**
 * Siêu dữ liệu model cho picker (Đề xuất / Gần đây / Yêu thích / nhóm hãng).
 * Module thuần, không DOM: mọi logic sections chạy test được ở NODE env.
 *
 * Quy ước hint (dòng mô tả thứ 2 trong picker), chỉ ba nguồn hợp lệ:
 *  - model catalog built-in: description chính thức của catalog;
 *  - model media: câu tác vụ + thời lượng thật ('Tạo ảnh từ mô tả',
 *    'Tạo video, 2-5 phút'), không mô tả lung tung;
 *  - provider custom: KHÔNG hint (gateway không khai báo gì thêm).
 * contextWindowTokens/contextLength không bao giờ làm hint: nó là cột số
 * riêng (fmtCtx) bên phải dòng.
 */

import { AVAILABLE_MODELS, DEFAULT_MODEL_ID, type ModelConfig } from '@/lib/models';
import { detectMediaKind, type MediaKind } from '@/lib/media-models';
import type { ProviderModel } from '@/lib/provider-url';

export type ModelCapability = 'vision' | 'pdf' | 'reasoning';

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  /** Cửa sổ ngữ cảnh (token), hiển thị dạng '1M'/'400k' ở cột phải. */
  ctx?: number;
  /** Capability có thật từ metadata; không biết thì không có badge. */
  caps?: ModelCapability[];
  media?: MediaKind;
}

/** Model đánh dấu yêu thích: set theo cặp (id, providerId). */
export interface ModelFavorite {
  id: string;
  providerId: string;
}

/** Model dùng gần đây, mới nhất đứng đầu. */
export interface RecentModel {
  id: string;
  providerId: string;
  ts: number;
}

export const MAX_FAVORITES = 30;
export const MAX_RECENTS = 6;
/** Gần đây chỉ hiển thị 4 mục mới nhất trong menu. */
export const MAX_RECENTS_SHOWN = 4;

export const MEDIA_HINTS: Record<MediaKind, string> = {
  image: 'Tạo ảnh từ mô tả',
  video: 'Tạo video, 2-5 phút',
};

function capsFromFlags(
  supportsImages: boolean,
  supportsPdf: boolean,
  isReasoning: boolean,
): ModelCapability[] | undefined {
  const caps: ModelCapability[] = [];
  if (supportsImages) caps.push('vision');
  if (supportsPdf) caps.push('pdf');
  if (isReasoning) caps.push('reasoning');
  return caps.length ? caps : undefined;
}

function isModelConfig(m: ModelConfig | ProviderModel): m is ModelConfig {
  return 'description' in m && 'category' in m;
}

/**
 * Dựng ModelOption mở rộng từ catalog built-in (ModelConfig) hoặc từ entry
 * /v1/models của provider (ProviderModel). Caps chỉ xuất hiện khi metadata
 * khai báo thật; model custom không khai báo thì không badge, không đoán.
 */
export function deriveModelOption(source: ModelConfig | ProviderModel): ModelOption {
  if (isModelConfig(source)) {
    const media = source.media ?? detectMediaKind(source.id, source.name);
    if (media) {
      // Model media: ctx 4000 của route ảnh là giới hạn nội bộ, không phải
      // cửa sổ chat, nên cố tình bỏ ctx để không gây hiểu nhầm.
      return {
        id: source.id,
        label: source.name,
        hint: MEDIA_HINTS[media],
        media,
      };
    }
    return {
      id: source.id,
      label: source.name,
      hint: source.description,
      ctx: source.contextWindowTokens,
      caps: capsFromFlags(source.supportsImages, source.supportsPdf, source.isReasoning),
    };
  }

  const media = detectMediaKind(source.id, source.name);
  if (media) {
    return {
      id: source.id,
      label: source.name || source.id,
      hint: MEDIA_HINTS[media],
      media,
    };
  }
  // Badge suy luận chỉ khi metadata kiểu OpenRouter khai báo và model thực sự
  // dùng được suy luận (có mức chọn được, hoặc bắt buộc luôn suy luận).
  const usesReasoning =
    !!source.reasoning &&
    (source.reasoning.efforts.length > 0 || source.reasoning.mandatory);
  return {
    id: source.id,
    label: source.name || source.id,
    ...(source.contextLength ? { ctx: source.contextLength } : {}),
    ...(usesReasoning ? { caps: ['reasoning' as const] } : {}),
  };
}

/**
 * '1M' / '1.1M' / '400k' / '999': cột ngữ cảnh compact. Giá trị rác (âm,
 * NaN) trả chuỗi rỗng để caller bỏ cột luôn.
 */
export function fmtCtx(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const fmtM = () => {
    const m = Math.round(n / 100_000) / 10;
    const s = m.toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}M`;
  };
  if (n >= 1_000_000) return fmtM();
  if (n >= 1000) {
    // k làm tròn lên tới 1000 (ví dụ 999_999) thì in dạng M: '1M' thay vì
    // '1000k', hai đơn vị không đứng cạnh nhau trên cùng một cột.
    const k = Math.round(n / 1000);
    return k >= 1000 ? fmtM() : `${k}k`;
  }
  return String(Math.round(n));
}

/**
 * Đưa model vừa chọn lên đầu Gần đây: dedupe theo (id, providerId), unshift,
 * cắt về cap 6. Thuần, không đổi mảng nhập vào.
 */
export function upsertRecent(
  list: readonly RecentModel[],
  id: string,
  providerId: string,
  now: number,
): RecentModel[] {
  const rest = list.filter((r) => !(r.id === id && r.providerId === providerId));
  return [{ id, providerId, ts: now }, ...rest].slice(0, MAX_RECENTS);
}

/** Bật/tắt Yêu thích theo (id, providerId); thêm mới thì đứng đầu, cap 30. */
export function toggleFavorite(
  list: readonly ModelFavorite[],
  id: string,
  providerId: string,
): ModelFavorite[] {
  const exists = list.some((f) => f.id === id && f.providerId === providerId);
  if (exists) {
    return list.filter((f) => !(f.id === id && f.providerId === providerId));
  }
  return [{ id, providerId }, ...list].slice(0, MAX_FAVORITES);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Khôi phục modelFavorites từ localStorage: bỏ entry rác (không phải object,
 * id/providerId rỗng), dedupe, cắt cap; không bao giờ throw.
 */
export function sanitizeModelFavorites(raw: unknown): ModelFavorite[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelFavorite[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (!isNonEmptyString(e.id) || !isNonEmptyString(e.providerId)) continue;
    if (out.some((f) => f.id === e.id && f.providerId === e.providerId)) continue;
    out.push({ id: e.id, providerId: e.providerId });
    if (out.length >= MAX_FAVORITES) break;
  }
  return out;
}

/** Tương tự sanitizeModelFavorites nhưng thêm yêu cầu ts hữu hạn. */
export function sanitizeRecentModels(raw: unknown): RecentModel[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentModel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (!isNonEmptyString(e.id) || !isNonEmptyString(e.providerId)) continue;
    if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) continue;
    if (out.some((r) => r.id === e.id && r.providerId === e.providerId)) continue;
    out.push({ id: e.id, providerId: e.providerId, ts: e.ts });
    if (out.length >= MAX_RECENTS) break;
  }
  return out;
}

// Nhóm model theo hãng / loại

interface VendorGroupDef {
  key: string;
  label: string;
  test: RegExp;
}

/** Hãng lớn trước. Media không nằm ở đây: media đi qua ModelOption.media
 *  (nguồn regex duy nhất: lib/media-models.ts) thay vì copy regex thứ 4. */
const VENDOR_GROUPS: VendorGroupDef[] = [
  { key: 'gpt', label: 'OpenAI · GPT', test: /(^|[^a-z0-9])(gpt|chatgpt|codex|o[134]($|[^a-z0-9]))/i },
  { key: 'claude', label: 'Anthropic · Claude', test: /claude|anthropic/i },
  { key: 'gemini', label: 'Google · Gemini', test: /gemini|gemma/i },
  { key: 'qwen', label: 'Alibaba · Qwen', test: /qwen/i },
  { key: 'deepseek', label: 'DeepSeek', test: /deepseek/i },
  { key: 'grok', label: 'xAI · Grok', test: /grok/i },
  { key: 'kimi', label: 'Moonshot · Kimi', test: /kimi/i },
  { key: 'glm', label: 'Zhipu · GLM', test: /glm/i },
  { key: 'minimax', label: 'MiniMax', test: /minimax/i },
];

const MEDIA_GROUPS: Array<{ key: string; label: string }> = [
  { key: 'image', label: 'Tạo ảnh' },
  { key: 'video', label: 'Tạo video' },
];

/** Nhóm của một option: media thắng hãng ('gpt-image-2' thuộc Tạo ảnh). */
export function detectModelGroupKey(m: ModelOption): string {
  if (m.media === 'image' || m.media === 'video') return m.media;
  const s = `${m.id} ${m.label}`;
  for (const g of VENDOR_GROUPS) {
    if (g.test.test(s)) return g.key;
  }
  return 'other';
}

/**
 * Đề xuất deterministic cho catalog built-in: model mặc định + model coding
 * đầu tiên + model fast đầu tiên của catalog, dedupe. Không bao giờ dựng cho
 * provider custom (không có description để giải thích 'tại sao').
 */
function suggestModelIds(): string[] {
  const ids: string[] = [DEFAULT_MODEL_ID];
  const coding = AVAILABLE_MODELS.find((m) => m.category === 'coding');
  if (coding) ids.push(coding.id);
  const fast = AVAILABLE_MODELS.find((m) => m.category === 'fast');
  if (fast) ids.push(fast.id);
  return [...new Set(ids)];
}

export interface PickerSection {
  key: string;
  label: string;
  items: ModelOption[];
  /**
   * true = section phím tắt (Đề xuất / Gần đây / Yêu thích): render một cột
   * full-width TRÊN grid 2 cột của các nhóm hãng.
   */
  quick: boolean;
}

export interface PickerSectionsInput {
  favorites?: readonly ModelFavorite[];
  recents?: readonly RecentModel[];
  currentId?: string;
  /** Provider đang active: Gần đây/Yêu thích chỉ lấy mục cùng provider. */
  providerId?: string;
  /** Chỉ catalog built-in mới có Đề xuất. */
  isBuiltinCatalog?: boolean;
  /** Query tìm kiếm active → mọi section sập thành một nhóm Kết quả. */
  query?: string;
}

/** Bỏ phần tử trùng id phía sau trong một danh sách đã map: lần đầu thắng. */
function dedupeById(items: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const m of items) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * Toàn bộ cấu trúc section của model picker. Ghost (recent/favorite trỏ model
 * không còn trong danh sách, ví dụ sau khi đổi provider) bị bỏ âm thầm chứ
 * không render hàng chết. Id trùng lặp bị khử ở cửa ngõ: một model đúng một
 * hàng, mọi nhánh (kể cả search) đều nhận danh sách đã dedupe.
 */
export function buildPickerSections(
  models: readonly ModelOption[],
  input: PickerSectionsInput = {},
): PickerSection[] {
  const {
    favorites = [],
    recents = [],
    currentId,
    providerId,
    isBuiltinCatalog = false,
    query = '',
  } = input;

  // Index theo id, lần xuất hiện ĐẦU thắng: vừa dedupe đầu vào vừa thay
  // models.find (O(n) mỗi lần tra) bằng tra O(1).
  const byId = new Map<string, ModelOption>();
  for (const m of models) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  const uniqueModels = [...byId.values()];

  const q = query.trim().toLowerCase();
  if (q) {
    const hits = uniqueModels.filter((m) => `${m.id} ${m.label}`.toLowerCase().includes(q));
    return [{ key: 'search', label: `Kết quả (${hits.length})`, items: hits, quick: false }];
  }

  const sections: PickerSection[] = [];

  if (isBuiltinCatalog) {
    const suggested = suggestModelIds()
      .map((id) => byId.get(id))
      .filter((m): m is ModelOption => m !== undefined);
    if (suggested.length) {
      sections.push({ key: 'suggested', label: 'Đề xuất', items: suggested, quick: true });
    }
  }

  const scopedRecents =
    providerId === undefined ? recents : recents.filter((r) => r.providerId === providerId);
  const recentItems = dedupeById(
    scopedRecents
      .map((r) => byId.get(r.id))
      .filter((m): m is ModelOption => m !== undefined && m.id !== currentId),
  ).slice(0, MAX_RECENTS_SHOWN);
  if (recentItems.length) {
    sections.push({ key: 'recent', label: 'Gần đây', items: recentItems, quick: true });
  }

  const scopedFavorites =
    providerId === undefined ? favorites : favorites.filter((f) => f.providerId === providerId);
  const favoriteItems = dedupeById(
    scopedFavorites
      .map((f) => byId.get(f.id))
      .filter((m): m is ModelOption => m !== undefined),
  );
  if (favoriteItems.length) {
    sections.push({ key: 'favorite', label: 'Yêu thích', items: favoriteItems, quick: true });
  }

  const byKey = new Map<string, ModelOption[]>();
  for (const m of uniqueModels) {
    const key = detectModelGroupKey(m);
    const arr = byKey.get(key);
    if (arr) arr.push(m);
    else byKey.set(key, [m]);
  }
  for (const g of [...VENDOR_GROUPS, ...MEDIA_GROUPS]) {
    const items = byKey.get(g.key);
    if (items?.length) {
      sections.push({ key: g.key, label: g.label, items, quick: false });
    }
  }
  const other = byKey.get('other');
  if (other?.length) {
    sections.push({ key: 'other', label: 'Khác', items: other, quick: false });
  }

  return sections;
}

/** Một hàng render: model kèm index theo thứ tự render thật của picker. */
export interface RenderRow {
  m: ModelOption;
  idx: number;
}

/** Section đã flatten thành hàng có index, giữ key/label để vẽ tiêu đề nhóm. */
export interface RenderSection {
  key: string;
  label: string;
  rows: RenderRow[];
}

export interface RenderLayout {
  quickSections: RenderSection[];
  columns: RenderSection[][];
  ordered: ModelOption[];
  renderIndex: Map<string, number>;
}

/**
 * Chia section ra hai khối render: quick (Đề xuất/Gần đây/Yêu thích) một
 * cột full-width, phần còn lại vào `colCount` cột cân theo số model để các
 * cột cao xấp xỉ nhau. Mỗi row nhận idx theo thứ tự render thật (quick trước,
 * cột trái hết rồi phải): 2 cột + quick section khiến thứ tự render khác thứ
 * tự mảng `models`, dùng nhầm index sẽ highlight/commit sai dòng. Model nằm
 * nhiều section (vừa Gần đây vừa nhóm hãng) lấy index của lần render ĐẦU cho
 * cursor. Hàm thuần, component chỉ việc vẽ.
 */
export function buildRenderLayout(sections: PickerSection[], colCount: number): RenderLayout {
  const ordered: ModelOption[] = [];
  const renderIndex = new Map<string, number>();
  const touch = (m: ModelOption): RenderRow => {
    const idx = ordered.length;
    ordered.push(m);
    if (!renderIndex.has(m.id)) renderIndex.set(m.id, idx);
    return { m, idx };
  };

  const quickSections: RenderSection[] = sections
    .filter((s) => s.quick)
    .map((s) => ({ key: s.key, label: s.label, rows: s.items.map(touch) }));

  const gridSections = sections.filter((s) => !s.quick);
  const nCols = Math.max(1, colCount);
  const cols: PickerSection[][] = Array.from({ length: nCols }, () => []);
  const counts = new Array(nCols).fill(0);
  for (const g of gridSections) {
    // Đưa vào cột đang "nhẹ" nhất để các cột cao xấp xỉ nhau.
    let target = 0;
    for (let i = 1; i < nCols; i++) if (counts[i] < counts[target]) target = i;
    cols[target].push(g);
    counts[target] += g.items.length;
  }
  const columns = cols.map((col) =>
    col.map((s) => ({ key: s.key, label: s.label, rows: s.items.map(touch) })),
  );

  return { quickSections, columns, ordered, renderIndex };
}
