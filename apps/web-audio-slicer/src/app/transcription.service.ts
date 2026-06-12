import { Injectable } from '@angular/core';

export type TranscriptionLanguageCode =
  | 'auto'
  | 'en'
  | 'de'
  | 'es'
  | 'fr'
  | 'it'
  | 'pt'
  | 'nl'
  | 'pl'
  | 'ja';

export interface TranscriptionLanguageOption {
  value: TranscriptionLanguageCode;
  label: string;
  promptLabel: string;
}

export const TRANSCRIPTION_LANGUAGE_OPTIONS: ReadonlyArray<TranscriptionLanguageOption> = [
  { value: 'auto', label: 'Auto detect', promptLabel: 'the detected spoken language' },
  { value: 'en', label: 'English', promptLabel: 'English' },
  { value: 'de', label: 'German', promptLabel: 'German' },
  { value: 'es', label: 'Spanish', promptLabel: 'Spanish' },
  { value: 'fr', label: 'French', promptLabel: 'French' },
  { value: 'it', label: 'Italian', promptLabel: 'Italian' },
  { value: 'pt', label: 'Portuguese', promptLabel: 'Portuguese' },
  { value: 'nl', label: 'Dutch', promptLabel: 'Dutch' },
  { value: 'pl', label: 'Polish', promptLabel: 'Polish' },
  { value: 'ja', label: 'Japanese', promptLabel: 'Japanese' }
];

@Injectable({
  providedIn: 'root'
})
export class TranscriptionService {
  private apiKeyKey = 'web_audio_slicer_gemini_key';
  private transcriptionLanguageKey = 'web_audio_slicer_transcription_language';

  constructor() {}

  /**
   * Saves the Gemini API Key to localStorage.
   */
  public saveApiKey(key: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.apiKeyKey, key);
    }
  }

  /**
   * Retrieves the Gemini API Key from localStorage.
   */
  public getApiKey(): string {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(this.apiKeyKey) || '';
    }
    return '';
  }

  public saveTranscriptionLanguage(language: TranscriptionLanguageCode): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.transcriptionLanguageKey, language);
    }
  }

  public getTranscriptionLanguage(): TranscriptionLanguageCode {
    if (typeof localStorage === 'undefined') {
      return 'auto';
    }

    const storedLanguage = localStorage.getItem(this.transcriptionLanguageKey);
    return this.isTranscriptionLanguageCode(storedLanguage) ? storedLanguage : 'auto';
  }

  /**
   * Checks if Chrome Built-in AI (Prompt API) is available.
   */
  public async isChromeAIAvailable(): Promise<boolean> {
    const model = this.getPromptApiModel();
    if (!model) {
      return false;
    }

    try {
      const availability = await this.getPromptApiAvailability(this.getAudioPromptOptions());
      return availability !== 'unavailable';
    } catch {
      return false;
    }
  }

  /**
   * Transcribes a WAV audio blob with the browser Prompt API when available,
   * falling back to Gemini if the user configured an API key.
   */
  public async transcribeAudio(audioBlob: Blob): Promise<string> {
    const transcriptionLanguage = this.getTranscriptionLanguage();
    const promptResult = await this.transcribeWithPromptApi(audioBlob, transcriptionLanguage);
    if (promptResult) {
      return promptResult;
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('No transcription provider available. Use Chrome Prompt API support or configure a Gemini API key.');
    }

    return this.transcribeWithGemini(audioBlob, apiKey, transcriptionLanguage);
  }

  /**
   * Refines a raw transcript using Chrome Prompt API or Gemini API.
   * Extracts a clean title for the MP3 file.
   */
  public async extractSongTitle(rawText: string): Promise<string> {
    const normalizedText = rawText.trim();
    if (!normalizedText) {
      return '';
    }

    const transcriptionLanguage = this.getTranscriptionLanguage();

    const promptTitle = await this.extractSongTitleWithPromptApi(normalizedText, transcriptionLanguage);
    if (promptTitle) {
      return promptTitle;
    }

    const apiKey = this.getApiKey();
    if (apiKey) {
      const geminiTitle = await this.extractSongTitleWithGemini(normalizedText, apiKey, transcriptionLanguage);
      if (geminiTitle) {
        return geminiTitle;
      }
    }

    return this.normalizeTitle(this.fallbackRegexExtraction(normalizedText));
  }

  private async transcribeWithGemini(
    audioBlob: Blob,
    apiKey: string,
    transcriptionLanguage: TranscriptionLanguageCode
  ): Promise<string> {
    const base64Data = await this.blobToBase64(audioBlob);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/wav',
                    data: base64Data
                  }
                },
                {
                  text: this.buildTranscriptionInstruction(transcriptionLanguage)
                }
              ]
            }
          ]
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Invalid response from Gemini API');
    }

    return text.trim();
  }

  private fallbackRegexExtraction(text: string): string {
    // Simple heuristic to extract something clean
    const clean = text.replace(/[\n\r]+/g, ' ').trim();
    if (clean.length > 50) {
      return clean.substring(0, 47) + '...';
    }
    return clean;
  }

  private async transcribeWithPromptApi(
    audioBlob: Blob,
    transcriptionLanguage: TranscriptionLanguageCode
  ): Promise<string | null> {
    const globalObj = globalThis as any;
    if (!globalObj.LanguageModel) {
      return null;
    }

    const session = await this.createPromptApiSession(this.getAudioPromptOptions());
    if (!session) {
      return null;
    }

    try {
      const result = await session.prompt([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              value: this.buildTranscriptionInstruction(transcriptionLanguage)
            },
            {
              type: 'audio',
              value: audioBlob
            }
          ]
        }
      ]);

      return this.normalizeModelText(result);
    } catch (error) {
      console.warn('Prompt API audio transcription failed, falling back to Gemini if available.', error);
      return null;
    } finally {
      await this.destroyPromptApiSession(session);
    }
  }

  private async extractSongTitleWithPromptApi(
    rawText: string,
    transcriptionLanguage: TranscriptionLanguageCode
  ): Promise<string | null> {
    const session = await this.createPromptApiSession(this.getTextPromptOptions());
    if (!session) {
      return null;
    }

    try {
      const result = await session.prompt(this.buildTitleExtractionInstruction(rawText, transcriptionLanguage));

      return this.normalizeTitle(this.normalizeModelText(result));
    } catch (error) {
      console.warn('Prompt API title extraction failed, falling back to Gemini/heuristics.', error);
      return null;
    } finally {
      await this.destroyPromptApiSession(session);
    }
  }

  private async extractSongTitleWithGemini(
    rawText: string,
    apiKey: string,
    transcriptionLanguage: TranscriptionLanguageCode
  ): Promise<string | null> {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: this.buildTitleExtractionInstruction(rawText, transcriptionLanguage)
                  }
                ]
              }
            ]
          })
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return result ? this.normalizeTitle(this.normalizeModelText(result)) : null;
    } catch (error) {
      console.warn('Gemini title extraction failed', error);
      return null;
    }
  }

  private getPromptApiModel(): any | null {
    const globalObj = globalThis as any;
    return globalObj.LanguageModel ?? globalObj.ai?.languageModel ?? null;
  }

  private getTextPromptOptions(): Record<string, unknown> {
    return {
      expectedInputs: [{ type: 'text' }],
      expectedOutputs: [{ type: 'text' }]
    };
  }

  private getAudioPromptOptions(): Record<string, unknown> {
    return {
      expectedInputs: [
        { type: 'text' },
        { type: 'audio' }
      ],
      expectedOutputs: [{ type: 'text' }]
    };
  }

  private buildTranscriptionInstruction(language: TranscriptionLanguageCode): string {
    const languageInstruction = this.getTranscriptionLanguageInstruction(language);
    return [
      'Transcribe the spoken audio in this quiet gap before a song.',
      'Focus on DJ intros that mention the next artist or song title.',
      languageInstruction,
      'Return only the transcript text.',
      'If there is no intelligible speech, return an empty string.'
    ].join(' ');
  }

  private buildTitleExtractionInstruction(rawText: string, language: TranscriptionLanguageCode): string {
    const languageInstruction = language === 'auto'
      ? 'The transcript may be in any language. Preserve artist names, song titles, and any summary text in the transcript\'s original language and script. Do not translate to English.'
      : `The transcript is expected to be in ${this.getLanguageOption(language).promptLabel}. Preserve artist names, song titles, and any summary text in ${this.getLanguageOption(language).promptLabel} when possible. Do not translate to English.`;

    return [
      'This transcript was captured from speech immediately before a song.',
      'Extract a concise MP3 title.',
      'Prefer the format "Artist - Song Title".',
      'If only the song title or artist is clear, return that.',
      'If no title is mentioned, return a short 2-5 word summary.',
      languageInstruction,
      `Transcript: "${rawText}"`
    ].join(' ');
  }

  private getTranscriptionLanguageInstruction(language: TranscriptionLanguageCode): string {
    if (language === 'auto') {
      return 'Automatically detect the spoken language and return the transcript in that same language and script. Do not translate to English.';
    }

    return `The expected spoken language is ${this.getLanguageOption(language).promptLabel}. Return the transcript in ${this.getLanguageOption(language).promptLabel}. Do not translate it to English.`;
  }

  private getLanguageOption(language: TranscriptionLanguageCode): TranscriptionLanguageOption {
    return TRANSCRIPTION_LANGUAGE_OPTIONS.find(option => option.value === language)
      ?? TRANSCRIPTION_LANGUAGE_OPTIONS[0];
  }

  private isTranscriptionLanguageCode(value: string | null): value is TranscriptionLanguageCode {
    return TRANSCRIPTION_LANGUAGE_OPTIONS.some(option => option.value === value);
  }

  private async getPromptApiAvailability(options: Record<string, unknown>): Promise<string> {
    const model = this.getPromptApiModel();
    if (!model) {
      return 'unavailable';
    }

    if (typeof model.availability === 'function') {
      const availability = await model.availability(options);
      return availability === 'unavailable' ? 'unavailable' : 'available';
    }

    if (typeof model.capabilities === 'function') {
      const capabilities = await model.capabilities();
      return capabilities.available === 'no' ? 'unavailable' : 'available';
    }

    return 'available';
  }

  private async createPromptApiSession(options: Record<string, unknown>): Promise<any | null> {
    const model = this.getPromptApiModel();
    if (!model || typeof model.create !== 'function') {
      return null;
    }

    const availability = await this.getPromptApiAvailability(options);
    if (availability === 'unavailable') {
      return null;
    }

    try {
      return await model.create(options);
    } catch (error) {
      console.warn('Prompt API session creation failed', error);
      return null;
    }
  }

  private async destroyPromptApiSession(session: any): Promise<void> {
    if (!session || typeof session.destroy !== 'function') {
      return;
    }

    try {
      await session.destroy();
    } catch {
      // Ignore session cleanup issues.
    }
  }

  private normalizeModelText(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }

    return value
      .trim()
      .replace(/^['"`]+|['"`]+$/g, '')
      .replace(/\s+/g, ' ');
  }

  private normalizeTitle(title: string): string {
    const cleaned = title
      .replace(/[\u0000-\u001f]/g, ' ')
      .replace(/[\\/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      return '';
    }

    return cleaned.length > 120 ? cleaned.slice(0, 117).trimEnd() + '...' : cleaned;
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        // Strip dataUrl prefix (e.g. "data:audio/wav;base64,")
        const base64 = result.substring(result.indexOf(',') + 1);
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}
