/**
 * Gemini adapter for the model seams. Uses fetch, so it runs in the browser,
 * Node, and Bun alike. This is the only embedded transcription provider
 * available outside the browser (the Prompt API is Chrome-only).
 */
import type { AudioModel, TextModel } from './models';
import { bytesToBase64 } from './prompts';

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
}

export class GeminiModel implements AudioModel, TextModel {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: GeminiOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gemini-2.5-flash';
  }

  public async transcribe(wavBytes: Uint8Array, _sampleRate: number, instruction: string): Promise<string | null> {
    const data = await this.requestContent([
      { inlineData: { mimeType: 'audio/wav', data: bytesToBase64(wavBytes) } },
      { text: instruction }
    ]);

    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }

  public async complete(instruction: string): Promise<string | null> {
    const data = await this.requestContent([{ text: instruction }]);
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }

  private async requestContent(parts: unknown[]): Promise<GeminiGenerateContentResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const requestInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0 }
      })
    };

    let response = await fetch(url, requestInit);
    if (response.status === 429 || response.status === 503) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      response = await fetch(url, requestInit);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
    }

    return await response.json() as GeminiGenerateContentResponse;
  }
}

export function isGeminiConfigured(apiKey: string | null | undefined): boolean {
  return Boolean(apiKey && apiKey.trim());
}