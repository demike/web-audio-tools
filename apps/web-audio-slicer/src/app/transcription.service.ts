import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  GeminiModel,
  MusicBrainzClient,
  Transcriber,
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  bytesToBlob,
  normalizeModelText,
  type SongTitleExtractionResult,
  type TranscriptionLanguageCode,
  type TranscriptionPort
} from '@web-audio-tools/audio-core';

export type { TranscriptionLanguageCode, SongTitleExtractionResult };
export { TRANSCRIPTION_LANGUAGE_OPTIONS };

export type PromptApiAvailability = 'available' | 'unavailable' | 'downloadable' | 'downloading';
export type PromptApiStatus = PromptApiAvailability | 'unsupported' | 'error';

export interface PromptApiDiagnostics {
  status: PromptApiStatus;
  detail: string;
  lastError: string | null;
}

type PromptApiLanguageCode = 'en' | 'es' | 'ja';
const SUPPORTED_PROMPT_API_LANGUAGES: ReadonlyArray<PromptApiLanguageCode> = ['en', 'es', 'ja'];

type PromptApiCapabilityResult = { available?: 'no' | 'yes' | 'after-download' };
type PromptApiMessageContent = { type: 'text' | 'audio'; value: string | Blob };
type PromptApiMessage = { role: 'user'; content: PromptApiMessageContent[] };
type PromptApiSession = {
  prompt: (input: string | PromptApiMessage[]) => Promise<unknown>;
  destroy?: () => Promise<void> | void;
};
type PromptApiModel = {
  availability?: (options: Record<string, unknown>) => Promise<PromptApiAvailability | string>;
  capabilities?: () => Promise<PromptApiCapabilityResult>;
  create?: (options: Record<string, unknown>) => Promise<PromptApiSession>;
};
type PromptApiGlobal = typeof globalThis & {
  LanguageModel?: PromptApiModel;
  ai?: { languageModel?: PromptApiModel };
};

/**
 * Browser transcription adapter. Implements the core TranscriptionPort using
 * the Chrome Prompt API when available, falling back to Gemini. Title
 * extraction and MusicBrainz verification are delegated to the core Transcriber.
 */
@Injectable({
  providedIn: 'root'
})
export class TranscriptionService implements TranscriptionPort {
  private apiKeyKey = 'web_audio_slicer_gemini_key';
  private transcriptionLanguageKey = 'web_audio_slicer_transcription_language';
  private promptApiDiagnostics = new BehaviorSubject<PromptApiDiagnostics>(
    this.buildPromptApiDiagnostics('unsupported')
  );

  public promptApiDiagnostics$ = this.promptApiDiagnostics.asObservable();

  private readonly transcriber = new Transcriber({
    audioModel: {
      transcribe: (wavBytes, sampleRate, instruction, language) =>
        this.transcribeWithModels(wavBytes, sampleRate, instruction, language)
    },
    textModel: {
      complete: (instruction, language) => this.completeWithModels(instruction, language)
    },
    musicBrainz: new MusicBrainzClient(),
    getLanguage: () => this.getTranscriptionLanguage()
  });

  public saveApiKey(key: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.apiKeyKey, key);
    }
  }

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
    const stored = localStorage.getItem(this.transcriptionLanguageKey);
    return TRANSCRIPTION_LANGUAGE_OPTIONS.some(option => option.value === stored)
      ? (stored as TranscriptionLanguageCode)
      : 'auto';
  }

  public getPromptApiDiagnosticsValue(): PromptApiDiagnostics {
    return this.promptApiDiagnostics.getValue();
  }

  public async refreshPromptApiDiagnostics(): Promise<PromptApiDiagnostics> {
    const diagnostics = await this.evaluatePromptApiDiagnostics(
      this.getAudioPromptOptions(this.getTranscriptionLanguage())
    );
    this.promptApiDiagnostics.next(diagnostics);
    return diagnostics;
  }

  public async isChromeAIAvailable(): Promise<boolean> {
    return (await this.refreshPromptApiDiagnostics()).status === 'available';
  }

  /**
   * Triggers the on-device model download. Must be called from a user gesture
   * (e.g. a button click), because Chrome requires user activation to start the
   * download when availability is 'downloadable'. Reports progress via the
   * monitor's downloadprogress event, then refreshes diagnostics.
   */
  public async downloadPromptApiModel(onProgress?: (fraction: number) => void): Promise<PromptApiDiagnostics> {
    const model = this.getPromptApiModel();
    if (!model || typeof model.create !== 'function') {
      const diagnostics = this.buildPromptApiDiagnostics('unsupported');
      this.promptApiDiagnostics.next(diagnostics);
      return diagnostics;
    }

    const options = this.getAudioPromptOptions(this.getTranscriptionLanguage());
    if (onProgress) {
      options['monitor'] = (monitor: { addEventListener: (type: string, listener: (event: { loaded: number }) => void) => void }) => {
        monitor.addEventListener('downloadprogress', event => onProgress(event.loaded));
      };
    }

    this.promptApiDiagnostics.next(this.buildPromptApiDiagnostics('downloading'));

    try {
      const session = await model.create(options);
      await this.destroyPromptApiSession(session);

      // Availability can lag briefly behind the finished download; re-check
      // until it flips to 'available' so the UI updates without a page reload.
      let diagnostics = await this.refreshPromptApiDiagnostics();
      for (let attempt = 0; attempt < 15 && diagnostics.status !== 'available'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        diagnostics = await this.refreshPromptApiDiagnostics();
      }
      return diagnostics;
    } catch (error) {
      const diagnostics = this.buildPromptApiDiagnostics(
        'error',
        this.formatPromptApiError(error),
        'The on-device model download failed. A user gesture is required, and the device must meet the hardware requirements.'
      );
      this.promptApiDiagnostics.next(diagnostics);
      return diagnostics;
    }
  }

  // --- TranscriptionPort ---

  public async hasProvider(): Promise<boolean> {
    if (this.getApiKey().trim()) {
      return true;
    }
    return (await this.refreshPromptApiDiagnostics()).status === 'available';
  }

  public transcribeAudio(wavBytes: Uint8Array, sampleRate: number): Promise<string | null> {
    return this.transcriber.transcribeAudio(wavBytes, sampleRate);
  }

  public extractSongTitle(text: string): Promise<SongTitleExtractionResult | null> {
    return this.transcriber.extractSongTitle(text);
  }

  // --- model routing: Prompt API first (when supported), then Gemini ---

  private async transcribeWithModels(
    wavBytes: Uint8Array,
    sampleRate: number,
    instruction: string,
    language: TranscriptionLanguageCode
  ): Promise<string | null> {
    if (this.isPromptApiLanguageSupported(language)) {
      const result = await this.promptApiTranscribe(wavBytes, language, instruction);
      if (result !== null) {
        return result;
      }
    }

    const apiKey = this.getApiKey().trim();
    if (apiKey) {
      return new GeminiModel({ apiKey }).transcribe(wavBytes, sampleRate, instruction);
    }
    return null;
  }

  private async completeWithModels(instruction: string, language: TranscriptionLanguageCode): Promise<string | null> {
    if (this.isPromptApiLanguageSupported(language)) {
      const result = await this.promptApiComplete(instruction, language);
      if (result !== null) {
        return result;
      }
    }

    const apiKey = this.getApiKey().trim();
    if (apiKey) {
      return new GeminiModel({ apiKey }).complete(instruction);
    }
    return null;
  }

  private async promptApiTranscribe(wavBytes: Uint8Array, language: TranscriptionLanguageCode, instruction: string): Promise<string | null> {
    const session = await this.createPromptApiSession(this.getAudioPromptOptions(language));
    if (!session) {
      return null;
    }

    try {
      const blob = bytesToBlob(wavBytes, 'audio/wav');
      const result = await session.prompt([
        {
          role: 'user',
          content: [
            { type: 'text', value: instruction },
            { type: 'audio', value: blob }
          ]
        }
      ]);
      this.promptApiDiagnostics.next(this.buildPromptApiDiagnostics('available'));
      return normalizeModelText(result);
    } catch (error) {
      this.promptApiDiagnostics.next(
        this.buildPromptApiDiagnostics('error', this.formatPromptApiError(error), 'Prompt API audio prompt failed after session creation.')
      );
      console.warn('Prompt API audio transcription failed, falling back to Gemini if available.', error);
      return null;
    } finally {
      await this.destroyPromptApiSession(session);
    }
  }

  private async promptApiComplete(instruction: string, language: TranscriptionLanguageCode): Promise<string | null> {
    const session = await this.createPromptApiSession(this.getTextPromptOptions(language));
    if (!session) {
      return null;
    }

    try {
      const result = await session.prompt(instruction);
      return normalizeModelText(result);
    } catch (error) {
      console.warn('Prompt API title extraction failed, falling back to Gemini/heuristics.', error);
      return null;
    } finally {
      await this.destroyPromptApiSession(session);
    }
  }

  // --- Prompt API plumbing (browser-only) ---

  private getPromptApiModel(): PromptApiModel | null {
    const globalObj = globalThis as PromptApiGlobal;
    return globalObj.LanguageModel ?? globalObj.ai?.languageModel ?? null;
  }

  private isPromptApiLanguageSupported(language: TranscriptionLanguageCode): boolean {
    return language === 'auto'
      || (SUPPORTED_PROMPT_API_LANGUAGES as ReadonlyArray<string>).includes(language);
  }

  private getPromptApiLanguages(language: TranscriptionLanguageCode): ReadonlyArray<PromptApiLanguageCode> {
    switch (language) {
      case 'en':
      case 'es':
      case 'ja':
        return [language];
      default:
        return SUPPORTED_PROMPT_API_LANGUAGES;
    }
  }

  private getTextPromptOptions(language: TranscriptionLanguageCode): Record<string, unknown> {
    const languages = this.getPromptApiLanguages(language);
    return {
      expectedInputs: [{ type: 'text', languages: ['en', ...languages] }],
      expectedOutputs: [{ type: 'text', languages }]
    };
  }

  private getAudioPromptOptions(language: TranscriptionLanguageCode): Record<string, unknown> {
    return {
      expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'audio' }],
      expectedOutputs: [{ type: 'text', languages: this.getPromptApiLanguages(language) }]
    };
  }

  private async getPromptApiAvailability(options: Record<string, unknown>): Promise<PromptApiAvailability> {
    const model = this.getPromptApiModel();
    if (!model) {
      return 'unavailable';
    }
    if (typeof model.availability === 'function') {
      return this.normalizePromptApiAvailability(await model.availability(options));
    }
    if (typeof model.capabilities === 'function') {
      const capabilities = await model.capabilities();
      if (capabilities.available === 'yes') {
        return 'available';
      }
      return capabilities.available === 'after-download' ? 'downloadable' : 'unavailable';
    }
    return 'available';
  }

  private async createPromptApiSession(options: Record<string, unknown>): Promise<PromptApiSession | null> {
    const model = this.getPromptApiModel();
    if (!model || typeof model.create !== 'function') {
      this.promptApiDiagnostics.next(this.buildPromptApiDiagnostics('unsupported'));
      return null;
    }

    const diagnostics = await this.evaluatePromptApiDiagnostics(options);
    this.promptApiDiagnostics.next(diagnostics);
    if (diagnostics.status !== 'available') {
      return null;
    }

    try {
      const session = await model.create(options);
      this.promptApiDiagnostics.next(this.buildPromptApiDiagnostics('available'));
      return session;
    } catch (error) {
      this.promptApiDiagnostics.next(
        this.buildPromptApiDiagnostics('error', this.formatPromptApiError(error), 'Chrome reported the Prompt API as available, but session creation failed.')
      );
      console.warn('Prompt API session creation failed', error);
      return null;
    }
  }

  private async evaluatePromptApiDiagnostics(options: Record<string, unknown>): Promise<PromptApiDiagnostics> {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return this.buildPromptApiDiagnostics(
        'unsupported',
        null,
        'The Prompt API requires a secure context. Open the app via http://localhost:4200 or over HTTPS — plain HTTP on a network IP (e.g. http://192.168.x.x) is not secure, so Chrome does not expose LanguageModel. Use localhost/HTTPS, or configure the Gemini fallback.'
      );
    }

    const model = this.getPromptApiModel();
    if (!model || typeof model.create !== 'function') {
      return this.buildPromptApiDiagnostics('unsupported');
    }
    try {
      return this.buildPromptApiDiagnostics(await this.getPromptApiAvailability(options));
    } catch (error) {
      return this.buildPromptApiDiagnostics(
        'error',
        this.formatPromptApiError(error),
        'Chrome exposed LanguageModel, but checking Prompt API availability failed.'
      );
    }
  }

  private normalizePromptApiAvailability(value: string): PromptApiAvailability {
    switch (value) {
      case 'available':
      case 'downloadable':
      case 'downloading':
      case 'unavailable':
        return value;
      default:
        return 'unavailable';
    }
  }

  private buildPromptApiDiagnostics(status: PromptApiStatus, lastError: string | null = null, detailOverride?: string): PromptApiDiagnostics {
    if (detailOverride) {
      return { status, detail: detailOverride, lastError };
    }

    switch (status) {
      case 'available':
        return { status, detail: 'Chrome reports that the audio Prompt API is ready to create sessions.', lastError };
      case 'downloadable':
        return { status, detail: 'The on-device Prompt API model is not ready yet and must be downloaded by Chrome.', lastError };
      case 'downloading':
        return { status, detail: 'Chrome is still downloading the on-device model required for audio Prompt API use.', lastError };
      case 'unavailable':
        return { status, detail: 'Chrome reports that the audio Prompt API is unavailable in this browser or device context.', lastError };
      case 'error':
        return { status, detail: 'Chrome exposed the Prompt API, but a runtime check or session call failed.', lastError };
      case 'unsupported':
      default:
        return { status: 'unsupported', detail: 'This browser context does not expose the LanguageModel Prompt API.', lastError };
    }
  }

  private formatPromptApiError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return 'Unknown Prompt API error';
  }

  private async destroyPromptApiSession(session: PromptApiSession | null): Promise<void> {
    if (!session || typeof session.destroy !== 'function') {
      return;
    }
    try {
      await session.destroy();
    } catch {
      // Ignore session cleanup issues.
    }
  }
}