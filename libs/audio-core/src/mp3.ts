/**
 * Canonical MP3 encoder backed by lamejs (pure JS, runs in browser, Node, Bun).
 * This is the direct adapter used by the Node/Bun CLI. The browser app uses a
 * Web Worker adapter at the same seam to keep encoding off the main thread.
 *
 * lamejs is imported dynamically so bundlers tree-shake it out of contexts that
 * never instantiate this encoder (e.g. the browser, which uses the Worker).
 */
import type { Mp3EncoderPort } from './ports';

interface LameEncoderInstance {
  encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array;
  flush(): Uint8Array;
}

export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function copyBytes(input: Uint8Array): Uint8Array {
  return new Uint8Array(input);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export class LameMp3Encoder implements Mp3EncoderPort {
  private encoder: LameEncoderInstance | null = null;
  private chunks: Uint8Array[] = [];

  public async start(channels: number, sampleRate: number, bitrate: number): Promise<void> {
    const { Mp3Encoder } = await import('@breezystack/lamejs');
    this.encoder = new Mp3Encoder(channels, sampleRate, bitrate || 128);
    this.chunks = [];
  }

  public async encode(channels: Float32Array[]): Promise<void> {
    if (!this.encoder) {
      throw new Error('MP3 encoder not initialized');
    }

    const mp3buf = channels.length === 1
      ? this.encoder.encodeBuffer(floatTo16BitPCM(channels[0]))
      : this.encoder.encodeBuffer(floatTo16BitPCM(channels[0]), floatTo16BitPCM(channels[1]));

    if (mp3buf.length > 0) {
      this.chunks.push(copyBytes(mp3buf));
    }
  }

  public async finish(): Promise<Uint8Array> {
    if (!this.encoder) {
      throw new Error('MP3 encoder not initialized');
    }

    const mp3buf = this.encoder.flush();
    if (mp3buf.length > 0) {
      this.chunks.push(copyBytes(mp3buf));
    }

    const bytes = concatBytes(this.chunks);
    this.encoder = null;
    this.chunks = [];
    return bytes;
  }

  public abort(): void {
    this.encoder = null;
    this.chunks = [];
  }
}