/**
 * On-demand region reading: re-reads a Track's time range from the source
 * Chunks without loading the whole Recording. Used by both Audition and Export
 * (the single shared path). Requires the Recording to have been fully sliced
 * first, so per-chunk PCM byte counts (and thus chunk start times) are known.
 *
 * When a Chunk offers `openRange` (browser File.slice / Node seek stream) the
 * reader jumps straight to the region's bytes; otherwise it opens the full
 * stream and skips. Either way memory stays bounded to stream blocks.
 */
import type { AudioInput } from './ports';
import { chunkStartTimesSec, readChunkHeader, type RecordingChunk, type RecordingInput } from './recording';
import { decodeWavPcm, type WavHeader } from './wav';

/** A re-readable source of decoded PCM blocks for one Track region. */
export type RegionSource = () => AsyncIterable<Float32Array[]>;

export function createRegionSource(
  chunks: RecordingChunk[],
  recording: RecordingInput,
  startSec: number,
  endSec: number
): RegionSource {
  const header = recording.header;
  const rate = header.sampleRate;
  const frameBytes = header.channels * (header.bitsPerSample / 8);
  const starts = chunkStartTimesSec(recording);

  interface Span { index: number; startSample: number; endSample: number; }
  const spans: Span[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkStart = starts[i];
    const chunkSamples = Math.floor(recording.chunkDataBytes[i] / frameBytes);
    const chunkEnd = chunkStart + chunkSamples / rate;
    const from = Math.max(startSec, chunkStart);
    const to = Math.min(endSec, chunkEnd);
    if (to <= from) {
      continue;
    }
    const startSample = Math.max(0, Math.round((from - chunkStart) * rate));
    const endSample = Math.min(chunkSamples, Math.round((to - chunkStart) * rate));
    if (endSample > startSample) {
      spans.push({ index: i, startSample, endSample });
    }
  }

  return () => readSpans();

  async function* readSpans(): AsyncGenerator<Float32Array[]> {
    for (const span of spans) {
      const chunk = chunks[span.index];
      const { header: chunkHeader } = await readChunkHeader(chunk);
      yield* readChunkSamples(chunk, chunkHeader, span.startSample, span.endSample);
    }
  }
}

async function* readChunkSamples(
  chunk: RecordingChunk,
  header: WavHeader,
  startSample: number,
  endSample: number
): AsyncGenerator<Float32Array[]> {
  const frameBytes = header.channels * (header.bitsPerSample / 8);
  const wanted = endSample - startSample;
  if (chunk.openRange) {
    const byteStart = header.dataOffset + startSample * frameBytes;
    const byteEnd = header.dataOffset + endSample * frameBytes;
    const stream = await chunk.openRange(byteStart, byteEnd);
    yield* decodeStream(stream, header, wanted, 0);
  } else {
    const stream = await chunk.open();
    const skipBytes = header.dataOffset + startSample * frameBytes;
    yield* decodeStream(stream, header, wanted, skipBytes);
  }
}

async function* decodeStream(
  stream: AudioInput,
  header: WavHeader,
  maxSamples: number,
  skipBytes: number
): AsyncGenerator<Float32Array[]> {
  const frameBytes = header.channels * (header.bitsPerSample / 8);
  let skipped = 0;
  let emitted = 0;
  let leftover: Uint8Array = new Uint8Array(0);

  for await (const piece of stream) {
    let bytes = piece;
    if (skipped < skipBytes) {
      const take = Math.min(skipBytes - skipped, bytes.length);
      skipped += take;
      bytes = bytes.subarray(take);
      if (bytes.length === 0) {
        continue;
      }
    }

    const combined = leftover.length > 0 ? concatBytes(leftover, bytes) : bytes;
    const completeFrames = Math.floor(combined.length / frameBytes);
    const frames = Math.min(completeFrames, maxSamples - emitted);
    if (frames <= 0) {
      leftover = combined;
      if (emitted >= maxSamples) {
        return;
      }
      continue;
    }
    const byteCount = frames * frameBytes;
    yield decodeWavPcm(combined.subarray(0, byteCount), header);
    emitted += frames;
    leftover = combined.subarray(byteCount);
    if (emitted >= maxSamples) {
      return;
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}