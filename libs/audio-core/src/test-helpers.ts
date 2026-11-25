/** Pure signal-generation helpers shared by the core tests. */
import { createWavBytes } from './wav';

export const SAMPLE_RATE = 44100;

export function silence(seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate));
}

export function tone(seconds: number, amp: number, freq = 440, sampleRate = SAMPLE_RATE): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return out;
}

export function fade(seconds: number, from: number, to: number, freq = 440, sampleRate = SAMPLE_RATE): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (from + (to - from) * (i / n)) * Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function wavBytes(channels: Float32Array[], sampleRate = SAMPLE_RATE): Uint8Array {
  return createWavBytes(channels, sampleRate);
}

export async function* chunksOf(bytes: Uint8Array, chunkSize = 4096): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += chunkSize) {
    yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
  }
}

export function peak(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > max) {
      max = magnitude;
    }
  }
  return max;
}