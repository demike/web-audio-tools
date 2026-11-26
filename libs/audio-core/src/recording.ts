/**
 * A Recording is one continuous stretch of audio made up of one or more
 * Chunks (WAV files) — e.g. a recorder that splits at 2 GB into a new file
 * and folder. This module validates that every chunk shares one format, then
 * joins the chunks into a single AudioInput so the Slicer's timeline (tracks,
 * silence gaps, pre/post-roll) runs seamlessly across chunk boundaries.
 *
 * Platform-agnostic: chunks are opened through an injected `open` seam
 * (browser: File.stream(); Node/Bun: fs read stream).
 */
import type { AudioInput } from './ports';
import { MAX_WAV_HEADER_BYTES, parseWavHeader, type WavHeader } from './wav';

/** One WAV file of a Recording. `open` must yield a fresh stream on each call. */
export interface RecordingChunk {
  /** Display name, typically the file name. */
  name: string;
  /** Total file size in bytes, when known (used for progress estimates). */
  sizeBytes?: number;
  open(): AudioInput | Promise<AudioInput>;
  /**
   * Optional byte-range open (browser: File.slice(...).stream(); Node:
   * createReadStream with start/end). Lets the region reader jump straight to a
   * Track's samples without streaming the preceding gigabytes. Offsets are
   * absolute file bytes. When absent, the reader opens the full stream and skips.
   */
  openRange?(startByte: number, endByte: number): AudioInput | Promise<AudioInput>;
}

export interface RecordingInput {
  /** The joined byte stream to feed to Slicer.run. */
  input: AudioInput;
  /** The shared format of every chunk (taken from the first). */
  header: WavHeader;
  /** Sum of all chunk sizes, when every chunk reports one. */
  totalSizeBytes?: number;
  /** Index of the chunk currently being streamed; advances as input is consumed. */
  currentChunkIndex: number;
  /** PCM data bytes consumed per chunk; fills as input is consumed. */
  chunkDataBytes: number[];
}

/**
 * Validates every chunk header up front (fail fast, naming the offending
 * chunks) and returns the joined stream. The Slicer's parser expects exactly
 * one RIFF header at the start of the stream, so the joined stream emits the
 * first chunk's header followed by pure PCM data from every chunk.
 */
export async function createRecordingInput(chunks: RecordingChunk[]): Promise<RecordingInput> {
  if (chunks.length === 0) {
    throw new Error('A Recording needs at least one Chunk.');
  }

  const headers: WavHeader[] = [];
  const headerPrefixes: Uint8Array[] = [];
  for (const chunk of chunks) {
    const { header, prefix } = await readChunkHeader(chunk);
    if (headers.length > 0) {
      assertSameFormat(chunks[0].name, chunk.name, headers[0], header);
    }
    headers.push(header);
    headerPrefixes.push(prefix);
  }

  const header = headers[0];
  const totalSizeBytes = chunks.every(chunk => typeof chunk.sizeBytes === 'number')
    ? chunks.reduce((sum, chunk) => sum + (chunk.sizeBytes ?? 0), 0)
    : undefined;

  const recording: RecordingInput = {
    input: joinChunks(),
    header,
    totalSizeBytes,
    currentChunkIndex: 0,
    chunkDataBytes: chunks.map(() => 0)
  };
  return recording;

  async function* joinChunks(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < chunks.length; i++) {
      recording.currentChunkIndex = i;
      if (i === 0) {
        yield headerPrefixes[0].subarray(0, header.dataOffset);
      }
      // Skip this chunk's own header; everything after it is PCM data.
      const skip = headers[i].dataOffset;
      let skipped = 0;
      for await (const bytes of await chunks[i].open()) {
        let piece = bytes;
        if (skipped < skip) {
          const take = Math.min(skip - skipped, piece.length);
          skipped += take;
          piece = piece.subarray(take);
          if (piece.length === 0) {
            continue;
          }
        }
        recording.chunkDataBytes[i] += piece.length;
        yield piece;
      }
    }
  }
}

/**
 * Start time of each chunk on the continuous timeline, derived from the PCM
 * bytes actually consumed (not the header's 32-bit dataSize, which wraps at
 * 2 GB). Meaningful once the stream has been fully consumed.
 */
export function chunkStartTimesSec(recording: RecordingInput): number[] {
  const bytesPerSecond = recording.header.sampleRate * recording.header.channels * (recording.header.bitsPerSample / 8);
  const starts: number[] = [];
  let bytes = 0;
  for (const dataBytes of recording.chunkDataBytes) {
    starts.push(bytesPerSecond > 0 ? bytes / bytesPerSecond : 0);
    bytes += dataBytes;
  }
  return starts;
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Orders names digit-run-aware: ZOOM0002 sorts before ZOOM0010. */
export function compareNaturally(a: string, b: string): number {
  return naturalCollator.compare(a, b);
}

/** Reads just enough of a chunk to parse its header; returns the buffered prefix. */
export async function readChunkHeader(chunk: RecordingChunk): Promise<{ header: WavHeader; prefix: Uint8Array<ArrayBuffer> }> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const bytes of await chunk.open()) {
    parts.push(bytes);
    total += bytes.length;
    const prefix = concatParts(parts, total);
    const header = parseWavHeader(prefix.buffer.slice(prefix.byteOffset, prefix.byteOffset + prefix.length));
    if (header) {
      return { header, prefix };
    }
    if (total >= MAX_WAV_HEADER_BYTES) {
      break;
    }
  }
  throw new Error(`Chunk "${chunk.name}" is not a readable WAV file (no RIFF header with fmt and data chunks found).`);
}

function assertSameFormat(firstName: string, name: string, first: WavHeader, other: WavHeader): void {
  const fields: Array<[string, number, number]> = [
    ['sample rate', first.sampleRate, other.sampleRate],
    ['channel count', first.channels, other.channels],
    ['bit depth', first.bitsPerSample, other.bitsPerSample],
    ['audio format', first.audioFormat, other.audioFormat]
  ];
  for (const [label, expected, actual] of fields) {
    if (expected !== actual) {
      throw new Error(
        `Chunk "${name}" does not match "${firstName}": ${label} is ${actual}, expected ${expected}. ` +
        'All chunks of a Recording must share the same format.'
      );
    }
  }
}

function concatParts(parts: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}