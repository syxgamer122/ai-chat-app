import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import * as models from '@/lib/models';
import { bridgeImagesInMessages } from '@/lib/vision-bridge';
import { getReasoningCapability } from '@/lib/model-reasoning-cache';

vi.mock('@/lib/security', () => ({
  checkSameOrigin: () => true,
  getClientIp: () => 'test',
  checkRateLimit: () => ({ ok: true }),
  verifyAccessAuth: () => ({ ok: true }),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => (modelId: string) => ({ modelId })),
}));
vi.mock('ai', async (importOriginal) => ({
  ...await importOriginal<typeof import('ai')>(),
  streamText: vi.fn(() => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', textDelta: 'Mock coding response' };
      yield { type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
    })(),
  })),
}));
vi.mock('@/lib/vision-bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/vision-bridge')>(),
  bridgeImagesInMessages: vi.fn(async (messages) => messages),
}));
vi.mock('@/lib/model-reasoning-cache', () => ({ getReasoningCapability: vi.fn() }));

const fetchMock = vi.fn(() => { throw new Error('Network is forbidden in this test'); });
const attachment = { contentType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' };
const messages = [{ role: 'user', content: 'Explain this code', experimental_attachments: [attachment] }];

function request(body: Record<string, unknown>, override = true) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'test-key',
      ...(override ? { 'x-api-base': 'https://provider.example.com/v1' } : {}),
    },
    body: JSON.stringify({ messages, agentTools: false, ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectRetired(body: Record<string, unknown>, override = true) {
  const response = await POST(request(body, override));
  expect(response.status).toBe(410);
  const error = await response.json();
  expect(error.code).toBe('MEDIA_GENERATION_RETIRED');
  expect(error.error).toContain('chọn model lập trình/chat');
  expect(error.requestId).toBe(response.headers.get('X-Request-Id'));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(createOpenAI).not.toHaveBeenCalled();
  expect(streamText).not.toHaveBeenCalled();
  expect(bridgeImagesInMessages).not.toHaveBeenCalled();
  expect(getReasoningCapability).not.toHaveBeenCalled();
}

describe('chat route media retirement', () => {
  it.each(['gpt-image-1', 'qwen-image-3.0-pro', 'flux-pro', 'dall-e-3', 'seedream-4', 'sora-2', 'veo3', 'wan2.5-t2v'])('rejects selected %s before any upstream call', async (model) => {
    await expectRetired({ model, visionModel: 'qwen-vl', thinkingLevel: 'high' });
  });

  it('rejects a persisted generation selection even when a category selects chat', async () => {
    await expectRetired({ model: 'flux-pro', category: 'capable' });
  });

  it('rejects retired selections without a provider override', async () => {
    await expectRetired({ model: 'sora-2' }, false);
  });

  it('rejects the category-selected generation model', async () => {
    await expectRetired({ category: 'capable', customChains: { capable: [{ model: 'flux-pro', effort: 'medium' }] } });
  });

  it('rejects a retired fallback before calling the chat head of a category chain', async () => {
    await expectRetired({ category: 'capable', customChains: { capable: [{ model: 'gpt-4o', effort: 'medium' }, { model: 'sora-2', effort: 'medium' }] } }, false);
  });

  it('rejects a resolved provider alias or fallback', async () => {
    vi.spyOn(models, 'resolveProviderModelChain').mockReturnValue(['gpt-4o', 'flux-pro']);
    await expectRetired({ model: 'gpt-4o', visionModel: 'qwen-vl' }, false);
  });

  it('rejects an explicitly declared media model with an opaque id', async () => {
    vi.spyOn(models, 'mediaKindOf').mockImplementation((id) => id === 'opaque-model' ? 'image' : undefined);
    await expectRetired({ model: 'opaque-model' });
  });

  it('rejects a generation model passed as the vision bridge model', async () => {
    await expectRetired({ model: 'o1-mini', visionModel: 'gpt-image-1' });
  });

  it.each(['gpt-4o', 'qwen-image-vl', 'image-vision', 'image-ocr', 'qwen-coder'])('preserves chat for %s', async (model) => {
    const response = await POST(request({ model }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Mock coding response');
    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({ model: { modelId: model } }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves native image and PDF input and historical media markdown', async () => {
    const historical = '![flux-pro](https://example.com/old.png)\n[sora](https://example.com/old.mp4)';
    const response = await POST(request({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Show the saved media' },
        { role: 'assistant', content: historical },
        { role: 'user', content: 'Explain these files', experimental_attachments: [attachment, { contentType: 'application/pdf', url: 'data:application/pdf;base64,aGVsbG8=' }] },
      ],
    }));
    expect(await response.text()).toContain('Mock coding response');
    const sent = vi.mocked(streamText).mock.calls[0][0].messages!;
    expect(sent).toContainEqual({ role: 'assistant', content: historical });
    expect(sent[2].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image' }),
      expect.objectContaining({ type: 'file', mimeType: 'application/pdf' }),
    ]));
    expect(bridgeImagesInMessages).not.toHaveBeenCalled();
    expect(models.getModelConfig('gpt-4o')).toMatchObject({ supportsImages: true, supportsPdf: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the vision bridge for a text-only coding model', async () => {
    const response = await POST(request({ model: 'o1-mini', visionModel: 'qwen-image-vl' }));
    expect(await response.text()).toContain('Mock coding response');
    expect(bridgeImagesInMessages).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ model: 'qwen-image-vl' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
