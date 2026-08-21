import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getNextApiKey } from '@/lib/api-keys';

export const runtime = 'edge';

export async function POST(req: Request) {
  try {
    const { message } = await req.json();
    const customKey = req.headers.get('x-api-key')?.trim();
    const selectedKey = customKey || getNextApiKey();
    
    const openai = createOpenAI({ 
      apiKey: selectedKey,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });

    const result = await generateText({
      model: openai('gpt-4o-mini'),
      prompt: `Generate a short, concise title (max 5 words) for this message, without quotes or punctuation: "${message}"`,
    });

    return new Response(JSON.stringify({ title: result.text }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ title: "New Chat" }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
