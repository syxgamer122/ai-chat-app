import { createOpenAI } from '@ai-sdk/openai';
import { convertToCoreMessages, streamText, type CoreMessage } from 'ai';
import { z } from 'zod';

export const runtime = 'edge';
export const maxDuration = 60;

const BodySchema = z.object({
  messages: z.array(z.any()).min(1).max(200),
  model: z.string().min(1).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  system: z.string().max(8000).optional(),
});

const ALLOWED_MODELS = new Set(['gpt-5.6-luna', 'gpt-4o', 'gpt-4o-mini']);
const FALLBACK_MODEL = 'gpt-5.6-luna';

const toParts = (content: CoreMessage['content']) =>
  typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;

/** Gộp các message liên tiếp cùng role ở TẦNG PARTS -> không phá ảnh/file. */
function mergeSameRole(messages: CoreMessage[]): CoreMessage[] {
  return messages.reduce<CoreMessage[]>((acc, cur) => {
    const last = acc[acc.length - 1];
    const mergeable =
      last && last.role === cur.role && (cur.role === 'user' || cur.role === 'assistant');

    if (!mergeable) {
      acc.push({ ...cur });
      return acc;
    }

    (last as any).content = [
      ...(toParts(last.content) as any[]),
      { type: 'text', text: '\n\n' },
      ...(toParts(cur.content) as any[]),
    ];
    return acc;
  }, []);
}

/** Bỏ message rỗng và mọi message trước lượt user đầu tiên. */
function normalize(messages: CoreMessage[]): CoreMessage[] {
  const cleaned = messages.filter((m) => {
    const parts = toParts(m.content) as any[];
    return parts.some((p) => p.type !== 'text' || (p.text ?? '').trim().length > 0);
  });
  const firstUser = cleaned.findIndex((m) => m.role === 'user');
  return firstUser <= 0 ? cleaned : cleaned.slice(firstUser);
}

export async function POST(req: Request) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ error: 'Payload không hợp lệ.' }, { status: 400 });
    }

    const { messages, model, temperature, system } = parsed.data;

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });

    const core = mergeSameRole(normalize(convertToCoreMessages(messages as any)));
    if (!core.length) {
      return Response.json({ error: 'Không có nội dung để gửi.' }, { status: 400 });
    }

    // streamText từ v4 không còn blocking -> bỏ `await` để stream chạy sớm hơn.
    const result = streamText({
      model: openai(ALLOWED_MODELS.has(model ?? '') ? (model as string) : FALLBACK_MODEL),
      messages: core,
      temperature: Math.min(2, Math.max(0, temperature ?? 0.7)),
      system: system?.trim() ? system : undefined,
      // Người dùng bấm Stop -> hủy thật sự request tới provider (tiết kiệm token).
      abortSignal: req.signal,
      onError: ({ error }) => console.error('[streamText]', error),
    });

    return result.toDataStreamResponse({
      headers: { 'Cache-Control': 'no-store, no-transform' },
      // Không có option này, lỗi giữa stream về client thành chuỗi "An error occurred".
      getErrorMessage: (e: unknown) =>
        e instanceof Error ? e.message : 'Lỗi từ AI Provider.',
    });
  } catch (error: any) {
    console.error('Chat API Error:', error);
    return Response.json(
      { error: error?.message || 'Lỗi kết nối tới AI Provider.' },
      { status: 500 },
    );
  }
}
