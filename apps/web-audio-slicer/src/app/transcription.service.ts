import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

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

export interface SongTitleExtractionResult {
  title: string;
  source: 'metadata' | 'transcription';
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

interface MusicBrainzRecordingSearchResponse {
  recordings?: MusicBrainzRecording[];
}

interface MusicBrainzRecording {
  score?: number | string;
  title?: string;
  'artist-credit'?: MusicBrainzArtistCredit[];
}

interface MusicBrainzArtistCredit {
  name?: string;
  artist?: {
    name?: string;
  };
}

interface MusicBrainzWorkSearchResponse {
  works?: MusicBrainzWork[];
}

interface MusicBrainzWork {
  score?: number | string;
  title?: string;
  type?: string;
}

export type PromptApiAvailability = 'available' | 'unavailable' | 'downloadable' | 'downloading';

export type PromptApiStatus = PromptApiAvailability | 'unsupported' | 'error';

export interface PromptApiDiagnostics {
  status: PromptApiStatus;
  detail: string;
  lastError: string | null;
}

type PromptApiLanguageCode = 'en' | 'es' | 'ja';

const SUPPORTED_PROMPT_API_LANGUAGES: ReadonlyArray<PromptApiLanguageCode> = ['en', 'es', 'ja'];

type PromptApiCapabilityResult = {
  available?: 'no' | 'yes' | 'after-download';
};

type PromptApiMessageContent = {
  type: 'text' | 'audio';
  value: string | Blob;
};

type PromptApiMessage = {
  role: 'user';
  content: PromptApiMessageContent[];
};

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
  ai?: {
    languageModel?: PromptApiModel;
  };
};

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
  private musicBrainzLookupQueue: Promise<void> = Promise.resolve();
  private lastMusicBrainzLookupAt = 0;
  private promptApiDiagnostics = new BehaviorSubject<PromptApiDiagnostics>(
    this.buildPromptApiDiagnostics('unsupported')
  );

  public promptApiDiagnostics$ = this.promptApiDiagnostics.asObservable();

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

  /**
   * Checks if Chrome Built-in AI (Prompt API) is available.
   */
  public async isChromeAIAvailable(): Promise<boolean> {
    const diagnostics = await this.refreshPromptApiDiagnostics();
    return diagnostics.status === 'available';
  }

  public async hasTranscriptionProvider(): Promise<boolean> {
    if (this.getApiKey().trim()) {
      return true;
    }

    const diagnostics = await this.refreshPromptApiDiagnostics();
    return diagnostics.status === 'available';
  }

  /**
   * Transcribes a WAV audio blob with the browser Prompt API when available,
   * falling back to Gemini if the user configured an API key.
   */
  public async transcribeAudio(audioBlob: Blob): Promise<string | null> {
    const transcriptionLanguage = this.getTranscriptionLanguage();
    // The on-device model only outputs en/es/ja; for other languages go straight
    // to Gemini instead of getting a wrong-language transcript.
    const promptResult = this.isPromptApiLanguageSupported(transcriptionLanguage)
      ? await this.transcribeWithPromptApi(audioBlob, transcriptionLanguage)
      : null;
    if (promptResult !== null) {
      return promptResult;
    }

    const apiKey = this.getApiKey().trim();
    if (!apiKey) {
      return null;
    }

    return this.transcribeWithGemini(audioBlob, apiKey, transcriptionLanguage);
  }

  /**
   * Refines a raw transcript using Chrome Prompt API or Gemini API.
   * Extracts a clean title for the MP3 file.
   */
  public async extractSongTitle(rawText: string): Promise<SongTitleExtractionResult | null> {
    const normalizedText = rawText.trim();
    if (!normalizedText) {
      return null;
    }

    const transcriptionLanguage = this.getTranscriptionLanguage();

    // 1. Ask the LLM for a clean title candidate first. Searching MusicBrainz
    // with the raw, filler-heavy transcript produced false matches and wasted
    // rate-limited requests; a clean "Artist - Title" query is far more precise.
    let candidateTitle: string | null = null;

    if (this.isPromptApiLanguageSupported(transcriptionLanguage)) {
      candidateTitle = await this.extractSongTitleWithPromptApi(normalizedText, transcriptionLanguage);
    }

    if (!candidateTitle) {
      const apiKey = this.getApiKey().trim();
      if (apiKey) {
        candidateTitle = await this.extractSongTitleWithGemini(normalizedText, apiKey, transcriptionLanguage);
      }
    }

    if (!candidateTitle) {
      candidateTitle = this.normalizeTitle(this.fallbackRegexExtraction(normalizedText));
    }

    if (!candidateTitle) {
      return null;
    }

    // 2. Verify/canonicalize the candidate against MusicBrainz metadata.
    const metadataTitle = await this.extractSongTitleWithMusicBrainz(candidateTitle);
    if (metadataTitle) {
      return {
        title: metadataTitle,
        source: 'metadata'
      };
    }

    return {
      title: candidateTitle,
      source: 'transcription'
    };
  }

  private async transcribeWithGemini(
    audioBlob: Blob,
    apiKey: string,
    transcriptionLanguage: TranscriptionLanguageCode
  ): Promise<string> {
    const base64Data = await this.blobToBase64(audioBlob);
    const data = await this.requestGeminiContent(apiKey, [
      {
        inlineData: {
          mimeType: 'audio/wav',
          data: base64Data
        }
      },
      {
        text: this.buildTranscriptionInstruction(transcriptionLanguage)
      }
    ]);

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Invalid response from Gemini API');
    }

    const normalized = this.normalizeModelText(text);
    return this.isLikelyNonTranscript(normalized) ? '' : normalized;
  }

  private async requestGeminiContent(apiKey: string, parts: unknown[]): Promise<GeminiGenerateContentResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0
        }
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
    if (!this.getPromptApiModel()) {
      this.promptApiDiagnostics.next(this.buildPromptApiDiagnostics('unsupported'));
      return null;
    }

    const session = await this.createPromptApiSession(this.getAudioPromptOptions(transcriptionLanguage));
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

      this.promptApiDiagnostics.next(this.buildPromptApiDiagnostics('available'));
      const normalized = this.normalizeModelText(result);
      return this.isLikelyNonTranscript(normalized) ? '' : normalized;
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

  private async extractSongTitleWithPromptApi(
    rawText: string,
    transcriptionLanguage: TranscriptionLanguageCode
  ): Promise<string | null> {
    const session = await this.createPromptApiSession(this.getTextPromptOptions(transcriptionLanguage));
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
      const data = await this.requestGeminiContent(apiKey, [
        {
          text: this.buildTitleExtractionInstruction(rawText, transcriptionLanguage)
        }
      ]);

      const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return result ? this.normalizeTitle(this.normalizeModelText(result)) : null;
    } catch (error) {
      console.warn('Gemini title extraction failed', error);
      return null;
    }
  }

  private async extractSongTitleWithMusicBrainz(rawText: string): Promise<string | null> {
    const searchQueries = this.buildMusicBrainzSearchQueries(rawText);

    for (const query of searchQueries) {
      // Rehearsal pieces are usually classical/concert works, so search works
      // first; recordings are the fallback for non-classical material.
      const workTitle = await this.lookupMusicBrainzWorkTitle(query);
      if (workTitle) {
        return workTitle;
      }

      const recordingTitle = await this.lookupMusicBrainzRecordingTitle(query);
      if (recordingTitle) {
        return recordingTitle;
      }
    }

    return null;
  }

  private getPromptApiModel(): PromptApiModel | null {
    const globalObj = globalThis as PromptApiGlobal;
    return globalObj.LanguageModel ?? globalObj.ai?.languageModel ?? null;
  }

  private getTextPromptOptions(language: TranscriptionLanguageCode): Record<string, unknown> {
    const promptApiLanguages = this.getPromptApiLanguages(language);

    return {
      expectedInputs: [{ type: 'text', languages: ['en', ...promptApiLanguages] }],
      expectedOutputs: [{ type: 'text', languages: promptApiLanguages }]
    };
  }

  private getAudioPromptOptions(language: TranscriptionLanguageCode): Record<string, unknown> {
    const promptApiLanguages = this.getPromptApiLanguages(language);

    return {
      expectedInputs: [
        { type: 'text', languages: ['en'] },
        { type: 'audio' }
      ],
      expectedOutputs: [{ type: 'text', languages: promptApiLanguages }]
    };
  }

  private buildTranscriptionInstruction(language: TranscriptionLanguageCode): string {
    const languageInstruction = this.getTranscriptionLanguageInstruction(language);
    return [
      'Transcribe the spoken audio in this gap from an ensemble rehearsal, before a piece of music is played.',
      'Someone may announce the name of the piece, its composer, movement, or opus/catalog number some time before it is played. Pay attention to those announcements.',
      'Transcribe speech verbatim; do not summarize, describe the audio, or add commentary.',
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
      'This transcript was captured from speech during an ensemble rehearsal, before a piece of music was played.',
      'Extract a concise MP3 title for the piece that follows.',
      'Prefer the format "Composer - Piece Title" for classical music, or "Artist - Song Title" otherwise.',
      'Preserve any movement numbers, opus or catalog numbers, and keys mentioned (e.g. "Symphony No. 5 in C minor, Op. 67").',
      'If only the piece title or composer is clear, return that.',
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
      case 'auto':
      default:
        return SUPPORTED_PROMPT_API_LANGUAGES;
    }
  }

  private isTranscriptionLanguageCode(value: string | null): value is TranscriptionLanguageCode {
    return TRANSCRIPTION_LANGUAGE_OPTIONS.some(option => option.value === value);
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
    const model = this.getPromptApiModel();
    if (!model || typeof model.create !== 'function') {
      return this.buildPromptApiDiagnostics('unsupported');
    }

    try {
      const availability = await this.getPromptApiAvailability(options);
      return this.buildPromptApiDiagnostics(availability);
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

  private buildPromptApiDiagnostics(
    status: PromptApiStatus,
    lastError: string | null = null,
    detailOverride?: string
  ): PromptApiDiagnostics {
    if (detailOverride) {
      return {
        status,
        detail: detailOverride,
        lastError
      };
    }

    switch (status) {
      case 'available':
        return {
          status,
          detail: 'Chrome reports that the audio Prompt API is ready to create sessions.',
          lastError
        };
      case 'downloadable':
        return {
          status,
          detail: 'The on-device Prompt API model is not ready yet and must be downloaded by Chrome.',
          lastError
        };
      case 'downloading':
        return {
          status,
          detail: 'Chrome is still downloading the on-device model required for audio Prompt API use.',
          lastError
        };
      case 'unavailable':
        return {
          status,
          detail: 'Chrome reports that the audio Prompt API is unavailable in this browser or device context.',
          lastError
        };
      case 'error':
        return {
          status,
          detail: 'Chrome exposed the Prompt API, but a runtime check or session call failed.',
          lastError
        };
      case 'unsupported':
      default:
        return {
          status: 'unsupported',
          detail: 'This browser context does not expose the LanguageModel Prompt API.',
          lastError
        };
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

  /**
   * Detects model meta-responses ("there is no speech", "I cannot transcribe...")
   * that describe the audio instead of transcribing it, so they are treated as
   * an empty transcript rather than becoming a track title.
   */
  private isLikelyNonTranscript(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return true;
    }

    const metaResponsePatterns = [
      /^(there is|there s) (no|nothing|not)\b/,
      /^no (speech|spoken|audio|intelligible|words|voice|discernible)\b/,
      /^(i m sorry|i cannot|i can t|i am unable|sorry)\b/,
      /^(unable|cannot) to (transcribe|hear|detect|understand)\b/,
      /^the (audio|recording|clip|file) (is|contains|does|appears|sounds)\b/,
      /^(this|it) (is|sounds|appears) (silent|silence|inaudible|quiet|empty|music|instrumental)\b/,
      /^(silence|silent|inaudible|unintelligible|no speech)$/
    ];

    return metaResponsePatterns.some(pattern => pattern.test(normalized));
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
    const cleaned = this.replaceControlCharacters(title)
      .replace(/[\\/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      return '';
    }

    return cleaned.length > 120 ? cleaned.slice(0, 117).trimEnd() + '...' : cleaned;
  }

  private buildMusicBrainzSearchQueries(rawText: string): string[] {
    const normalized = this.replaceControlCharacters(rawText)
      .replace(/["'`]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return [];
    }

    const filteredTokens = normalized
      .split(/\s+/)
      .filter(token => !this.isLikelyPresenterFiller(token));
    const compactQuery = filteredTokens.slice(0, 14).join(' ').trim();
    const bySplit = normalized.split(/\s+by\s+/i).map(part => part.trim()).filter(Boolean);
    // Title candidates usually arrive as "Artist - Title"; also search the
    // combined form and each side of the dash separately.
    const dashSplit = normalized.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
    const dashJoined = dashSplit.join(' ');

    return Array.from(new Set([
      normalized.slice(0, 160),
      dashJoined,
      compactQuery,
      ...bySplit,
      ...dashSplit
    ].filter(query => query.length >= 4)));
  }

  private isLikelyPresenterFiller(token: string): boolean {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    return new Set([
      'again',
      'and',
      'coming',
      'everyone',
      'everybody',
      'gonna',
      'heard',
      'here',
      'intro',
      'just',
      'let',
      'lets',
      'listen',
      'listening',
      'next',
      'now',
      'ok',
      'okay',
      'play',
      'playing',
      'please',
      'radio',
      'ready',
      'rehearsal',
      'shall',
      'so',
      'song',
      'that',
      'the',
      'this',
      'track',
      'uh',
      'um',
      'up',
      'us',
      'was',
      'well',
      'were',
      'will',
      'with',
      'you',
      'your'
    ]).has(normalized);
  }

  private async lookupMusicBrainzRecordingTitle(query: string): Promise<string | null> {
    const data = await this.fetchMusicBrainzJson<MusicBrainzRecordingSearchResponse>('recording', query);
    const match = data.recordings?.find(recording => this.getMusicBrainzScore(recording.score) >= 95);
    if (!match?.title) {
      return null;
    }

    const artistName = this.formatMusicBrainzArtistCredit(match['artist-credit']);
    if (artistName) {
      return this.normalizeTitle(`${artistName} - ${match.title}`);
    }

    return this.normalizeTitle(match.title);
  }

  private async lookupMusicBrainzWorkTitle(query: string): Promise<string | null> {
    const data = await this.fetchMusicBrainzJson<MusicBrainzWorkSearchResponse>('work', query);
    const match = data.works?.find(work => this.getMusicBrainzScore(work.score) >= 95);
    if (!match?.title) {
      return null;
    }

    return this.normalizeTitle(match.title);
  }

  private async fetchMusicBrainzJson<T>(entityType: 'recording' | 'work', query: string): Promise<T> {
    return this.runMusicBrainzLookup(async () => {
      const url = new URL(`https://musicbrainz.org/ws/2/${entityType}`);
      url.searchParams.set('query', query);
      url.searchParams.set('fmt', 'json');
      url.searchParams.set('limit', '5');
      url.searchParams.set('dismax', 'true');

      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 503) {
          console.warn('MusicBrainz rate limit hit while searching transcript metadata.');
          return {} as T;
        }

        throw new Error(`MusicBrainz lookup failed: ${response.status}`);
      }

      return await response.json() as T;
    });
  }

  private async runMusicBrainzLookup<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.musicBrainzLookupQueue.then(async () => {
      const elapsed = Date.now() - this.lastMusicBrainzLookupAt;
      const waitMs = Math.max(0, 1100 - elapsed);
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      try {
        return await operation();
      } finally {
        this.lastMusicBrainzLookupAt = Date.now();
      }
    });

    this.musicBrainzLookupQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private getMusicBrainzScore(value: number | string | undefined): number {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
  }

  private formatMusicBrainzArtistCredit(credits: MusicBrainzArtistCredit[] | undefined): string | null {
    if (!credits || credits.length === 0) {
      return null;
    }

    const names = credits
      .map(credit => credit.name ?? credit.artist?.name ?? '')
      .map(name => this.normalizeModelText(name))
      .filter(Boolean);

    return names.length > 0 ? names.join(' ') : null;
  }

  private replaceControlCharacters(value: string): string {
    let normalized = '';

    for (const character of value) {
      normalized += character.charCodeAt(0) <= 0x1f ? ' ' : character;
    }

    return normalized;
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
