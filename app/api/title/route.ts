import { createOpenAI } from '@ai-sdk/openai';
import { generateText, APICallError } from 'ai';
import { z } from 'zod';
import { getKeyCandidates, markKeyFailure, markKeySuccess, getKeyLabel } from '@/lib/api-keys';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

export const runtime = 'edge';

const TitleSchema = z.object({
  message: z.string().min(1).max(2000),
});

const SECRET_REGEX = /\b(sk|sk-proj|sk-ant|Bearer)\s*[:=]?\s*[A-Za-z0-9_\-]{4,}/gi;

function sanitizeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  return raw.replace(SECRET_REGEX, '[redacted]').slice(0, 300);
}

function getStatusCode(e: unknown): number | undefined {
  if (APICallError.isInstance(e)) return e.statusCode;
  if (typeof e === 'object' && e !== null && 'status' in e && typeof (e as any).status === 'number') {
    return (e as any).status;
  }
  return undefined;
}

export async function POST(req: Request) {
  try {
    const customKey = req.headers.get('x-api-key')?.trim();

    if (!customKey) {
      const clientIp = getClientIp(req);
      const { allowed } = checkRateLimit(`title:${clientIp}`, 60, 60_000);
      if (!allowed) {
        return Response.json({ title: 'New Chat' }, { status: 429 });
      }
    }

    const json = await req.json();
    const parsed = TitleSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ title: 'New Chat' });
    }

    const cleanMessage = parsed.data.message
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/["'`]+/g, '')
      .trim()
      .slice(0, 1000);

    const candidateKeys = customKey ? [customKey] : getKeyCandidates().slice(0, 3);

    for (const key of candidateKeys) {
      try {
        const openai = createOpenAI({
          apiKey: key,
          baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        });

        const result = await generateText({
          model: openai('gpt-4o-mini'),
          prompt: `Summarize this user request into a concise 3-5 word title in the same language. Do not use quotes, punctuation or prefixes:\n\n"""${cleanMessage}"""`,
          temperature: 0.3,
          maxTokens: 16,
          abortSignal: req.signal,
        });

        const title = result.text.trim().replace(/^["']+|["']+$/g, '').slice(0, 60);
        markKeySuccess(key);

        return Response.json({ title: title || 'New Chat' }, {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        const isAbort = (err as any)?.name === 'AbortError' || req.signal.aborted;
        if (!isAbort) {
          console.warn(`[Title API ${getKeyLabel(key)}] Error:`, sanitizeErrorMessage(err));
          markKeyFailure(key, getStatusCode(err));
        }
      }
    }

    return Response.json({ title: 'New Chat' });
  } catch {
    return Response.json({ title: 'New Chat' });
  }
}
