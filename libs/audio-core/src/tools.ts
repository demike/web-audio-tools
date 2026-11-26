/**
 * Portable tool layer over the core. The same tool definitions can be registered
 * with WebMCP in the browser or exposed by a Node/Bun MCP server.
 *
 * Transcription is done by the CALLING MODEL: `slice_wav` runs with no embedded
 * provider, leaving prepared speech audio on each gap. The model fetches a gap's
 * audio (`get_gap_audio`), transcribes it itself, and writes the result back with
 * `set_track_title` (optionally canonicalized against MusicBrainz).
 */
import type { AudioInput, TranscriptionPort } from './ports';
import { MusicBrainzClient } from './transcription/musicbrainz';
import { bytesToBase64, normalizeTitle } from './transcription/prompts';
import type { SilenceSegment, SliceOptions, SliceResult, SlicerState, TitleSource, Track } from './types';

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
}

export interface ToolDefinition<Params = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (params: Params) => Promise<ToolResponse>;
}

/** The subset of the slicer the tool layer needs. The core Slicer satisfies it. */
export interface SlicerToolTarget {
  transcription: TranscriptionPort | null;
  run(input: AudioInput, options?: SliceOptions): Promise<SliceResult>;
  getTracksValue(): Track[];
  getSegmentsValue(): SilenceSegment[];
  getStateValue(): SlicerState;
  updateTrackTitle(trackId: number, title: string, titleSource?: TitleSource): void;
  removeTrackById(trackId: number): void;
  applyExportResult(trackKey: number, mp3Bytes: Uint8Array | null, processedDurationSec?: number): void;
}

export interface SlicerToolHost {
  slicer: SlicerToolTarget;
  /** Resolves a source reference (file path, loaded-file key, URL) to a byte stream. */
  resolveInput(source: string): Promise<AudioInput>;
  /** Optional total size for progress estimation. */
  fileSize?(source: string): Promise<number | undefined>;
  musicBrainz?: MusicBrainzClient;
  /**
   * Optional on-demand Export: process a detected Track to MP3 through the
   * shared effect path. When absent, export_tracks returns only Tracks that
   * were already encoded by the host.
   */
  exportTrack?(track: Track): Promise<{ mp3Bytes: Uint8Array; durationSec: number } | null>;
}

function json(value: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function text(message: string): ToolResponse {
  return { content: [{ type: 'text', text: message }] };
}

function summarizeTrack(track: Track): Record<string, unknown> {
  return {
    id: track.id,
    key: track.key,
    title: track.title,
    titleSource: track.titleSource,
    startTimeSeconds: round2(track.startTime),
    endTimeSeconds: round2(track.endTime),
    durationSeconds: round2(track.duration),
    status: track.status,
    hasMp3: track.mp3Bytes !== null,
    transcription: track.transcription
  };
}

function summarizeSegment(segment: SilenceSegment): Record<string, unknown> {
  return {
    id: segment.id,
    startTimeSeconds: round2(segment.startTime),
    endTimeSeconds: round2(segment.endTime),
    durationSeconds: round2(segment.duration),
    status: segment.status,
    transcriptionText: segment.text,
    hasSpeechAudio: Boolean(segment.speechWav)
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createSlicerTools(host: SlicerToolHost): ToolDefinition[] {
  const musicBrainz = host.musicBrainz ?? new MusicBrainzClient();

  return [
    {
      name: 'get_slicer_state',
      description: 'Retrieve the current slicing state: status, progress, current time, estimated duration, and dB level.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => json(host.slicer.getStateValue())
    },
    {
      name: 'get_tracks',
      description: 'List detected tracks with titles, timings, encoding status, and any transcription.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => json(host.slicer.getTracksValue().map(summarizeTrack))
    },
    {
      name: 'get_silence_segments',
      description: 'List speech gaps detected before pieces, with timings and transcription status. Use get_gap_audio to fetch a gap\'s audio for transcription.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => json(host.slicer.getSegmentsValue().map(summarizeSegment))
    },
    {
      name: 'get_gap_audio',
      description: 'Fetch the prepared speech audio (base64 WAV, mono 16 kHz) for a gap so you can transcribe it yourself. Returns speechWavBase64 and sampleRate.',
      inputSchema: {
        type: 'object',
        properties: {
          segmentId: { type: 'number', description: 'The gap/segment id from get_silence_segments' }
        },
        required: ['segmentId']
      },
      execute: async (params: Record<string, unknown>) => {
        const { segmentId } = params as { segmentId: number };
        const segment = host.slicer.getSegmentsValue().find(s => s.id === segmentId);
        if (!segment || !segment.speechWav) {
          return text(`No prepared speech audio for segment ${segmentId}.`);
        }
        return json({
          segmentId: segment.id,
          sampleRate: segment.speechSampleRate ?? 16000,
          speechWavBase64: bytesToBase64(segment.speechWav)
        });
      }
    },
    {
      name: 'slice_wav',
      description: 'Slice a WAV into tracks and detect speech gaps. Does NOT transcribe: fetch gap audio with get_gap_audio, transcribe it yourself, then name tracks with set_track_title.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'A source reference the host can resolve (file path, loaded-file key, or URL).' },
          trackStartIndex: { type: 'number', description: 'Starting track number (default 1).' },
          fileName: { type: 'string', description: 'Optional display name for the source.' }
        },
        required: ['source']
      },
      execute: async (params: Record<string, unknown>) => {
        const { source, trackStartIndex, fileName } = params as { source: string; trackStartIndex?: number; fileName?: string };
        // Tool mode: the calling model transcribes, so disable embedded providers.
        host.slicer.transcription = null;
        const input = await host.resolveInput(source);
        const fileSizeBytes = host.fileSize ? await host.fileSize(source) : undefined;
        const result = await host.slicer.run(input, {
          transcribeSpeechGaps: true,
          trackStartIndex,
          fileName: fileName ?? source,
          fileSizeBytes
        });
        return json({
          tracks: result.tracks.map(summarizeTrack),
          segments: result.segments.map(summarizeSegment)
        });
      }
    },
    {
      name: 'set_track_title',
      description: 'Set a track title from your transcription. Optionally verify/canonicalize it against MusicBrainz (works first, then recordings).',
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'number', description: 'The track id from get_tracks' },
          title: { type: 'string', description: 'The title you extracted, e.g. "Composer - Piece Title".' },
          verifyWithMusicBrainz: { type: 'boolean', description: 'When true, attempt MusicBrainz canonicalization (default false).' }
        },
        required: ['trackId', 'title']
      },
      execute: async (params: Record<string, unknown>) => {
        const { trackId, title, verifyWithMusicBrainz } = params as { trackId: number; title: string; verifyWithMusicBrainz?: boolean };
        const track = host.slicer.getTracksValue().find(t => t.id === trackId);
        if (!track) {
          return text(`Track ${trackId} not found.`);
        }

        let finalTitle = normalizeTitle(title);
        let source: 'manual' | 'metadata' = 'manual';
        if (verifyWithMusicBrainz && finalTitle) {
          const verified = await musicBrainz.findTitle(finalTitle);
          if (verified) {
            finalTitle = verified;
            source = 'metadata';
          }
        }

        host.slicer.updateTrackTitle(trackId, finalTitle, source);
        return text(`Track ${trackId} title set to "${finalTitle}" (${source}).`);
      }
    },
    {
      name: 'remove_track',
      description: 'Remove an unwanted track (e.g. a misdetected region or a part you do not want) from the results.',
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'number', description: 'The track id from get_tracks' }
        },
        required: ['trackId']
      },
      execute: async (params: Record<string, unknown>) => {
        const { trackId } = params as { trackId: number };
        const track = host.slicer.getTracksValue().find(t => t.id === trackId);
        if (!track) {
          return text(`Track ${trackId} not found.`);
        }
        host.slicer.removeTrackById(trackId);
        return text(`Track ${trackId} ("${track.title}") removed.`);
      }
    },
    {
      name: 'export_tracks',
      description: 'Export tracks to MP3 (on-demand processing through the selected effect path) and return them as base64, with titles and timings.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const tracks = host.slicer.getTracksValue();
        if (host.exportTrack) {
          for (const track of tracks) {
            if (!track.mp3Bytes) {
              const result = await host.exportTrack(track);
              if (result) {
                host.slicer.applyExportResult(track.key, result.mp3Bytes, result.durationSec);
              }
            }
          }
        }
        return json(
          tracks
            .filter(t => t.mp3Bytes !== null)
            .map(t => ({
              id: t.id,
              title: t.title,
              durationSeconds: round2(t.processedDuration ?? t.duration),
              mp3Base64: bytesToBase64(t.mp3Bytes as Uint8Array)
            }))
        );
      }
    }
  ];
}