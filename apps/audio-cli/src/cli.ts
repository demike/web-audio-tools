/**
 * Node/Bun CLI logic for the audio core. Slices a WAV into MP3 tracks,
 * optionally transcribes spoken announcements via Gemini, and writes a JSON
 * manifest. Kept side-effect-free so it can be unit tested; main.ts is the entry.
 *
 * Transcription outside the browser uses Gemini (the Prompt API is Chrome-only).
 * Set GEMINI_API_KEY or pass --gemini-key. Without a key, tracks are still
 * sliced and encoded, but titles stay generic.
 */
import { join, resolve } from 'node:path';
import {
  DEFAULT_SLICER_PARAMETERS,
  DRY_EFFECT_CONFIG,
  FACTORY_PRESETS,
  GeminiModel,
  LameMp3Encoder,
  MusicBrainzClient,
  Slicer,
  Transcriber,
  chunkStartTimesSec,
  createRecordingInput,
  createRegionSource,
  exportRegionToMp3,
  findFactoryPreset,
  isTranscriptionLanguageCode,
  parsePresetFile,
  type EffectChainConfig,
  type Preset,
  type SlicerObserver,
  type TranscriptionLanguageCode
} from '@web-audio-tools/audio-core';
import { ensureDir, expandInputPaths, pathRecordingChunk, readTextFile, writeBytes } from './node-adapters';

export interface CliOptions {
  /** Input files and/or directories, in the order given. */
  inputs: string[];
  /** Glob filter applied to files discovered inside directories (not to explicit files). */
  match: string;
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
  /** Factory Preset name or path to a Preset JSON file; '' means dry (no effects). */
  preset: string;
}

export function printHelp(): void {
  console.log(`Usage: audio-cli <input.wav|dir> [more inputs...] [options]

Multiple inputs form one Recording: their audio is joined into a single
timeline, so pieces spanning a file boundary stay one track. Directories
expand to their WAV files (natural-sorted by path, skipping TRASH/Export).

Options:
  --out <dir>            Output directory (default: ./tracks)
  --match <glob>         Filter files found in directories, e.g. '*_TrMic.WAV'
  --threshold <dB>       Silence threshold in dB (default: -45)
  --min-silence <sec>    Minimum silence to split (default: 2.0)
  --min-song <sec>       Minimum piece duration to keep (default: 8.0)
  --bitrate <kbps>       MP3 bitrate (default: 192)
  --pre-roll <sec>       Audio kept before each piece's attack (default: 0.3)
  --post-roll <sec>      Audio kept after each piece's decay (default: 0.5)
  --lang <code>          Transcription language: auto,en,de,es,fr,it,pt,nl,pl,ja (default: auto)
  --start-index <n>      Starting track number (default: 1)
  --no-transcribe        Skip speech transcription
  --preset <name|file>   Apply a Factory Preset (e.g. "Horn Ensemble", "Rock Band")
                         or a Preset JSON file at Export. Default: dry (no effects)
  --gemini-key <key>     Gemini API key (or set GEMINI_API_KEY)
  -h, --help             Show this help`);
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): CliOptions | null {
  const options: CliOptions = {
    inputs: [],
    match: '',
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
    geminiKey: env['GEMINI_API_KEY'] ?? '',
    preset: ''
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
      case '--match':
        options.match = next();
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
      case '--preset':
        options.preset = next();
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

  options.inputs = positional.map(path => resolve(path));
  options.outDir = resolve(options.outDir);
  return options;
}

export function sanitizeFileName(title: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  return cleaned || fallback;
}

/**
 * Resolves a --preset value to a Preset: a Factory Preset name, or a path to a
 * versioned Preset JSON file. Returns null for dry (empty value). Throws on an
 * unknown name or unreadable/invalid file.
 */
export async function resolvePreset(value: string): Promise<Preset | null> {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const factory = findFactoryPreset(trimmed);
  if (factory) {
    return factory;
  }
  if (trimmed.toLowerCase().endsWith('.json')) {
    const preset = parsePresetFile(await readTextFile(resolve(trimmed)));
    if (!preset) {
      throw new Error(`Preset file "${trimmed}" is not a valid versioned Preset document.`);
    }
    return preset;
  }
  const names = FACTORY_PRESETS.map(p => p.name).join(', ');
  throw new Error(`Unknown Preset "${trimmed}". Available Factory Presets: ${names}. Or pass a .json file path.`);
}

export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export async function runCli(argv: string[], env: Record<string, string | undefined> = {}): Promise<void> {
  const options = parseArgs(argv, env);
  if (!options) {
    return;
  }

  const paths = await expandInputPaths(options.inputs, options.match);
  const chunks = await Promise.all(paths.map(pathRecordingChunk));
  // Validates every chunk header up front: a format mismatch fails before
  // any slicing starts, naming the offending files.
  const recording = await createRecordingInput(chunks);
  const displayName = chunks.length === 1
    ? chunks[0].name
    : `${chunks[0].name} (+${chunks.length - 1} ${chunks.length === 2 ? 'chunk' : 'chunks'})`;

  if (chunks.length > 1) {
    process.stderr.write(`Recording: ${chunks.length} chunks\n`);
    chunks.forEach((chunk, index) => {
      const sizeMb = ((chunk.sizeBytes ?? 0) / 1024 / 1024).toFixed(1);
      process.stderr.write(`  ${index + 1}. ${chunk.name} (${sizeMb} MB)\n`);
    });
  }

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
        const chunkSuffix = chunks.length > 1
          ? ` [chunk ${recording.currentChunkIndex + 1}/${chunks.length}]`
          : '';
        process.stderr.write(`\rSlicing ${state.progress}% (${formatTime(state.currentTime)})${chunkSuffix}`);
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

  const preset = await resolvePreset(options.preset);
  const effectConfig: EffectChainConfig = preset ? preset.config : DRY_EFFECT_CONFIG;

  const slicer = new Slicer({
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

  const result = await slicer.run(recording.input, {
    fileName: displayName,
    fileSizeBytes: recording.totalSizeBytes,
    trackStartIndex: options.trackStartIndex,
    transcribeSpeechGaps: options.transcribe
  });
  process.stderr.write('\n');

  await ensureDir(options.outDir);

  const manifestTracks = [];
  const tracks = result.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const nextStart = i + 1 < tracks.length ? tracks[i + 1].startTime : undefined;
    const maxDurationSec = nextStart !== undefined ? nextStart - track.startTime : undefined;
    const source = createRegionSource(chunks, recording, track.startTime, track.endTime);
    slicer.setTrackStatus(track.key, 'encoding');
    const exported = await exportRegionToMp3(
      source,
      {
        config: effectConfig,
        sampleRate: recording.header.sampleRate,
        sourceChannels: recording.header.channels,
        maxDurationSec
      },
      () => new LameMp3Encoder(),
      options.mp3Bitrate
    );
    slicer.applyExportResult(track.key, exported.mp3Bytes, exported.durationSec);

    const fileName = `${sanitizeFileName(track.title, `Track ${track.id}`)}.mp3`;
    await writeBytes(join(options.outDir, fileName), exported.mp3Bytes);
    manifestTracks.push({
      id: track.id,
      title: track.title,
      titleSource: track.titleSource,
      startTimeSeconds: track.startTime,
      endTimeSeconds: track.endTime,
      durationSeconds: track.duration,
      processedDurationSeconds: exported.durationSec,
      file: fileName,
      transcription: track.transcription
    });
    console.log(`Wrote ${fileName} (${formatTime(exported.durationSec)})`);
  }

  const chunkStartTimeSec = chunkStartTimesSec(recording);
  const bytesPerSecond = recording.header.sampleRate * recording.header.channels * (recording.header.bitsPerSample / 8);
  const manifest = {
    source: displayName,
    generatedAt: new Date().toISOString(),
    parameters: slicer.parameters,
    preset: preset ? { name: preset.name, config: preset.config } : null,
    language: options.language,
    chunks: chunks.map((chunk, index) => ({
      file: chunk.name,
      sizeBytes: chunk.sizeBytes ?? null,
      startTimeSeconds: chunkStartTimeSec[index],
      durationSeconds: bytesPerSecond > 0 ? recording.chunkDataBytes[index] / bytesPerSecond : 0
    })),
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