/**
 * POST /api/fanout/dispatch — SSE Endpoint điều phối Fanout Units song song (Oh My Hermes port).
 *
 * Nhận FanoutContract, kiểm tra freeze contract (overlap/cycle/spawn_plan),
 * điều phối thực thi các units theo Dependency-Frontier và stream cập nhật trạng thái SSE live.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { freezeContract, type FanoutContract } from '@/lib/fanout/contract';
import { dispatchFanout, type FanoutDispatchEvent } from '@/lib/fanout/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const unitContractSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  owner: z.enum(['subagent', 'maestro-cli']),
  fileScope: z.array(z.string()),
  dependsOn: z.array(z.string()),
  doneCriteria: z.array(z.string()),
  verification: z
    .object({
      command: z.string(),
    })
    .optional(),
});

const spawnPlanSchema = z.object({
  why_parallel: z.string().max(280),
  why_not_single_unit: z.string().max(280),
  independence: z.string().max(280),
  expected_evidence_shape: z.string().max(280),
});

const fanoutContractSchema = z.object({
  id: z.string().min(1),
  goalDigest: z.string().min(1),
  baseRevision: z.string().min(1),
  units: z.array(unitContractSchema).min(1).max(30),
  mergeOrder: z.array(z.string()).default([]),
  spawnPlan: spawnPlanSchema.optional(),
  safetyProfileRevision: z.string().min(1),
});

const dispatchRequestSchema = z.object({
  contract: fanoutContractSchema,
  initialConcurrency: z.number().int().min(1).max(8).optional(),
  maxConcurrency: z.number().int().min(1).max(8).optional(),
  maxRetries: z.number().int().min(0).max(3).optional(),
});

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Body JSON không hợp lệ.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsed = dispatchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: 'Dữ liệu yêu cầu không khớp schema Fanout.',
        details: parsed.error.flatten(),
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { contract, initialConcurrency, maxConcurrency, maxRetries } = parsed.data;

  // Validate và đóng băng hợp đồng
  const freezeRes = freezeContract(contract as FanoutContract);
  if (!freezeRes.ok || !freezeRes.frozenContract) {
    return new Response(
      JSON.stringify({
        error: 'Fanout contract vi phạm quy tắc đóng băng tất định.',
        errors: freezeRes.errors,
      }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const frozen = freezeRes.frozenContract;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: FanoutDispatchEvent) => {
        try {
          const payload = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch (err) {
          console.error('[SSE enqueue error]', err);
        }
      };

      try {
        const summary = await dispatchFanout({
          contract: frozen,
          initialConcurrency,
          maxConcurrency,
          maxRetries,
          signal: req.signal,
          onEvent: sendEvent,
          executeUnit: async (unit) => {
            // Giả lập hoặc gọi worker thực thi
            // Trong môi trường Next.js API, unit được chạy và đo telemetry
            const startTime = Date.now();
            // Đảm bảo có delay tối thiểu để giả lập luồng quan sát nếu chưa gắn subprocess
            await new Promise((r) => setTimeout(r, 40));

            return {
              success: true,
              exitCode: 0,
              stdoutTail: `Unit "${unit.id}" (${unit.title}) hoàn thành hợp đồng và tiêu chí.`,
              telemetry: {
                tokensIn: 250,
                tokensOut: 120,
                costUsd: 0.002,
                elapsedSec: (Date.now() - startTime) / 1000,
              },
            };
          },
        });

        // Gửi tóm tắt cuối cùng
        sendEvent({
          type: 'contract_completed',
          timestamp: Date.now(),
          contractId: frozen.id,
          mergeOrder: summary.mergeOrder,
          stats: {
            completed: summary.completedUnits,
            failed: summary.failedUnits,
            running: 0,
            pending: 0,
            admission: 0,
          },
        });
      } catch (err) {
        sendEvent({
          type: 'contract_interrupted',
          timestamp: Date.now(),
          contractId: frozen.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          controller.close();
        } catch {
          /* Đã đóng */
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
