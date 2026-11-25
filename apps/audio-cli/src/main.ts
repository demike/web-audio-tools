/**
 * Node/Bun CLI for the audio core. Slices a WAV into MP3 tracks, optionally
 * transcribes spoken announcements via Gemini, and writes a JSON manifest.
 *
 *   bun apps/audio-cli/src/main.ts rehearsal.wav --out ./tracks
 *   node dist/apps/audio-cli/main.js rehearsal.wav --out ./tracks
 *
 * Transcription outside the browser uses Gemini (the Prompt API is Chrome-only).
 * Set GEMINI_API_KEY or pass --gemini-key. Without a key, tracks are still
 * sliced and encoded, but titles stay generic.
 */
import { basename, join, resolve } from 'node:path';
import {
  DEFAULT_SLICER_PARAMETERS,
  GeminiModel,
  LameMp3Encoder,
  MusicBrainzClient,
  Slicer,
  Transcriber,
  isTranscriptionLanguageCode,
  type SlicerObserver,
  type TranscriptionLanguageCode
} from '@web-audio-tools/audio-core';
import { ensureDir, fileAudioInput, getFileSize, writeBytes } from './node-adapters';

interface CliOptions {
  input: string;
  outDir: string;
  thresholdDb: number;
  minSilenceDuration: number;
  minSongDuration: number;
  mp3Bitrate: number;
  preRollSec: number;
  postRollSec: number;
  language: TranscriptionLanguageCode;
  trackStartIndex: number;
  transcribe: boolean;
  geminiKey: string;
}

function printHelp(): void {
  console.log(`Usage: audio-cli <input.wav> [options]

Options:
  --out <dir>            Output directory (default: ./tracks)
  --threshold <dB>       Silence threshold in dB (default: -45)
  --min-silence <sec>    Minimum silence to split (default: 2.0)
  --min-song <sec>       Minimum piece duration to keep (default: 8.0)
  --bitrate <kbps>       MP3 bitrate (default: 192)
  --pre-roll <sec>       Audio kept before each piece's attack (default: 0.3)
  --post-roll <sec>      Audio kept after each piece's decay (default: 0.5)
  --lang <code>          Transcription language: auto,en,de,es,fr,it,pt,nl,pl,ja (default: auto)
  --start-index <n>      Starting track number (default: 1)
  --no-transcribe        Skip speech transcription
  --gemini-key <key>     Gemini API key (or set GEMINI_API_KEY)
  -h, --help             Show this help`);
}

function parseArgs(argv: string[]): CliOptions | null {
  const options: CliOptions = {
    input: '',
    outDir: './tracks',
    thresholdDb: DEFAULT_SLICER_PARAMETERS.thresholdDb,
    minSilenceDuration: DEFAULT_SLICER_PARAMETERS.minSilenceDuration,
    minSongDuration: DEFAULT_SLICER_PARAMETERS.minSongDuration,
    mp3Bitrate: DEFAULT_SLICER_PARAMETERS.mp3Bitrate,
    preRollSec: DEFAULT_SLICER_PARAMETERS.preRollSec,
    postRollSec: DEFAULT_SLICER_PARAMETERS.postRollSec,
    language: 'auto',
    trackStartIndex: 1,
    transcribe: true,
    geminiKey: process.env['GEMINI_API_KEY'] ?? ''
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => argv[++i] ?? '';
    switch (arg) {
      case '-h':
      case '--help':
        printHelp();
        return null;
      case '--out':
        options.outDir = next();
        break;
      case '--threshold':
        options.thresholdDb = Number(next());
        break;
      case '--min-silence':
        options.minSilenceDuration = Number(next());
        break;
      case '--min-song':
        options.minSongDuration = Number(next());
        break;
      case '--bitrate':
        options.mp3Bitrate = Number(next());
        break;
      case '--pre-roll':
        options.preRollSec = Number(next());
        break;
      case '--post-roll':
        options.postRollSec = Number(next());
        break;
      case '--lang': {
        const value = next();
        if (isTranscriptionLanguageCode(value)) {
          options.language = value;
        }
        break;
      }
      case '--start-index':
        options.trackStartIndex = Number(next());
        break;
      case '--no-transcribe':
        options.transcribe = false;
        break;
      case '--gemini-key':
        options.geminiKey = next();
        break;
      default:
        positional.push(arg);
    }
  }

  if (positional.length === 0) {
    printHelp();
    return null;
  }

  options.input = resolve(positional[0]);
  options.outDir = resolve(options.outDir);
  return options;
}

function sanitizeFileName(title: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  return cleaned || fallback;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  const fileSize = await getFileSize(options.input);

  const transcription = options.transcribe && options.geminiKey.trim()
    ? new Transcriber({
        audioModel: new GeminiModel({ apiKey: options.geminiKey.trim() }),
        textModel: new GeminiModel({ apiKey: options.geminiKey.trim() }),
        musicBrainz: new MusicBrainzClient(),
        getLanguage: () => options.language
      })
    : null;

  if (options.transcribe && !transcription) {
    console.warn('No Gemini API key provided; tracks will be sliced but titles stay generic.');
  }

  let lastProgress = -1;
  const observer: SlicerObserver = {
    onState: state => {
      if (state.status === 'slicing' && state.progress !== lastProgress && state.progress % 5 === 0) {
        lastProgress = state.progress;
        process.stderr.write(`\rSlicing ${state.progress}% (${formatTime(state.currentTime)})`);
      }
    },
    onTrackAdded: track => {
      process.stderr.write(`\n  Track ${track.id} detected at ${formatTime(track.startTime)}\n`);
    },
    onSegmentUpdated: segment => {
      if (segment.status === 'done' && segment.text) {
        process.stderr.write(`  Gap ${segment.id} transcribed: "${segment.text}"\n`);
      }
    }
  };

  const slicer = new Slicer({
    encoderFactory: () => new LameMp3Encoder(),
    transcription,
    observer
  });
  slicer.parameters = {
    thresholdDb: options.thresholdDb,
    minSilenceDuration: options.minSilenceDuration,
    minSongDuration: options.minSongDuration,
    mp3Bitrate: options.mp3Bitrate,
    preRollSec: options.preRollSec,
    postRollSec: options.postRollSec
  };

  const result = await slicer.run(fileAudioInput(options.input), {
    fileName: basename(options.input),
    fileSizeBytes: fileSize,
    trackStartIndex: options.trackStartIndex,
    transcribeSpeechGaps: options.transcribe
  });
  process.stderr.write('\n');

  await ensureDir(options.outDir);

  const manifestTracks = [];
  for (const track of result.tracks) {
    if (!track.mp3Bytes || track.status !== 'done') {
      continue;
    }
    const fileName = `${sanitizeFileName(track.title, `Track ${track.id}`)}.mp3`;
    await writeBytes(join(options.outDir, fileName), track.mp3Bytes);
    manifestTracks.push({
      id: track.id,
      title: track.title,
      titleSource: track.titleSource,
      startTimeSeconds: track.startTime,
      endTimeSeconds: track.endTime,
      durationSeconds: track.duration,
      file: fileName,
      transcription: track.transcription
    });
    console.log(`Wrote ${fileName} (${formatTime(track.duration)})`);
  }

  const manifest = {
    source: basename(options.input),
    generatedAt: new Date().toISOString(),
    parameters: slicer.parameters,
    language: options.language,
    tracks: manifestTracks,
    segments: result.segments.map(s => ({
      id: s.id,
      startTimeSeconds: s.startTime,
      endTimeSeconds: s.endTime,
      durationSeconds: s.duration,
      status: s.status,
      text: s.text
    }))
  };

  await writeBytes(join(options.outDir, 'manifest.json'), new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  console.log(`\nDone: ${manifestTracks.length} track(s) + manifest.json in ${options.outDir}`);
}

main().catch(error => {
  console.error('audio-cli failed:', error);
  process.exitCode = 1;
});