import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  ACTIVE_MODEL_BODY_FIELD,
  ACTIVE_MODEL_FIELD,
  buildActiveModelChain,
  isActiveProvider,
  prependActiveModel,
} from '@/lib/aux-llm-chain';
import {
  filterSupportedModels,
  markModelUnsupported,
  resetModelNegativeCache,
} from '@/lib/model-negative-cache';

/* Hermetic: chỉ hàm thuần + zod schema, không mạng, không env thật. */

describe('isActiveProvider', () => {
  it('không header nào -> false (chế độ demo dùng env máy chủ)', () => {
    expect(isActiveProvider(undefined, undefined)).toBe(false);
  });

  it('có baseUrl nhưng không key (provider-no-key) -> vẫn là provider active', () => {
    // Gateway miễn phí: route thay key bằng 'provider-no-key' — chuỗi model
    // phải theo provider người dùng, không theo env máy chủ.
    expect(isActiveProvider('https://gpt.crax.lol/v1', undefined)).toBe(true);
  });

  it('chỉ có key BYOK -> provider active', () => {
    expect(isActiveProvider(undefined, 'sk-user-key')).toBe(true);
  });

  it('có cả baseUrl và key -> provider active', () => {
    expect(isActiveProvider('https://openrouter.ai/api/v1', 'sk-or-1')).toBe(true);
  });

  it('chuỗi rỗng coi như không có -> false', () => {
    expect(isActiveProvider('', '')).toBe(false);
  });
});

describe('prependActiveModel', () => {
  it('không có model -> trả bản sao chuỗi gốc, giữ nguyên thứ tự', () => {
    const chain = ['a', 'b', 'c'];
    expect(prependActiveModel(undefined, chain)).toEqual(['a', 'b', 'c']);
    // Mảng MỚI — không trả chính tham số đầu vào.
    expect(prependActiveModel(undefined, chain)).not.toBe(chain);
  });

  it('model rỗng / toàn khoảng trắng -> coi như không có', () => {
    expect(prependActiveModel('', ['a'])).toEqual(['a']);
    expect(prependActiveModel('   ', ['a'])).toEqual(['a']);
  });

  it('model hợp lệ -> lên đầu, chuỗi gốc đi sau nguyên thứ tự', () => {
    expect(prependActiveModel('user-model', ['a', 'b'])).toEqual(['user-model', 'a', 'b']);
  });

  it('model đã nằm trong chuỗi -> khử trùng, không lặp', () => {
    expect(prependActiveModel('a', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('khử trùng theo so khớp chính xác, phân biệt hoa thường', () => {
    // 'A' và 'a' là hai model_id khác nhau trên OpenAI-compatible API.
    expect(prependActiveModel('A', ['a', 'A'])).toEqual(['A', 'a']);
  });

  it('model thừa khoảng trắng vẫn được dùng sau khi trim', () => {
    expect(prependActiveModel('  user-model  ', ['a'])).toEqual(['user-model', 'a']);
  });

  it('không đột biến chuỗi gốc (immutable)', () => {
    const chain = Object.freeze(['a', 'b']);
    expect(() => prependActiveModel('x', chain)).not.toThrow();
    expect(chain).toEqual(['a', 'b']);
  });
});

describe('buildActiveModelChain — chính sách provider active', () => {
  it('provider active + có model -> model người dùng lên ĐẦU, env làm dự phòng', () => {
    expect(
      buildActiveModelChain({
        providerActive: true,
        model: 'my-model',
        fallbackChain: ['gpt-5-4-nano', 'gpt-4o-mini'],
      }),
    ).toEqual(['my-model', 'gpt-5-4-nano', 'gpt-4o-mini']);
  });

  it('provider active + model trùng tên trong env chain -> khử trùng', () => {
    expect(
      buildActiveModelChain({
        providerActive: true,
        model: 'gpt-4o-mini',
        fallbackChain: ['gpt-4o-mini', 'gpt-5-6-terra'],
      }),
    ).toEqual(['gpt-4o-mini', 'gpt-5-6-terra']);
  });

  it('provider active + KHÔNG model -> dùng nguyên env chain (đã filter sẵn)', () => {
    expect(
      buildActiveModelChain({
        providerActive: true,
        model: undefined,
        fallbackChain: ['gpt-5-4-nano', 'gpt-4o-mini'],
      }),
    ).toEqual(['gpt-5-4-nano', 'gpt-4o-mini']);
  });

  it('demo (không provider) + client vẫn gửi model -> BỎ QUA model, y env chain', () => {
    // Bảo đảm hành vi demo giữ nguyên 100%: body.model chỉ có hiệu lực khi
    // request mang provider của người dùng.
    expect(
      buildActiveModelChain({
        providerActive: false,
        model: 'my-model',
        fallbackChain: ['gpt-5-4-nano', 'gpt-4o-mini'],
      }),
    ).toEqual(['gpt-5-4-nano', 'gpt-4o-mini']);
  });

  it('demo + không model -> env chain', () => {
    expect(
      buildActiveModelChain({
        providerActive: false,
        model: undefined,
        fallbackChain: ['gpt-5-4-nano'],
      }),
    ).toEqual(['gpt-5-4-nano']);
  });
});

describe('ACTIVE_MODEL_FIELD — schema model dùng chung của 3 route phụ', () => {
  it('chặn chuỗi rỗng và toàn khoảng trắng', () => {
    expect(ACTIVE_MODEL_FIELD.safeParse('').success).toBe(false);
    expect(ACTIVE_MODEL_FIELD.safeParse('   ').success).toBe(false);
  });

  it('chặn tên có khoảng trắng / xuống dòng / ký tự lạ', () => {
    expect(ACTIVE_MODEL_FIELD.safeParse('gpt 4o').success).toBe(false);
    expect(ACTIVE_MODEL_FIELD.safeParse('gpt-4o;drop').success).toBe(false);
    expect(ACTIVE_MODEL_FIELD.safeParse('model\nid').success).toBe(false);
    expect(ACTIVE_MODEL_FIELD.safeParse('model?id=1').success).toBe(false);
  });

  it('chặn tên dài quá 120 ký tự', () => {
    expect(ACTIVE_MODEL_FIELD.safeParse('a'.repeat(120)).success).toBe(true);
    expect(ACTIVE_MODEL_FIELD.safeParse('a'.repeat(121)).success).toBe(false);
  });

  it('chấp nhận tên model thực tế (dấu gạch, chấm, hai chấm, slash, ngã)', () => {
    for (const id of [
      'gpt-5-4-nano',
      'deepseek/deepseek-r1:free',
      'org/model.v2~/x',
      'Qwen3.5_Flash',
    ]) {
      expect(ACTIVE_MODEL_FIELD.safeParse(id).success).toBe(true);
    }
  });

  it('trần 120 ký tự nới hơn 64 cũ — model id `vendor/model:tag` thật vẫn qua', () => {
    // Tên thật của gateway dễ vượt 64: đây là lý do nới, không phải nới bừa.
    const realistic =
      'deepseek-ai/deepseek-r1-0528-distill-qwen3-8b-instruct:free-community-preview';
    expect(realistic.length).toBeGreaterThan(64);
    expect(realistic.length).toBeLessThanOrEqual(120);
    expect(ACTIVE_MODEL_FIELD.safeParse(realistic).success).toBe(true);
  });
});

describe('ACTIVE_MODEL_BODY_FIELD — model rác chỉ bị BỎ QUA, không giết request', () => {
  /* Mô phỏng đúng cách 3 route dùng: field phụ nằm cạnh field chính. Trước
     đây model rác làm cả safeParse fail → /api/title trả 'New Chat' ghi đè
     tiêu đề heuristic, /api/compact + /api/orchestrate trả bad_schema. */
  const RouteBody = z.object({
    message: z.string().min(1),
    model: ACTIVE_MODEL_BODY_FIELD,
  });

  it('model hợp lệ được giữ', () => {
    const parsed = RouteBody.safeParse({ message: 'hi', model: 'deepseek/r1:free' });
    expect(parsed.success && parsed.data.model).toBe('deepseek/r1:free');
  });

  it('thiếu model -> parse thành công, model undefined', () => {
    const parsed = RouteBody.safeParse({ message: 'hi' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.model).toBeUndefined();
  });

  it('model rác (khoảng trắng, ký tự lạ, rỗng, sai kiểu) -> BỎ QUA, body vẫn hợp lệ', () => {
    for (const bad of ['gpt 4o', 'model?id=1', '', '   ', 'a'.repeat(121), 123, null, {}]) {
      const parsed = RouteBody.safeParse({ message: 'hi', model: bad });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.model).toBeUndefined();
    }
  });

  it('field CHÍNH sai thì vẫn fail — catch chỉ áp cho model', () => {
    expect(RouteBody.safeParse({ message: '', model: 'ok-model' }).success).toBe(false);
  });

  it('model rác + chuỗi dự phòng -> chain giữ nguyên env chain, không có tên rác', () => {
    const parsed = RouteBody.safeParse({ message: 'hi', model: 'tên có khoảng trắng' });
    expect(parsed.success).toBe(true);
    expect(
      buildActiveModelChain({
        providerActive: true,
        model: parsed.success ? parsed.data.model : undefined,
        fallbackChain: ['gpt-5-4-nano'],
      }),
    ).toEqual(['gpt-5-4-nano']);
  });
});

describe('ghép với filterSupportedModels theo đúng thứ tự dựng chain của route', () => {
  beforeEach(() => resetModelNegativeCache());

  it('route lọc env chain TRƯỚC rồi mới prepend model người dùng', () => {
    const base = 'https://my-provider.dev/v1';
    markModelUnsupported(base, 'gpt-4o-mini'); // model env vừa 404 trên provider người dùng
    const filtered = filterSupportedModels(base, ['gpt-5-4-nano', 'gpt-4o-mini', 'deepseek-v4-flash']);
    expect(filtered).toEqual(['gpt-5-4-nano', 'deepseek-v4-flash']);
    // Model người dùng không bị negative-cache chặn: họ chủ động chọn nó,
    // chuỗi env (đã lọc) chỉ là dự phòng khi nó 404.
    expect(
      buildActiveModelChain({ providerActive: true, model: 'my-model', fallbackChain: filtered }),
    ).toEqual(['my-model', 'gpt-5-4-nano', 'deepseek-v4-flash']);
  });

  it('demo: lọc env chain và bỏ qua model client gửi — hành vi cũ nguyên vẹn', () => {
    const base = 'https://gateway-mac-chu.dev/v1';
    markModelUnsupported(base, 'gpt-5-4-nano');
    const filtered = filterSupportedModels(base, ['gpt-5-4-nano', 'gpt-4o-mini']);
    expect(filtered).toEqual(['gpt-4o-mini']);
    expect(
      buildActiveModelChain({ providerActive: false, model: 'my-model', fallbackChain: filtered }),
    ).toEqual(['gpt-4o-mini']);
  });
});
