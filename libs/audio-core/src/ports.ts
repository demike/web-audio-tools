/**
 * The seams of the core. Each interface is satisfied by at least two adapters
 * (browser + Node/Bun, or an embedded provider + the calling model), which is
 * what makes them real seams rather than hypothetical ones.
 */
import type {
  SilenceSegment,
  SlicerState,
  SongTitleExtractionResult,
  Track
} from './types';

/** A source of raw WAV bytes. Browser: File.stream(); Node/Bun: fs read stream. */
export type AudioInput = AsyncIterable<Uint8Array>;

/**
 * Encodes PCM windows to MP3. `encode` resolves once the window is accepted,
 * so a slow adapter (e.g. a saturated Web Worker) naturally backpressures the
 * slicer. `finish` resolves with the complete MP3 byte stream.
 */
export interface Mp3EncoderPort {
  start(channels: number, sampleRate: number, bitrate: number): void | Promise<void>;
  encode(channels: Float32Array[]): Promise<void>;
  finish(): Promise<Uint8Array>;
  abort(): void;
}

export type Mp3EncoderFactory = () => Mp3EncoderPort;

/**
 * Transcribes speech gaps and extracts track titles. Adapters:
 *  - Gemini (fetch, Node/Bun/browser)
 *  - Chrome Prompt API (browser only)
 *  - Calling model (tool host asks the invoking LLM)
 * A null/absent port means gaps are surfaced but not transcribed by the core.
 */
export interface TranscriptionPort {
  hasProvider(): Promise<boolean>;
  transcribeAudio(wavBytes: Uint8Array, sampleRate: number): Promise<string | null>;
  extractSongTitle(text: string): Promise<SongTitleExtractionResult | null>;
}

/** Observes slicer progress. All callbacks are optional. */
export interface SlicerObserver {
  onState?(state: SlicerState): void;
  onVolume?(db: number): void;
  onTrackAdded?(track: Track): void;
  onTrackUpdated?(track: Track): void;
  onTrackRemoved?(trackKey: number): void;
  onSegmentAdded?(segment: SilenceSegment): void;
  onSegmentUpdated?(segment: SilenceSegment): void;
}

/** Minimal key/value persistence. Browser: localStorage; Node: env/file/memory. */
export interface ConfigStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Timing seams so the core never touches performance/requestAnimationFrame directly. */
export interface Scheduler {
  now(): number;
  yield(): Promise<void>;
}