import { describe, expect, it } from 'vitest';
import { LameMp3Encoder, floatTo16BitPCM } from './mp3';
import { tone } from './test-helpers';

describe('floatTo16BitPCM', () => {
  it('converts and clamps float samples to int16', () => {
    const input = new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]);
    const out = floatTo16BitPCM(input);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767);
    expect(out[2]).toBe(-32768);
    expect(out[5]).toBe(32767);
    expect(out[6]).toBe(-32768);
  });
});

describe('LameMp3Encoder', () => {
  it('encodes mono audio to MP3 frames', async () => {
    const encoder = new LameMp3Encoder();
    await encoder.start(1, 44100, 128);
    for (let i = 0; i < 20; i++) {
      await encoder.encode([tone(0.05, 0.5)]);
    }
    const bytes = await encoder.finish();
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xe0).toBe(0xe0);
  });

  it('encodes stereo audio', async () => {
    const encoder = new LameMp3Encoder();
    await encoder.start(2, 44100, 192);
    for (let i = 0; i < 20; i++) {
      await encoder.encode([tone(0.05, 0.5, 440), tone(0.05, 0.5, 660)]);
    }
    const bytes = await encoder.finish();
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff);
  });

  it('throws when encoding before start', async () => {
    const encoder = new LameMp3Encoder();
    await expect(encoder.encode([tone(0.05, 0.5)])).rejects.toThrow();
  });
});