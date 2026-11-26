/**
 * The single shared processing path for Audition and Export. A Track region is
 * read on demand, analyzed (peak + noise profile), then streamed through the
 * fixed-order effect chain — including the reverb tail — with bounded memory.
 * `exportRegionToMp3` (Export) and `renderRegionToWav` (Audition) are the only
 * two sinks; both run the identical `processRegion` generator, so what you
 * audition is exactly what you export, on every platform.
 */
import {
  NoiseProfiler,
  createEffectChain,
  isDryConfig,
  type ChainAnalysis,
  type EffectChainConfig
} from './effects';
import type { Mp3EncoderFactory, Scheduler } from './ports';
import type { RegionSource } from './region';
import { createWavBytes } from './wav';

export interface ProcessOptions {
  config: EffectChainConfig;
  sampleRate: number;
  sourceChannels: number;
  /** Hard cap on total processed duration (including tail), e.g. next Track start. */
  maxDurationSec?: number;
  /** Reverb tail decay cutoff in dBFS. Defaults to -60. */
  tailCutoffDb?: number;
  /** Maximum tail length in seconds. Defaults to 6. */
  maxTailSec?: number;
  scheduler?: Scheduler;
  onProgress?: (processedSec: number) => void;
}

const defaultScheduler: Scheduler = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  yield: () => new Promise<void>(resolve => setTimeout(resolve, 0))
};

/** MP3 keeps mono or stereo; >2 channels are downmixed to mono (as slicing did). */
export function exportChannelCount(sourceChannels: number): number {
  if (sourceChannels <= 1) {
    return 1;
  }
  return sourceChannels === 2 ? 2 : 1;
}

export function downmixForExport(channels: Float32Array[]): Float32Array[] {
  if (channels.length <= 2) {
    return channels;
  }
  const n = channels[0]?.length ?? 0;
  const mono = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      mono[i] += ch[i];
    }
  }
  for (let i = 0; i < n; i++) {
    mono[i] /= channels.length;
  }
  return [mono];
}

async function analyzeRegion(source: RegionSource, opts: ProcessOptions): Promise<ChainAnalysis> {
  const needProfile = opts.config.noiseReduction.enabled;
  const profiler = needProfile ? new NoiseProfiler() : null;
  let peak = 0;
  for await (const block of source()) {
    const dm = downmixForExport(block);
    for (const ch of dm) {
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) {
          peak = a;
        }
      }
    }
    if (profiler && dm[0]) {
      profiler.feed(dm[0]);
    }
  }
  return { peak, noiseProfile: profiler ? profiler.profile() : null };
}

/**
 * Streams a Track region through the effect chain, yielding processed blocks
 * (including the ring-out tail). Re-reads the region for analysis when needed.
 */
export async function* processRegion(
  source: RegionSource,
  opts: ProcessOptions
): AsyncGenerator<Float32Array[]> {
  const scheduler = opts.scheduler ?? defaultScheduler;
  const channels = exportChannelCount(opts.sourceChannels);
  const rate = opts.sampleRate;
  const tailCutoffDb = opts.tailCutoffDb ?? -60;
  const maxTailSec = opts.maxTailSec ?? 6;
  const maxSamples = opts.maxDurationSec !== undefined
    ? Math.round(opts.maxDurationSec * rate)
    : Number.POSITIVE_INFINITY;

  let analysis: ChainAnalysis = { peak: 0, noiseProfile: null };
  if (!isDryConfig(opts.config) && (opts.config.noiseReduction.enabled || opts.config.normalize.enabled)) {
    analysis = await analyzeRegion(source, opts);
  }
  const chain = createEffectChain(opts.config, rate, channels, analysis);

  let emitted = 0;
  let blocksSinceYield = 0;
  let lastYield = scheduler.now();

  const report = (): void => opts.onProgress?.(emitted / rate);

  for await (const block of source()) {
    const out = chain.process(downmixForExport(block));
    const len = out[0]?.length ?? 0;
    if (emitted + len > maxSamples) {
      const take = Math.max(0, maxSamples - emitted);
      if (take <= 0) {
        return;
      }
      yield out.map(ch => ch.subarray(0, take));
      emitted += take;
      report();
      return;
    }
    yield out;
    emitted += len;
    report();
    blocksSinceYield++;
    if (blocksSinceYield >= 16 || scheduler.now() - lastYield >= 8) {
      await scheduler.yield();
      lastYield = scheduler.now();
      blocksSinceYield = 0;
    }
  }

  const remainingTail = Math.min(Math.round(maxTailSec * rate), maxSamples - emitted);
  if (remainingTail > 0) {
    for (const out of chain.flush(remainingTail, tailCutoffDb)) {
      yield out;
      emitted += out[0]?.length ?? 0;
      report();
      await scheduler.yield();
    }
  }
}

export interface ExportResult {
  mp3Bytes: Uint8Array;
  /** Actual processed duration, including any ring-out tail. */
  durationSec: number;
}

/** Export sink: region → effect chain → MP3. Used by the CLI and browser Export. */
export async function exportRegionToMp3(
  source: RegionSource,
  opts: ProcessOptions,
  encoderFactory: Mp3EncoderFactory,
  bitrate: number
): Promise<ExportResult> {
  const channels = exportChannelCount(opts.sourceChannels);
  const encoder = encoderFactory();
  await encoder.start(channels, opts.sampleRate, bitrate);
  let samples = 0;
  try {
    for await (const block of processRegion(source, opts)) {
      await encoder.encode(block);
      samples += block[0]?.length ?? 0;
    }
    const mp3Bytes = await encoder.finish();
    return { mp3Bytes, durationSec: samples / opts.sampleRate };
  } catch (error) {
    encoder.abort();
    throw error;
  }
}

export interface RenderResult {
  wavBytes: Uint8Array;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

/** Audition sink: region → effect chain → 16-bit WAV bytes (one Track, bounded). */
export async function renderRegionToWav(source: RegionSource, opts: ProcessOptions): Promise<RenderResult> {
  const channels = exportChannelCount(opts.sourceChannels);
  const collected: Float32Array[][] = Array.from({ length: channels }, () => []);
  let samples = 0;
  for await (const block of processRegion(source, opts)) {
    for (let c = 0; c < channels; c++) {
      const copy = new Float32Array(block[c].length);
      copy.set(block[c]);
      collected[c].push(copy);
    }
    samples += block[0]?.length ?? 0;
  }
  const merged = collected.map(parts => {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  });
  return {
    wavBytes: createWavBytes(merged, opts.sampleRate),
    sampleRate: opts.sampleRate,
    channels,
    durationSec: samples / opts.sampleRate
  };
}