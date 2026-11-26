/**
 * Platform-agnostic domain types shared by the browser app, the Node/Bun CLI,
 * and the tool layer. Nothing here may import Angular, DOM, or Node APIs.
 */

export type TitleSource = 'default' | 'transcription' | 'metadata' | 'manual';

export interface Track {
  key: number;
  id: number;
  title: string;
  titleSource: TitleSource;
  startTime: number;
  endTime: number;
  duration: number;
  /** Encoded MP3 bytes. Populated by the on-demand Export stage, not slicing. */
  mp3Bytes: Uint8Array | null;
  /** Actual processed duration (incl. reverb tail); set by Export. Boundaries stay sliced. */
  processedDuration?: number;
  transcription: string | null;
  status: 'pending' | 'encoding' | 'done' | 'failed';
}

export interface SilenceSegment {
  id: number;
  startTime: number;
  endTime: number;
  duration: number;
  text: string | null;
  status: 'idle' | 'transcribing' | 'done' | 'skipped' | 'failed';
  /** Prepared speech audio (mono, resampled, normalized) for external transcribers. */
  speechWav?: Uint8Array;
  speechSampleRate?: number;
}

export interface SlicerState {
  status: 'idle' | 'slicing' | 'done';
  fileName: string;
  progress: number;
  currentTime: number;
  totalDurationEstimate: number;
  dbLevel: number;
  currentTrackId: number | null;
  currentStateName: 'SILENCE' | 'SONG';
}

export interface SliceOptions {
  transcribeSpeechGaps?: boolean;
  trackStartIndex?: number;
  fileName?: string;
  /** Optional total byte size, used to estimate duration/progress. */
  fileSizeBytes?: number;
  /** When true, gaps are prepared but left for an external (calling-model) transcriber. */
  externalTranscription?: boolean;
}

export interface SlicerParameters {
  thresholdDb: number;
  minSilenceDuration: number;
  minSongDuration: number;
  mp3Bitrate: number;
  /** Audio kept before the threshold crossing so a piece's quiet attack isn't cut. */
  preRollSec: number;
  /** Audio kept after the level drop so a piece's quiet decay isn't cut. */
  postRollSec: number;
}

export const DEFAULT_SLICER_PARAMETERS: SlicerParameters = {
  thresholdDb: -45,
  minSilenceDuration: 2.0,
  minSongDuration: 8.0,
  mp3Bitrate: 192,
  preRollSec: 0.3,
  postRollSec: 0.5
};

export interface SongTitleExtractionResult {
  title: string;
  source: 'metadata' | 'transcription';
}

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

export interface SliceResult {
  tracks: Track[];
  segments: SilenceSegment[];
  state: SlicerState;
}