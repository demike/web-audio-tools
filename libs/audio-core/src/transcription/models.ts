/**
 * Low-level model seams. The core builds instructions; an adapter executes them.
 * Adapters: Gemini (fetch), Chrome Prompt API (browser), or the calling model
 * (a tool host asks the invoking LLM). This is what lets the calling model do
 * the transcription instead of an embedded API client.
 */
import type { TranscriptionLanguageCode } from '../types';

export interface AudioModel {
  /** Returns the transcript, or null when the model cannot run. */
  transcribe(wavBytes: Uint8Array, sampleRate: number, instruction: string, language: TranscriptionLanguageCode): Promise<string | null>;
}

export interface TextModel {
  /** Executes a text instruction (e.g. title extraction), or null when unavailable. */
  complete(instruction: string, language: TranscriptionLanguageCode): Promise<string | null>;
}