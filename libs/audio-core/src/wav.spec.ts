import { describe, expect, it } from 'vitest';
import {
  WavStreamParser,
  calculateRms,
  parseWavHeader,
  prepareSpeechAudio,
  rmsToDb
} from './wav';
import { bytesToBase64 } from './transcription/prompts';
import { SAMPLE_RATE, concat, peak, silence, tone, wavBytes } from './test-helpers';

describe('calculateRms / rmsToDb', () => {
  it('returns 0 for silence and ~0.707 for a full-scale sine', () => {
    expect(calculateRms(silence(0.1))).toBe(0);
    expect(calculateRms(tone(0.1, 1))).toBeCloseTo(0.707, 2);
  });

  it('converts RMS to dB', () => {
    expect(rmsToDb(1)).toBeCloseTo(0);
    expect(rmsToDb(0.1)).toBeCloseTo(-20);
    expect(rmsToDb(0)).toBe(-100);
  });
});

describe('createWavBytes / parseWavHeader', () => {
  it('writes a parseable 16-bit PCM header', () => {
    const bytes = wavBytes([tone(0.5, 0.5), tone(0.5, 0.5)]);
    const header = parseWavHeader(bytes.buffer.slice(0, 64));
    expect(header).not.toBeNull();
    expect(header?.sampleRate).toBe(SAMPLE_RATE);
    expect(header?.channels).toBe(2);
    expect(header?.bitsPerSample).toBe(16);
    expect(header?.audioFormat).toBe(1);
  });

  it('rejects non-WAV data', () => {
    const garbage = new Uint8Array(64).fill(7);
    expect(parseWavHeader(garbage.buffer)).toBeNull();
  });
});

describe('WavStreamParser', () => {
  it('reassembles samples across arbitrary chunk boundaries', () => {
    const left = tone(0.25, 0.4, 300);
    const right = tone(0.25, 0.4, 600);
    const bytes = wavBytes([left, right]);
    const parser = new WavStreamParser();

    const collected: Float32Array[] = [];
    // Feed in odd-sized chunks to stress boundary handling.
    for (let i = 0; i < bytes.length; i += 997) {
      const parsed = parser.feed(bytes.subarray(i, Math.min(i + 997, bytes.length)));
      if (parsed) {
        collected.push(...parsed[0]);
      }
    }
    const flushed = parser.flush();
    if (flushed) {
      collected.push(...flushed[0]);
    }

    expect(collected.length).toBe(left.length);
    for (let i = 0; i < left.length; i += 500) {
      expect(collected[i]).toBeCloseTo(left[i], 4);
    }
  });
});

describe('prepareSpeechAudio', () => {
  it('returns null for pure silence', () => {
    expect(prepareSpeechAudio([silence(5), silence(5)], SAMPLE_RATE)).toBeNull();
  });

  it('detects quiet speech on the right channel, resamples and normalizes', () => {
    const left = silence(5);
    const right = concat(silence(2), tone(1, 0.005, 300), silence(2));
    const result = prepareSpeechAudio([left, right], SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(result?.sampleRate).toBe(16000);
    expect(result!.samples.length / 16000).toBeCloseTo(1.2, 1);
    expect(peak(result!.samples)).toBeCloseTo(0.707, 2);
  });

  it('compresses long internal pauses but keeps all speech', () => {
    const signal = concat(tone(10, 0.004), silence(120), tone(10, 0.004));
    const result = prepareSpeechAudio([signal], SAMPLE_RATE);
    expect(result).not.toBeNull();
    const duration = result!.samples.length / result!.sampleRate;
    expect(duration).toBeGreaterThan(19);
    expect(duration).toBeLessThan(22);
  });

  it('caps extremely long gaps', () => {
    const result = prepareSpeechAudio([tone(400, 0.004)], SAMPLE_RATE, { maxDurationSec: 60 });
    expect(result!.samples.length / result!.sampleRate).toBeCloseTo(60, 1);
  });

  it('never upsamples', () => {
    const result = prepareSpeechAudio([tone(3, 0.01, 300, 8000)], 8000);
    expect(result?.sampleRate).toBe(8000);
  });
});

describe('bytesToBase64', () => {
  it('matches known base64 vectors', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
    expect(bytesToBase64(new Uint8Array([0]))).toBe('AA==');
    expect(bytesToBase64(new Uint8Array([0, 0]))).toBe('AAA=');
    expect(bytesToBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(bytesToBase64(new TextEncoder().encode('hello world'))).toBe('aGVsbG8gd29ybGQ=');
  });
});