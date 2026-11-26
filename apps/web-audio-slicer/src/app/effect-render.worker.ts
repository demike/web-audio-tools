/**
 * Audition render worker: runs the shared core effect path off the main thread.
 * Receives the source Files (cloneable) plus the sliced Recording's format and
 * per-chunk byte counts, re-reads the Track region, and returns rendered WAV
 * bytes. Identical DSP to Export — what you audition is what you export.
 */
import {
  createRegionSource,
  renderRegionToWav,
  type EffectChainConfig,
  type RecordingChunk,
  type RecordingInput,
  type WavHeader
} from '@web-audio-tools/audio-core';

export interface AuditionRenderRequest {
  files: File[];
  header: WavHeader;
  chunkDataBytes: number[];
  startSec: number;
  endSec: number;
  config: EffectChainConfig;
  sourceChannels: number;
  sampleRate: number;
  maxDurationSec?: number;
}

const post = postMessage as unknown as (message: unknown, transfer?: Transferable[]) => void;

addEventListener('message', async (event: MessageEvent<AuditionRenderRequest>) => {
  const data = event.data;
  try {
    const chunks: RecordingChunk[] = data.files.map(file => ({
      name: file.name,
      sizeBytes: file.size,
      open: () => file.stream(),
      openRange: (startByte, endByte) => file.slice(startByte, endByte).stream()
    }));
    const recording = { header: data.header, chunkDataBytes: data.chunkDataBytes } as RecordingInput;
    const source = createRegionSource(chunks, recording, data.startSec, data.endSec);
    const result = await renderRegionToWav(source, {
      config: data.config,
      sampleRate: data.sampleRate,
      sourceChannels: data.sourceChannels,
      maxDurationSec: data.maxDurationSec
    });
    post({ ok: true, wavBytes: result.wavBytes, durationSec: result.durationSec, channels: result.channels }, [result.wavBytes.buffer]);
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});