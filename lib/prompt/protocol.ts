/**
 * Universal Prompt Protocol & Model Family Calibration 
 *
 * Kỷ luật thiết kế:
 * 1. Prompt-cache discipline: Preamble dùng chung byte-stable, không timestamp, không state biến động.
 * 2. Shared preamble ceiling: <= 2770 bytes và <= 10 câu mệnh lệnh.
 * 3. 4 block phổ quát: Goal echo-back, Done criteria, Bounded verification, Failure-kind discipline (mỗi block <= 3 constraints).
 * 4. KHÔNG dùng ví dụ phản diện gắn nhãn (cấm Bad:/Wrong:).
 * 5. Hiệu chuẩn theo họ model: chỉ gắn counter-guidance khi effort là high/max.
 * 6. Đẩy volatile content (thời gian, danh sách file, bài học, plan) xuống cuối prompt.
 */

import type { RouteReceipt } from '@/lib/routing/categories';
import { stripProviderPrefix } from '@/lib/model-contracts';

/**
 * Phần mở đầu dùng chung ổn định từng byte giữa các sibling units/turns.
 * Đảm bảo tận dụng prompt caching của OpenAI, Anthropic, Gemini, DeepSeek.
 */
export const SHARED_PREAMBLE = `Bạn là trợ lý lập trình chuyên nghiệp của Vyen.
Nhiệm vụ của bạn là giải quyết trọn vẹn yêu cầu kỹ thuật với bằng chứng kiểm chứng cụ thể.
Tuân thủ nghiêm ngặt các nguyên tắc thực thi sau:
1. Đọc và phân tích mã nguồn kỹ lưỡng trước khi chỉnh sửa.
2. Giữ thay đổi tập trung vào đúng phạm vi yêu cầu, tránh refactor lan man.
3. Gửi đồng thời các lệnh đọc độc lập theo lô (tool batching) để tối ưu độ trễ.
4. Thực thi các bước phụ thuộc và ghi file theo trình tự an toàn.
5. Luôn chạy kiểm thử thực tế để thu thập biên nhận kiểm chứng trước khi kết luận.
6. Khi gặp lỗi rào cản quyền hạn hoặc sandbox, báo cáo trung thực thay vì tìm cách lách qua.`;

/**
 * 4 Khối giao thức phổ quát gắn vào mọi prompt unit.
 * Mỗi khối chứa tối đa 3 câu mệnh lệnh cốt lõi, không chứa Bad:/Wrong:.
 */
export const UNIVERSAL_BLOCKS = {
  GOAL_ECHO_BACK: `[MỤC TIÊU & RANH GIỚI]
1. Trước khi gọi công cụ đầu tiên, hãy tóm lược ngắn gọn mục tiêu và tiêu chí hoàn thành bằng số.
2. Nếu nhận thấy xung đột với ranh giới file hoặc quyền hạn đã cấp, hãy dừng lại và báo cáo ngay.`,

  DONE_CRITERIA: `[TIÊU CHÍ HOÀN THÀNH SỐ HOÁ]
1. Xác định danh sách tiêu chí nghiệm thu cụ thể có đánh số trước khi bắt tay thực hiện.
2. Coi công việc hoàn tất khi và chỉ khi mọi tiêu chí số hoá đều đã được thỏa mãn qua bằng chứng đo lường được.`,

  BOUNDED_VERIFICATION: `[XÁC MINH CÓ SÀN VÀ TRẦN]
1. Thực hiện đúng một lượt xác minh toàn diện qua lệnh kiểm thử thực tế và không được bỏ qua.
2. Khi mọi tiêu chí đã đạt kết quả pass, nghiêm cấm chạy lặp lại lệnh kiểm thử; tối đa 2 vòng sửa và kiểm tra.`,

  FAILURE_KIND: `[KỶ LUẬT PHÂN LOẠI THẤT BẠI]
1. Việc bị từ chối do sandbox, chính sách hoặc quyền hạn là ranh giới hợp lệ, tuyệt đối không tìm đường vòng để vượt qua.
2. Chỉ báo cáo trạng thái bị chặn (blocked) khi có nguyên nhân cụ thể có tên và nguyên nhân đó còn tồn tại sau các lần thử.`,
};

export type ModelFamily =
  | 'gpt'
  | 'claude'
  | 'gemini'
  | 'kimi'
  | 'glm'
  | 'qwen'
  | 'deepseek'
  | 'grok'
  | 'minimax'
  | 'unknown';

export const ALL_MODEL_FAMILIES: readonly ModelFamily[] = [
  'gpt',
  'claude',
  'gemini',
  'kimi',
  'glm',
  'qwen',
  'deepseek',
  'grok',
  'minimax',
  'unknown',
] as const;

/**
 * Nhận diện họ model từ model ID đã chuẩn hóa.
 */
export function modelFamily(rawId: string): ModelFamily {
  const id = stripProviderPrefix(rawId).toLowerCase();

  if (id.startsWith('claude')) return 'claude';
  if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('chatgpt')) return 'gpt';
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('qwen')) return 'qwen';
  if (id.startsWith('kimi') || id.startsWith('moonshot')) return 'kimi';
  if (id.startsWith('glm') || id.startsWith('chatglm')) return 'glm';
  if (id.startsWith('grok')) return 'grok';
  if (id.startsWith('minimax')) return 'minimax';

  return 'unknown';
}

/**
 * Bảng calibration cho Subagent (thực thi công việc cụ thể).
 * Ngắn gọn (<= 3 mệnh lệnh/block), tập trung vào trait nổi bật của từng họ.
 */
export const SUBAGENT_CALIBRATION: Record<ModelFamily, string> = {
  claude:
    '[HIỆU CHUẨN CLAUDE]\nBám sát checklist hiện tại, tránh tự động mở rộng phạm vi ra ngoài các tiêu chí đã định.',
  gpt:
    '[HIỆU CHUẨN GPT]\nTuân thủ chặt chẽ schema tham số của công cụ và không suy đoán kết quả khi chưa thực thi.',
  gemini:
    '[HIỆU CHUẨN GEMINI]\nMọi tuyên bố thành công phải dựa trên output thực tế của công cụ, không dựa trên phỏng đoán.',
  deepseek:
    '[HIỆU CHUẨN DEEPSEEK]\nDuy trì định dạng cấu trúc rõ ràng và kiểm tra kỹ lưỡng các trường dữ liệu hợp đồng.',
  qwen:
    '[HIỆU CHUẨN QWEN]\nKhông phát sinh các thẻ suy luận nội bộ trong văn bản trả về cho người dùng.',
  kimi:
    '[HIỆU CHUẨN KIMI]\nGiữ tham số gọi công cụ súc tích và kết thúc bước xác minh ngay khi có kết quả hợp lệ.',
  glm:
    '[HIỆU CHUẨN GLM]\nThực hiện từng thao tác ghi đĩa tuần tự và xác thực nội dung sau mỗi lần chỉnh sửa.',
  grok:
    '[HIỆU CHUẨN GROK]\nTập trung trực tiếp vào mục tiêu kỹ thuật, loại bỏ các diễn giải bên lề không cần thiết.',
  minimax:
    '[HIỆU CHUẨN MINIMAX]\nĐảm bảo tính chính xác của các đường dẫn file và kiểm tra mã lỗi sau khi chạy lệnh shell.',
  unknown:
    '[HIỆU CHUẨN CHUNG]\nThực hiện công việc thận trọng, báo cáo bằng chứng cụ thể sau mỗi lần gọi công cụ.',
};

/**
 * Bảng calibration cho Composer / Orchestrator (chia việc, phân rã unit).
 * Phải đảm bảo parity: mọi key trong SUBAGENT_CALIBRATION đều có trong COMPOSER_CALIBRATION.
 */
export const COMPOSER_CALIBRATION: Record<ModelFamily, string> = {
  claude:
    '[ĐIỀU PHỐI CLAUDE]\nPhân rã công việc thành các unit có ranh giới file độc lập và xác định rõ thứ tự phụ thuộc.',
  gpt:
    '[ĐIỀU PHỐI GPT]\nKiểm tra kỹ tính tương thích của kế hoạch phân chia và đảm bảo không có vòng lặp phụ thuộc.',
  gemini:
    '[ĐIỀU PHỐI GEMINI]\nXác lập tiêu chí nghiệm thu bằng số liệu quan sát được cho từng unit trước khi điều phối.',
  deepseek:
    '[ĐIỀU PHỐI DEEPSEEK]\nĐảm bảo cấu trúc hợp đồng phân chia chuẩn xác và chỉ định rõ command xác minh cho mỗi nhánh.',
  qwen:
    '[ĐIỀU PHỐI QWEN]\nPhân bổ file_scope rõ ràng, không để xảy ra hiện tượng chồng lấn giữa các unit song song.',
  kimi:
    '[ĐIỀU PHỐI KIMI]\nLập kế hoạch ngắn gọn, súc tích và ưu tiên các unit độc lập chạy trước.',
  glm:
    '[ĐIỀU PHỐI GLM]\nXác định rõ ràng thứ tự hợp nhất (merge_order) ngay khi đóng băng kế hoạch.',
  grok:
    '[ĐIỀU PHỐI GROK]\nGiữ số lượng unit tối giản, chỉ tách song song khi thực sự độc lập về phạm vi file.',
  minimax:
    '[ĐIỀU PHỐI MINIMAX]\nKiểm tra lại tính khả thi của từng nhánh và giới hạn số bước thực thi hợp lý.',
  unknown:
    '[ĐIỀU PHỐI CHUNG]\nPhân tách công việc rõ ràng, kèm tiêu chí kiểm chứng cụ thể cho từng phần việc.',
};

/**
 * Lấy counter-guidance hiệu chuẩn cho route hiện tại.
 * Chỉ kích hoạt khi reasoning effort là 'high' hoặc 'max' để không làm nặng các prompt rẻ.
 */
export function calibrationFor(
  route: RouteReceipt,
  role: 'subagent' | 'composer' = 'subagent',
): string | undefined {
  const effort = route.selected.effort;
  if (effort !== 'high' && effort !== 'max') {
    return undefined;
  }

  const fam = modelFamily(route.selected.model);
  const table = role === 'composer' ? COMPOSER_CALIBRATION : SUBAGENT_CALIBRATION;
  return table[fam] ?? table.unknown;
}

/**
 * Lắp ráp toàn bộ system prompt theo nguyên tắc:
 * 1. Preamble tĩnh dùng chung (cache-friendly)
 * 2. 4 universal blocks
 * 3. Calibration họ model (nếu effort high/max)
 * 4. Contract của unit (nếu có)
 * 5. Volatile tail ở CUỐI CÙNG (thời gian, files, lessons, current plan)
 */
export function assemblePrompt(args: {
  route: RouteReceipt;
  role?: 'subagent' | 'composer';
  unitContract?: {
    id: string;
    fileScope: string[];
    dependsOn?: string[];
    doneCriteria: string[];
    verificationCommand?: string;
  };
  volatileTail?: string;
}): string {
  const blocks: string[] = [SHARED_PREAMBLE];

  // 4 universal blocks
  blocks.push(UNIVERSAL_BLOCKS.GOAL_ECHO_BACK);
  blocks.push(UNIVERSAL_BLOCKS.DONE_CRITERIA);
  blocks.push(UNIVERSAL_BLOCKS.BOUNDED_VERIFICATION);
  blocks.push(UNIVERSAL_BLOCKS.FAILURE_KIND);

  // Model family calibration
  const calib = calibrationFor(args.route, args.role ?? 'subagent');
  if (calib) {
    blocks.push(calib);
  }

  // Unit contract
  if (args.unitContract) {
    const uc = args.unitContract;
    const lines = [
      `[HỢP ĐỒNG NHÁNH: ${uc.id}]`,
      `- Phạm vi file được phép chạm: ${uc.fileScope.join(', ') || 'không giới hạn'}`,
      `- Phụ thuộc hoàn thành: ${uc.dependsOn?.join(', ') || 'không'}`,
      `- Tiêu chí xong:`,
      ...uc.doneCriteria.map((c, i) => `  ${i + 1}. ${c}`),
      uc.verificationCommand ? `- Lệnh kiểm chứng: ${uc.verificationCommand}` : '',
    ].filter(Boolean);
    blocks.push(lines.join('\n'));
  }

  // Volatile tail đẩy xuống cuối
  if (args.volatileTail?.trim()) {
    blocks.push(args.volatileTail.trim());
  }

  return blocks.join('\n\n');
}
