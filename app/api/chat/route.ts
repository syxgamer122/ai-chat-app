import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';

export const runtime = 'edge';

export async function POST(req: Request) {
  try {
    const { messages, model, temperature, system } = await req.json();

    // Lấy config từ môi trường cho AntiCode AI hoặc OpenAI
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });

    const sanitizedMessages = messages.reduce((acc: any[], curr: any) => {
      const last = acc[acc.length - 1];
      if (last && last.role === curr.role) {
        last.content += '\n\n' + curr.content;
      } else {
        acc.push({ ...curr });
      }
      return acc;
    }, []);

    const result = await streamText({
      model: openai(model || 'gpt-5.6-luna'),
      messages: sanitizedMessages,
      temperature: temperature ?? 0.7,
      system: system,
    });

    return result.toDataStreamResponse();
  } catch (error: any) {
    console.error("Chat API Error:", error);
    return new Response(JSON.stringify({ error: error.message || 'Lỗi kết nối tới AI Provider.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
