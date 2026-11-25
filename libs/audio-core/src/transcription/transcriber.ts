/**
 * Orchestrates transcription and title extraction behind the TranscriptionPort
 * seam. Composes an audio model, a text model, and MusicBrainz verification.
 * The same class serves the CLI (Gemini models), the browser (Prompt API or
 * Gemini), and the tool layer (calling-model adapters).
 */
import type { TranscriptionPort } from '../ports';
import type { SongTitleExtractionResult, TranscriptionLanguageCode } from '../types';
import type { AudioModel, TextModel } from './models';
import { MusicBrainzClient } from './musicbrainz';
import {
  buildTitleExtractionInstruction,
  buildTranscriptionInstruction,
  fallbackRegexExtraction,
  isLikelyNonTranscript,
  normalizeModelText,
  normalizeTitle
} from './prompts';

export interface TranscriberOptions {
  audioModel?: AudioModel | null;
  textModel?: TextModel | null;
  musicBrainz?: MusicBrainzClient;
  getLanguage: () => TranscriptionLanguageCode;
}

export class Transcriber implements TranscriptionPort {
  private readonly audioModel: AudioModel | null;
  private readonly textModel: TextModel | null;
  private readonly musicBrainz: MusicBrainzClient;
  private readonly getLanguage: () => TranscriptionLanguageCode;

  constructor(options: TranscriberOptions) {
    this.audioModel = options.audioModel ?? null;
    this.textModel = options.textModel ?? null;
    this.musicBrainz = options.musicBrainz ?? new MusicBrainzClient();
    this.getLanguage = options.getLanguage;
  }

  public async hasProvider(): Promise<boolean> {
    return this.audioModel !== null;
  }

  public async transcribeAudio(wavBytes: Uint8Array, sampleRate: number): Promise<string | null> {
    if (!this.audioModel) {
      return null;
    }

    const language = this.getLanguage();
    const raw = await this.audioModel.transcribe(wavBytes, sampleRate, buildTranscriptionInstruction(language), language);
    if (raw === null) {
      return null;
    }

    const normalized = normalizeModelText(raw);
    return isLikelyNonTranscript(normalized) ? '' : normalized;
  }

  public async extractSongTitle(rawText: string): Promise<SongTitleExtractionResult | null> {
    const normalizedText = rawText.trim();
    if (!normalizedText) {
      return null;
    }

    const language = this.getLanguage();

    // 1. Ask the text model for a clean candidate first.
    let candidate: string | null = null;
    if (this.textModel) {
      const result = await this.textModel.complete(buildTitleExtractionInstruction(normalizedText, language), language);
      candidate = result ? normalizeTitle(normalizeModelText(result)) : null;
    }

    if (!candidate) {
      candidate = normalizeTitle(fallbackRegexExtraction(normalizedText));
    }

    if (!candidate) {
      return null;
    }

    // 2. Verify/canonicalize against MusicBrainz metadata.
    const metadataTitle = await this.musicBrainz.findTitle(candidate);
    if (metadataTitle) {
      return { title: metadataTitle, source: 'metadata' };
    }

    return { title: candidate, source: 'transcription' };
  }
}