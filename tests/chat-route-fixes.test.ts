/**
 * Khoá hồi quy cho các bản sửa bug trong app/api/chat/route.ts.
 *
 * POST /api/chat đẩy cả pool key, hàng đợi gateway, streamText và data-stream
 * vào một hàm duy nhất — mock đủ tầng đó trong vitest thì test xanh vì mock
 * chứ không phải vì code đúng. Repo đã có pattern đọc-source
 * (tests/design-system.test.ts, tests/tool-trace.test.ts): khoá các điều kiện
 * sống còn bằng regex lên source. Bản cũ lỗi thì regex không khớp → ĐỎ ngay.
 *
 * Mỗi describe ghi rõ điều kiện đảo ngược nào làm test ĐỎ — đó là hợp đồng
 * của file này, không phải trang trí.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksLikePseudoError } from '@/lib/pseudo-error-response';

const ROUTE_PATH = path.resolve(__dirname, '../app/api/chat/route.ts');
const source = fs.readFileSync(ROUTE_PATH, 'utf8');

/** Lỗi trá hình THẬT của crax (HTTP 200 + finish 'stop' + nội dung lỗi). */
const REAL_CRAX_ERROR =
  '\n\n[Notion is currently unavailable — tried 22 accounts over 0s, every account ' +
  "tried is over its usage cap for this model right now. This usually clears within a " +
  "few minutes as the account pool refreshes; try again shortly, or shorten/simplify " +
  "the prompt if it's very large. If it keeps happening, report it in the Discord.]";

/**
 * Bug 1 (A3) + Bug 2 (A5): đường GIẢ LẬP tool (emulatedMode do negative-cache
 * tool-support, hoặc retryAsEmulated sau khi gateway chê field `tools`) vẫn
 * phải nhận ĐỦ server tools + MCP tools. Bản cũ điều kiện chỉ là
 * `allowAgentTools || forceEmulatedTools`: vào emulated do isToolUnsupported
 * đặt allowAgentTools=false thì serverTools={} và mcpTools=mapMcpTools([]) —
 * model mất trắng web_search/web_fetch/weather/exchange_rates/memory_save và
 * toàn bộ tool MCP mà không có thông báo nào.
 *
 * Đảo điều kiện (bỏ `emulatedToolPath` khỏi một trong hai ternary) → cả
 * describe này ĐỎ.
 */
describe('A3/A5 — đường emulated vẫn đủ server tools + MCP tools', () => {
  it('điều kiện build serverTools/mcpTools có đủ nhánh emulatedToolPath', () => {
    expect(source).toMatch(
      /const emulatedToolPath = emulatedMode \|\| retryAsEmulated;/,
    );
    expect(source).toMatch(
      /const serverTools = allowAgentTools \|\| forceEmulatedTools \|\| emulatedToolPath\s*\n\s*\? buildAgentTools\(\{/,
    );
    expect(source).toMatch(
      /const mcpTools = allowAgentTools \|\| forceEmulatedTools \|\| emulatedToolPath\s*\n\s*\? mapMcpTools\(mcpToolList \?\? \[\], undefined, mcpProxyToolList \?\? \[\]\)/,
    );
  });

  it('runEmulatedLoop nhận đúng serverTools + schema MCP qua extraToolDocs', () => {
    // Đường emulated không có kênh tool-call native: không đưa tools vào
    // runEmulatedLoop là model không bao giờ biết tool tồn tại.
    expect(source).toMatch(
      /tools: serverTools as ReturnType<typeof buildAgentTools>,/,
    );
    expect(source).toMatch(/extraToolDocs: mcpTools\.defs,/);
    expect(source).toMatch(/clientTools: clientToolNames,/);
  });
});

/**
 * Bug 3 (A4): nhánh fallback Pollinations (gateway chính không trả ảnh) kết
 * thúc bằng `writeFinish('stop'); return;` — bản cũ return không dọn, để lại
 * CẢ idleTimer lẫn budgetTimer (tới 290s với model video) chạy tiếp sau khi
 * stream đã khép.
 *
 * Đảo điều kiện (xoá một trong ba lệnh dọn khỏi khối `if (poll)`) → describe
 * này ĐỎ: prefix thiếu hoặc thứ tự sai.
 */
describe('A4 — nhánh Pollinations dọn đủ timer + ghi công key', () => {
  const blockMatch = source.match(
    /const poll = pollinationsMarkdown\(lastUser, targetModel\);\s*\n\s*if \(poll\) \{([\s\S]*?)\n\s*return;/,
  );

  it('tồn tại khối `if (poll)` với lối thoát return', () => {
    expect(blockMatch).not.toBeNull();
  });

  it.skipIf(!blockMatch)('đủ clearIdle + clearTimeout(budgetTimer) + markKeySuccess TRƯỚC writeFinish', () => {
    const block = blockMatch![1];
    for (const token of ['clearIdle();', 'clearTimeout(budgetTimer);', 'markKeySuccess(apiKey);']) {
      expect(block).toContain(token);
    }
    // Thứ tự: cả ba lệnh dọn phải chạy trước khi stream khép lại.
    const finishAt = block.indexOf("writeFinish('stop')");
    expect(finishAt).toBeGreaterThan(block.indexOf('clearIdle();'));
    expect(finishAt).toBeGreaterThan(block.indexOf('clearTimeout(budgetTimer);'));
    expect(finishAt).toBeGreaterThan(block.indexOf('markKeySuccess(apiKey);'));
  });
});

/**
 * Bug 4 (A10): đường native nhận finish/step-finish MỖI vòng tool — bản cũ
 * gán đè `usage = part.usage...` nên lượt agent nhiều step chỉ còn usage của
 * step cuối (undercount thống kê).
 *
 * Đảo điều kiện (đổi `+` cộng dồn về gán thẳng) → describe này ĐỎ.
 */
describe('A10 — usage native cộng dồn qua các step', () => {
  it('nhánh finish/step-finish cộng dồn thay vì ghi đè', () => {
    expect(source).toMatch(
      /case 'finish':\s*\n\s*case 'step-finish':\s*\n\s*if \(part\.usage\) \{\s*\n[\s\S]*?usage = \{\s*\n\s*promptTokens: \(usage\?\.promptTokens \?\? 0\) \+ \(part\.usage\.promptTokens \?\? 0\),\s*\n\s*completionTokens: \(usage\?\.completionTokens \?\? 0\) \+ \(part\.usage\.completionTokens \?\? 0\),/,
    );
  });

  it('đường emulated cộng dồn cùng kiểu (onUsage các round)', () => {
    expect(source).toMatch(
      /onUsage: \(u\) => \{\s*\n[\s\S]*?promptTokens: \(usage\?\.promptTokens \?\? 0\) \+ \(u\.promptTokens \?\? 0\),/,
    );
  });
});

/**
 * Bug 5 (A13): `isLastModelInChain` phải so VỊ TRÍ (modelIndex === length-1)
 * chứ không so GIÁ TRỊ (targetModel === modelChain[length-1]) — chain có thể
 * chứa cùng một tên model ở nhiều vị trí; so giá trị khiến ô giữa chain bị
 * coi là "model cuối", failover dừng sớm và bỏ sót phần chain còn lại.
 *
 * Đảo điều kiện (đổi về so giá trị) → describe này ĐỎ (regex khớp dạng
 * modelIndex không còn, dạng targetModel bị not.toMatch chặn).
 */
describe('A13 — isLastModelInChain so vị trí, không so giá trị', () => {
  it('khai báo theo modelIndex', () => {
    expect(source).toMatch(
      /const isLastModelInChain = modelIndex === modelChain\.length - 1;/,
    );
  });

  it('không còn dạng so giá trị của bản cũ', () => {
    expect(source).not.toMatch(
      /isLastModelInChain = targetModel ===/,
    );
  });
});

/**
 * Bug 6 (A14): reasoningEffort phải tính theo model THẬT của từng ô failover
 * (targetModel trong vòng lặp). Bản cũ tính MỘT LẦN ngoài vòng lặp từ model
 * user chọn, và biến ngoài đó shadow tên `targetModel` — sau failover mức
 * reasoning của model cũ vẫn được gửi theo model mới.
 *
 * Đảo điều kiện (kéo khai báo ra ngoài vòng lặp / đặt lại shadow) → describe
 * này ĐỎ: hoặc khai báo đứng cạnh emulatedMode (bị not.toMatch chặn), hoặc
 * vị trí ra khỏi khoảng [vòng lặp modelIndex .. streamText].
 */
describe('A14 — reasoningEffort tính theo targetModel trong từng ô failover', () => {
  it('biến model-được-chọn đổi tên, hết shadow targetModel', () => {
    expect(source).toMatch(/const selectedProviderModel = modelConfig\.providerModel;/);
    expect(source).not.toMatch(/const targetModel = modelConfig\.providerModel;/);
  });

  it('không còn khối tính reasoningEffort ngay sau emulatedMode (vị trí cũ ngoài vòng lặp)', () => {
    expect(source).not.toMatch(
      /const emulatedMode = \(agentTools \?\? true\) && !allowAgentTools;\s*\nlet reasoningEffort/,
    );
  });

  it('reasoningEffort khai báo đúng MỘT lần, nằm TRONG vòng lặp model trước streamText', () => {
    const decls = source.match(/let reasoningEffort: ThinkingLevel \| null = null;/g) ?? [];
    expect(decls).toHaveLength(1);

    const declAt = source.indexOf('let reasoningEffort: ThinkingLevel | null = null;');
    const loopAt = source.indexOf('for (let modelIndex = 0;');
    const streamAt = source.indexOf('const result = streamText(');
    expect(declAt).toBeGreaterThan(loopAt);
    expect(declAt).toBeLessThan(streamAt);

    // Tra capability theo model ĐANG gọi của ô này, không theo model user chọn.
    expect(source).toMatch(
      /const cap = await getReasoningCapability\(effortBase, targetModel\);/,
    );
  });
});

/**
 * Bug 7 (A15): trần dài tên model ở BodySchema phải là 120 (khớp validator
 * provider-override `{1,120}` và lib/store.ts). Bản cũ `max(64)` từ chối model
 * `vendor/repo/name` dài hợp lệ mà mọi tầng sau đều chấp nhận.
 *
 * Đảo điều kiện (đổi về max(64)) → describe này ĐỎ.
 */
describe('A15 — trần tên model 120 ký tự', () => {
  it('schema cho phép 120, không còn 64', () => {
    expect(source).toMatch(/model: z\.string\(\)\.min\(1\)\.max\(120\)\.optional\(\)/);
    expect(source).not.toMatch(/model: z\.string\(\)\.min\(1\)\.max\(64\)/);
    // Validator provider-override cũng phải đồng bộ 120 (dùng chuỗi literal
    // thay regex: ký tự `/` trong character class khó đọc khi escape).
    expect(source).toContain('/^[\\w.\\-:~/]{1,120}$/');
  });
});

/**
 * Bug 8 (A16): UPSTREAM_POOL_EXHAUSTED phải trả ĐÚNG mã + thông điệp "hết
 * dung lượng" — ChatUpstreamError không mang status, rơi vào
 * diagnoseUpstreamError sẽ bị gán nhầm "Không kết nối được tới AI Provider".
 * Bản cũ ở ô cuối không thoát sớm nên diagnosis ghi đè thông điệp.
 *
 * Đảo điều kiện (xoá `throw e` / để lỗi chảy xuống diagnoseUpstreamError) →
 * describe này ĐỎ: nhánh throw biến mất hoặc đứng sau diagnosis.
 */
describe('A16 — pool cạn giữ đúng mã UPSTREAM_POOL_EXHAUSTED', () => {
  const branchAt = source.indexOf(
    "if (e instanceof ChatUpstreamError && e.code === 'UPSTREAM_POOL_EXHAUSTED') {",
  );
  const diagnoseAt = source.indexOf('const diagnosis = diagnoseUpstreamError(');

  it('nhánh pool-exhausted tồn tại và xử lý TRƯỚC diagnoseUpstreamError', () => {
    expect(branchAt).toBeGreaterThan(-1);
    expect(diagnoseAt).toBeGreaterThan(-1);
    expect(branchAt).toBeLessThan(diagnoseAt);
  });

  it.skipIf(branchAt === -1)('chỉ failover khi còn ô; hết ô thì annotation + rethrow nguyên error', () => {
    const tail = source.slice(branchAt, branchAt + 2600);
    // Còn model/key kế tiếp (và chưa phát token) → chuyển tiếp, không báo lỗi.
    expect(tail).toMatch(
      /if \(emittedChars === 0 && !\(isLastModelInChain && isLastKeyAttempt\)\) \{/,
    );
    // Hết ô (hoặc pseudo-error lộ giữa luồng đã có token) → phát error part
    // rồi ném lại CHÍNH error gốc: giữ message "hết dung lượng" + mã.
    expect(tail).toContain("writeAnnotation({ error: 'UPSTREAM_POOL_EXHAUSTED' });");
    const throwAt = tail.indexOf('throw e;');
    expect(throwAt).toBeGreaterThan(-1);
    expect(tail.indexOf("writeAnnotation({ error: 'UPSTREAM_POOL_EXHAUSTED' });")).toBeLessThan(throwAt);
  });

  it('onError giữ nguyên message + mã của ChatUpstreamError cho người dùng', () => {
    expect(source).toMatch(
      /onError: \(err\) => \{\s*\n\s*if \(err instanceof ChatUpstreamError\) return `\$\{err\.message\} \[\$\{err\.code\}#\$\{err\.requestId\}\]`;/,
    );
  });
});

/**
 * Bug 9 (A22): buffer sniff đầu stream. Bản cũ ghì 120 ký tự trước khi nhả
 * token đầu. Bản mới ghì 40 ký tự (token đầu nhanh hơn) + sniff TIẾP cửa sổ
 * 600 ký tự sau khi đã nhả — pseudo-error ló ra giữa chừng vẫn ném
 * UPSTREAM_POOL_EXHAUSTED cho handler A16 ở trên.
 *
 * Đảo điều kiện: nâng SNIFF_HOLD_CHARS về ≥120 → test "hold < 120" ĐỎ (token
 * đầu chậm đi). Hạ hold xuống dưới độ dài khớp tối thiểu của payload thật
 * (~34) → test hành vi với lib ĐỎ (lỗ hổng bỏ sót lỗi thật). Xoá nhánh sniff
 * sau release → regex "phát hiện giữa luồng" ĐỎ.
 */
describe('A22 — sniff 40 ký tự đầu + cửa sổ 600 ký tự giữa luồng', () => {
  const hold = Number(source.match(/const SNIFF_HOLD_CHARS = (\d+);/)?.[1] ?? NaN);
  const windowChars = Number(source.match(/const SNIFF_WINDOW_CHARS = (\d+);/)?.[1] ?? NaN);

  it('tham số sniff tồn tại; hold thấp hơn ngưỡng cũ 120 → token đầu không chậm hơn xưa', () => {
    expect(Number.isFinite(hold)).toBe(true);
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(120);
  });

  it('cửa sổ sniff giữa luồng đúng 600 — khớp cửa sổ tự soi của looksLikePseudoError', () => {
    expect(windowChars).toBe(600);
  });

  it('kiểm tra pseudo-error TRƯỚC khi quyết định nhả token (giữ lỗi < 40 ký tự)', () => {
    expect(source).toMatch(
      /if \(!sniffReleased\) \{\s*\n\s*sniffHead \+= String\(part\.textDelta \?\? ''\);\s*\n[\s\S]*?if \(looksLikePseudoError\(sniffHead\)\) throwPseudoError\(\);/,
    );
  });

  it('đã nhả token vẫn sniff tiếp trong cửa sổ — lỗi lộ GIỮA luồng có đường phát error', () => {
    expect(source).toMatch(
      /if \(sniffHead\.length < SNIFF_WINDOW_CHARS\) \{\s*\n\s*sniffHead \+= String\(part\.textDelta \?\? ''\);\s*\n\s*if \(looksLikePseudoError\(sniffHead\)\) throwPseudoError\(\);/,
    );
    // Đường phát error: throwPseudoError ném ChatUpstreamError đúng mã để
    // handler A16 bắt (annotation + rethrow), không rơi vào diagnosis chung.
    expect(source).toMatch(
      /const throwPseudoError = \(\) => \{\s*\n\s*throw new ChatUpstreamError\([\s\S]{0,400}'UPSTREAM_POOL_EXHAUSTED',/,
    );
  });

  it('hành vi thật: payload crax thật khớp trong đúng cửa sổ hold — hạ hold sẽ hở lỗ', () => {
    expect(Number.isFinite(hold)).toBe(true);
    // Tiền tố ngắn nhất mà lib nhận diện được — đây là mức tối thiểu mà
    // route PHẢI tiếp tục soi trước khi nhả token.
    let minMatch = -1;
    for (let i = 1; i <= REAL_CRAX_ERROR.length; i++) {
      if (looksLikePseudoError(REAL_CRAX_ERROR.slice(0, i))) {
        minMatch = i;
        break;
      }
    }
    expect(minMatch).toBeGreaterThan(0);
    expect(minMatch).toBeLessThanOrEqual(hold);
  });
});

/**
 * Doc comment phải phản ánh runtime thật: route chạy Node.js
 * (`export const runtime = 'nodejs'`), thông báo chạm người dùng không được
 * đổ lỗi "Edge Function" nữa. Đảo điều kiện (đổi runtime hoặc hồi thông báo
 * cũ) → describe này ĐỎ.
 */
describe('doc — runtime Node.js, thông báo không nói sai "Edge Function"', () => {
  it("khai báo runtime = 'nodejs'", () => {
    expect(source).toMatch(/export const runtime = 'nodejs';/);
  });

  it('thông báo vượt ngân sách nói "phiên stream", không nói Edge Function', () => {
    expect(source).not.toMatch(/của Edge Function/);
    expect(source).toMatch(/của phiên stream và đã bị cắt\./);
  });
});
