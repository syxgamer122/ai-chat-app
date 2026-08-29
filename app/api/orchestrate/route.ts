/**
 * POST /api/orchestrate — điều phối bầy agent + quét tham số, stream SSE.
 *
 * Ghép 2 nguồn:
 *  - **agent-orchestrator**: orchestrator tự plan → spawn N agent có context
 *    riêng → review và tổng hợp. Ở đây "agent" không phải process (như Claude
 *    Code/Codex bên AO) mà là MỘT lượt gọi LLM bị ép vào một cấu hình khác
 *    nhau của lưới — đủ để có sự khác biệt thật, không đủ để cần hạ tầng.
 *  - **vectorbt**: kết quả không phải một câu trả lời mà là **lưới bản ghi**,
 *    rút gọn bằng group-by theo trục + heatmap 2 chiều.
 *
 * Tại sao phải nằm ở server route (không gọi thẳng từ trình duyệt):
 *  - Key upstream chỉ tồn tại ở server (env), giống /api/compact.
 *  - Một lượt = ~10 lượt gọi LLM; đi qua hàng đợi upstream ở đây để không
 *    phá ngân sách dùng chung của gateway free (crax/Kilgore).
 *  - Crax trả 403 cho mọi request có header `Origin` — gọi từ trình duyệt
 *    không được (cùng lý do /api/chat phải proxy).
 *
 * Không thêm dependency: dùng sẵn @ai-sdk/openai + ai (generateText), zod,
 * và các module tiện ích đã có của dự án.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText, APICallError } from 'ai';
import { z } from 'zod';
import { getKeyCandidates, markKeyFailure, markKeySuccess, getKeyLabel } from '@/lib/api-keys';
import { validateProviderBaseUrl } from '@/lib/provider-url';
import { sharedFreeBudget, acquireUpstreamSlot } from '@/lib/upstream-queue';
import { filterSupportedModels, markModelUnsupported } from '@/lib/model-negative-cache';
import { nonStreamingFetch } from '@/lib/non-streaming-fetch';
import {
  checkRateLimit,
  rateLimitHeaders,
  rateLimitIdentity,
  verifySameOrigin,
  verifyAccessAuth,
} from '@/lib/security';
import { parseLooseJson } from '@/lib/json-repair';
import {
  orchestrate,
  DEFAULT_RUN_TIMEOUT_MS,
  type OrchestratorDeps,
  type OrchestratorEvent,
} from '@/lib/orchestrator/engine';
import { MAX_RUNS_LIMIT } from '@/lib/orchestrator/plan';
import { repairDirective } from '@/lib/orchestrator/repair';
import {
  JUDGE_SYSTEM,
  PLANNER_SYSTEM,
  SYNTHESIZER_SYSTEM,
  judgeUserPrompt,
  plannerUserPrompt,
  synthesizerUserPrompt,
  workerSystem,
  workerUserPrompt,
  type SynthesisCandidate,
} from '@/lib/orchestrator/prompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ------------------------------------------------------------------ */
/* Ngưỡng                                                              */
/* ------------------------------------------------------------------ */

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONTEXT_CHARS = 8_000;
const MAX_GOAL_CHARS = 4_000;

/**
 * Chuỗi model dự phòng. Ngắn gọn và RẺ vì một lượt orchestrate gọi LLM
 * khoảng 10 lần — chọn model nhanh cho planner/judge, còn worker dùng model
 * người dùng đang chọn ở client (truyền qua body.model).
 */
const ORCHESTRATE_MODEL_CHAIN: readonly string[] = Object.freeze(
  (process.env.ORCHESTRATE_MODEL_CHAIN ?? 'qwen3.5-flash,gpt-5-4-nano,gpt-4o-mini,deepseek-v4-flash')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),
);

/** Nhịp giữ kết nối sống trong lúc lưới đang chạy. */
const HEARTBEAT_MS = 10_000;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

const SECRET_REGEX = /\b(sk|sk-proj|sk-ant|Bearer)\s*[:=]?\s*[A-Za-z0-9_\-]{4,}/gi;

function sanitize(e: unknown): string {
  return (e instanceof Error ? e.message : String(e ?? '')).replace(SECRET_REGEX, '[redacted]').slice(0, 300);
}

function statusOf(e: unknown): number | undefined {
  if (APICallError.isInstance(e)) return e.statusCode;
  if (typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status?: unknown }).status === 'number') {
    return (e as { status: number }).status;
  }
  return undefined;
}

function isModelNotFound(e: unknown): boolean {
  if (statusOf(e) === 404) return true;
  const msg = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  return msg.includes('model_not_found') || msg.includes('does not exist');
}

/**
 * Gắn status code vào lỗi trước khi ném ra.
 *
 * `sanitize()` biến lỗi thành chuỗi thuần, làm MẤT status — trong khi vòng lặp
 * tự sửa (repair.ts) cần status để phân biệt 429/503 (thử lại được) với
 * 401/404 (vô ích). Đính kèm theo đúng shape mà `statusOf` đã đọc được ở cả
 * lib/api-keys.ts và repair.ts, nên không cần đổi quy ước nào khác.
 */
function upstreamError(message: string, status?: number): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number };
  if (status !== undefined) err.status = status;
  return err;
}

async function readJsonWithLimit(req: Request, maxBytes: number): Promise<unknown> {
  if (!req.body) throw new Error('Empty request body.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Payload too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const OrchestrateSchema = z.object({
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  context: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().max(MAX_CONTEXT_CHARS),
      }),
    )
    .max(20)
    .default([]),
  /** Số cấu hình tối đa chạy (lưới sẽ được thu nhỏ cho vừa). */
  maxRuns: z.number().int().min(1).max(MAX_RUNS_LIMIT).default(4),
  /** Số worker song song. Giữ nhỏ để không phá ngân sách gateway chung. */
  concurrency: z.number().int().min(1).max(6).default(2),
  /** Bật chấm điểm từng kết quả (thêm N lượt gọi LLM). */
  judge: z.boolean().default(true),
  /** Model do client chọn — dùng cho worker (phần sinh nội dung). */
  model: z.string().max(64).optional(),
});

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  if (!verifySameOrigin(req)) {
    return Response.json({ ok: false as const, error: 'forbidden' }, { status: 403 });
  }

  /* Một lượt = ~10 lượt gọi LLM → trần thấp hơn hẳn /api/vision. */
  const limit = checkRateLimit(`orchestrate:${rateLimitIdentity(req)}`, 3, 60_000);
  if (!limit.ok) {
    return Response.json({ ok: false as const, error: 'rate_limited' }, { status: 429, headers: rateLimitHeaders(limit) });
  }

  const auth = verifyAccessAuth(req);
  if (!auth.ok) {
    return Response.json({ ok: false as const, error: auth.error ?? 'unauthorized' }, { status: 401 });
  }

  /* BYOK: cùng quy ước header với /api/chat và /api/compact. */
  const rawKey = req.headers.get('x-api-key')?.trim();
  const rawBase = req.headers.get('x-api-base')?.trim() || undefined;
  const baseCheck = rawBase ? validateProviderBaseUrl(rawBase) : undefined;
  if (baseCheck && !baseCheck.ok) {
    return Response.json({ ok: false as const, error: 'bad_provider_base' }, { status: 400 });
  }
  const providerBase = baseCheck?.ok ? baseCheck.url : undefined;
  const customKey =
    rawKey && rawKey.length <= 256 && /^[\x21-\x7E]+$/.test(rawKey) ? rawKey : undefined;

  let json: unknown;
  try {
    json = await readJsonWithLimit(req, MAX_BODY_BYTES);
  } catch {
    return Response.json({ ok: false as const, error: 'bad_request' }, { status: 400 });
  }

  const parsed = OrchestrateSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ ok: false as const, error: 'bad_schema' }, { status: 400 });
  }
  const body = parsed.data;

  const upstreamBase = providerBase ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const candidateKeys = providerBase
    ? [customKey ?? 'provider-no-key']
    : customKey
      ? [customKey]
      : getKeyCandidates().keys.slice(0, 3);

  const chain = filterSupportedModels(upstreamBase, ORCHESTRATE_MODEL_CHAIN);
  const workerModel = body.model?.trim();
  /* Model người dùng chọn được ưu tiên cho worker; chuỗi dự phòng đi sau. */
  const workerChain = workerModel ? [workerModel, ...chain.filter((m) => m !== workerModel)] : [...chain];

  const contextText = body.context.length
    ? body.context
        .map((m) => `${m.role === 'assistant' ? 'Trợ lý' : m.role === 'user' ? 'Người dùng' : 'Hệ thống'}: ${m.content.trim()}`)
        .join('\n\n')
        .slice(0, MAX_CONTEXT_CHARS)
    : undefined;

  const signal = req.signal;

  /**
   * Một lượt gọi LLM: xếp hàng (gateway free) → thử key × model → text.
   * `chainOverride` cho phép worker dùng model người dùng chọn.
   */
  async function callLlm(args: {
    system: string;
    prompt: string;
    temperature: number;
    maxTokens: number;
    chainOverride?: readonly string[];
  }): Promise<string> {
    if (sharedFreeBudget(upstreamBase)) {
      const slot = await acquireUpstreamSlot(upstreamBase);
      if (!slot.ok) throw new Error(`Gateway đang bận — thử lại sau ${slot.retryAfterSec}s`);
    }

    const models = args.chainOverride ?? chain;
    let lastError = 'Không có model khả dụng.';
    let lastStatus: number | undefined;

    for (const key of candidateKeys) {
      const openai = createOpenAI({
        apiKey: key,
        baseURL: upstreamBase,
        /* Bắt buộc: crax trả SSE khi request thiếu `stream`, còn generateText
           thì không gửi trường đó — xem lib/non-streaming-fetch.ts. */
        fetch: nonStreamingFetch,
      });

      for (const modelName of models) {
        if (signal.aborted) throw new Error('Đã huỷ');
        try {
          const res = await generateText({
            model: openai(modelName),
            system: args.system,
            prompt: args.prompt,
            temperature: args.temperature,
            maxTokens: args.maxTokens,
            abortSignal: signal,
          });
          const text = res.text.trim();
          if (!text) continue; // stream rỗng kiểu crax lúc quá tải
          markKeySuccess(key);
          return text;
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError' || signal.aborted) throw new Error('Đã huỷ');
          if (isModelNotFound(err)) {
            markModelUnsupported(upstreamBase, modelName);
            lastError = `Model "${modelName}" không tồn tại.`;
            lastStatus = 404;
            continue;
          }
          const st = statusOf(err);
          if (st === undefined || st === 429 || st === 401 || st === 403 || st >= 500) {
            markKeyFailure(key, st);
          }
          lastError = sanitize(err);
          lastStatus = st;
          break; // key này hỏng → key kế tiếp
        }
      }
    }

    throw upstreamError(lastError, lastStatus);
  }

  /* ---------------------------------------------------------------- */
  /* SSE                                                              */
  /* ---------------------------------------------------------------- */

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);

      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* client đã ngắt — bỏ qua */
        }
      };

      /* Tắt chấm điểm = KHÔNG truyền `judge` vào deps: engine tự dùng điểm
         trung tính và xếp hạng chỉ còn dựa trên tốc độ. Tiết kiệm N lượt gọi. */
      const deps: OrchestratorDeps = {
        maxRuns: body.maxRuns,
        concurrency: body.concurrency,
        runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
        signal,
        onEvent: (e: OrchestratorEvent) => send(`data: ${JSON.stringify(e)}\n\n`),

        async plan(goal, context) {
          const raw = await callLlm({
            system: PLANNER_SYSTEM,
            prompt: plannerUserPrompt(goal, context),
            temperature: 0.3,
            maxTokens: 700,
          });
          return parseLooseJson(raw);
        },

        async run(ctx) {
          /* Lần thử lại mang theo lỗi của lần trước — tương đương việc
             agent-orchestrator đưa log CI đỏ vào prompt khi respawn agent.
             repairDirective() tự bọc lỗi trong delimiter vì text lỗi đến từ
             upstream (nguy cơ prompt injection gián tiếp). */
          const repairNote = ctx.previousError ? repairDirective(ctx.previousError, ctx.attempt) : undefined;
          const out = await callLlm({
            system: workerSystem(ctx.cell, repairNote),
            prompt: workerUserPrompt(ctx.goal, ctx.context),
            temperature: 0.8,
            maxTokens: 2_048,
            chainOverride: workerChain,
          });
          return { output: out };
        },

        async synthesize(goal, candidates: readonly SynthesisCandidate[]) {
          return callLlm({
            system: SYNTHESIZER_SYSTEM,
            prompt: synthesizerUserPrompt(goal, candidates),
            temperature: 0.5,
            maxTokens: 3_000,
          });
        },
      };

      if (body.judge) {
        deps.judge = async (goal, criteria, output) => {
          const raw = await callLlm({
            system: JUDGE_SYSTEM,
            prompt: judgeUserPrompt(goal, criteria, output),
            temperature: 0,
            maxTokens: 200,
          });
          const parsed = parseLooseJson(raw) as { score?: unknown } | null;
          const score = parsed && typeof parsed === 'object' ? (parsed as { score?: unknown }).score : undefined;
          return typeof score === 'number' && Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
        };
      }

      void (async () => {
        try {
          await orchestrate(body.goal, contextText, deps);
        } catch (err) {
          send(`data: ${JSON.stringify({ type: 'error', message: sanitize(err) })}\n\n`);
        } finally {
          finish();
        }
      })();

      signal.addEventListener('abort', finish, { once: true });
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS, ...rateLimitHeaders(limit) } });
}
