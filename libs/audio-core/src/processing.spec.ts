import { describe, expect, it } from 'vitest';
import { createRecordingInput, type RecordingChunk } from './recording';
import { createRegionSource } from './region';
import { DRY_EFFECT_CONFIG, cloneEffectConfig } from './effects';
import { exportRegionToMp3, processRegion, renderRegionToWav } from './processing';
import { LameMp3Encoder } from './mp3';
import { SAMPLE_RATE, concat, peak, silence, tone, wavBytes } from './test-helpers';
import { parseWavHeader, decodeWavPcm } from './wav';

async function recordingFrom(channels: Float32Array[], extraChunks: Float32Array[][] = []) {
  const all = [channels, ...extraChunks];
  const chunks: RecordingChunk[] = all.map((ch, i) => {
    const bytes = wavBytes(ch);
    return { name: `c${i}.wav`, sizeBytes: bytes.length, open: () => chunksOf(bytes) };
  });
  const recording = await createRecordingInput(chunks);
  for await (const _ of recording.input) { void _; }
  return { chunks, recording };
}

async function collect(source: AsyncIterable<Float32Array[]>): Promise<Float32Array[]> {
  const parts: Float32Array[][] = [];
  for await (const block of source) {
    block.forEach((ch, c) => {
      (parts[c] ??= []).push(ch);
    });
  }
  return parts.map(chunks => {
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  });
}

describe('createRegionSource', () => {
  it('re-reads exactly the requested time region', async () => {
    const signal = concat(silence(1), tone(2, 0.5, 440), silence(1));
    const { chunks, recording } = await recordingFrom([signal, signal]);
    const source = createRegionSource(chunks, recording, 1.0, 3.0);
    const [left] = await collect(source());
    const expected = signal.subarray(SAMPLE_RATE, 3 * SAMPLE_RATE);
    expect(left.length).toBe(expected.length);
    let err = 0;
    for (let i = 0; i < expected.length; i += 13) {
      err += Math.abs(left[i] - expected[i]);
    }
    expect(err).toBeLessThan(1);
  });

  it('reads a region spanning two chunks', async () => {
    const a = tone(2, 0.4, 300);
    const b = tone(2, 0.4, 300);
    const { chunks, recording } = await recordingFrom([a, a], [[b, b]]);
    const source = createRegionSource(chunks, recording, 1.5, 2.5);
    const [left] = await collect(source());
    expect(left.length).toBe(SAMPLE_RATE);
    expect(peak(left)).toBeGreaterThan(0.3);
  });

  it('uses openRange when provided', async () => {
    const signal = concat(silence(1), tone(2, 0.5, 440), silence(1));
    const bytes = wavBytes([signal, signal]);
    const header = parseWavHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))!;
    let rangeUsed = false;
    const chunk: RecordingChunk = {
      name: 'r.wav',
      sizeBytes: bytes.length,
      open: () => chunksOf(bytes),
      openRange: (start, end) => {
        rangeUsed = true;
        return chunksOf(bytes.subarray(start, end));
      }
    };
    const recording = await createRecordingInput([chunk]);
    for await (const _ of recording.input) { void _; }
    const source = createRegionSource([chunk], recording, 1.0, 2.0);
    const [left] = await collect(source());
    expect(rangeUsed).toBe(true);
    expect(left.length).toBe(SAMPLE_RATE);
    void header;
  });
});

describe('processRegion / Export / Audition', () => {
  it('dry render reproduces the region audio', async () => {
    const signal = concat(silence(0.5), tone(1.5, 0.4, 440), silence(0.5));
    const { chunks, recording } = await recordingFrom([signal, signal]);
    const source = createRegionSource(chunks, recording, 0.5, 2.0);
    const result = await renderRegionToWav(source, {
      config: DRY_EFFECT_CONFIG,
      sampleRate: SAMPLE_RATE,
      sourceChannels: 2
    });
    expect(result.channels).toBe(2);
    const decoded = decodeWavPcm(
      result.wavBytes.subarray(44),
      { sampleRate: SAMPLE_RATE, channels: 2, bitsPerSample: 16, audioFormat: 1, dataOffset: 44, dataSize: result.wavBytes.length - 44 }
    );
    const expected = signal.subarray(Math.round(0.5 * SAMPLE_RATE), Math.round(2.0 * SAMPLE_RATE));
    expect(decoded[0].length).toBe(expected.length);
    expect(peak(decoded[0])).toBeGreaterThan(0.3);
  });

  it('reverb extends the processed duration past the slice end', async () => {
    const signal = concat(silence(0.2), tone(1.0, 0.5, 440), silence(0.2));
    const { chunks, recording } = await recordingFrom([signal, signal]);
    const source = createRegionSource(chunks, recording, 0.2, 1.2);
    const config = cloneEffectConfig(DRY_EFFECT_CONFIG);
    config.reverb = { enabled: true, roomSize: 0.85, damping: 0.2, wet: 0.6, dry: 0.5 };
    const blocks = await collect(processRegion(source, { config, sampleRate: SAMPLE_RATE, sourceChannels: 2 }));
    const processedSamples = blocks[0].length;
    expect(processedSamples).toBeGreaterThan(SAMPLE_RATE);
  });

  it('caps total duration at maxDurationSec', async () => {
    const signal = tone(3, 0.5, 440);
    const { chunks, recording } = await recordingFrom([signal, signal]);
    const source = createRegionSource(chunks, recording, 0, 3);
    const config = cloneEffectConfig(DRY_EFFECT_CONFIG);
    config.reverb = { enabled: true, roomSize: 0.9, damping: 0.1, wet: 0.7, dry: 0.5 };
    const blocks = await collect(processRegion(source, { config, sampleRate: SAMPLE_RATE, sourceChannels: 2, maxDurationSec: 1.5 }));
    expect(blocks[0].length).toBeLessThanOrEqual(Math.round(1.5 * SAMPLE_RATE));
  });

  it('exports a region to a valid MP3', async () => {
    const signal = concat(silence(0.3), tone(1.5, 0.5, 440), silence(0.3));
    const { chunks, recording } = await recordingFrom([signal, signal]);
    const source = createRegionSource(chunks, recording, 0.3, 1.8);
    const result = await exportRegionToMp3(
      source,
      { config: DRY_EFFECT_CONFIG, sampleRate: SAMPLE_RATE, sourceChannels: 2 },
      () => new LameMp3Encoder(),
      192
    );
    expect(result.mp3Bytes.length).toBeGreaterThan(100);
    expect(result.mp3Bytes[0]).toBe(0xff);
    expect(result.durationSec).toBeGreaterThan(1.4);
  });
});

async function* chunksOf(bytes: Uint8Array, size = 4096): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, Math.min(i + size, bytes.length));
  }
}