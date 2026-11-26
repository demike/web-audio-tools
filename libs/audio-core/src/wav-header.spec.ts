import { describe, expect, it } from 'vitest';
import { parseWavHeader, MAX_WAV_HEADER_BYTES } from './wav';
import { Slicer } from './slicer';

const SR = 44100;

function pcmBytes(seconds: number): Uint8Array {
  const n = Math.round(seconds * SR);
  const out = new Uint8Array(n * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const v = Math.round(0.5 * Math.sin(2 * Math.PI * 440 * i / SR) * 32767);
    view.setInt16(i * 4, v, true);
    view.setInt16(i * 4 + 2, v, true);
  }
  return out;
}

function canonical(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  v.setUint32(4, 36 + pcm.length, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  out.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36); // data
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function rf64(pcm: Uint8Array): Uint8Array {
  // RF64 + ds64 (28 bytes) + fmt(16) + data(0xFFFFFFFF) + pcm
  const headerLen = 12 + 8 + 28 + 8 + 16 + 8;
  const out = new Uint8Array(headerLen + pcm.length);
  const v = new DataView(out.buffer);
  out.set([0x52, 0x46, 0x36, 0x34], 0); // RF64
  v.setUint32(4, 0xffffffff, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  out.set([0x64, 0x73, 0x36, 0x34], 12); // ds64
  v.setUint32(16, 28, true);
  v.setBigUint64(20, BigInt(0xffffffff), true); // riffSize placeholder
  v.setBigUint64(28, BigInt(pcm.length), true); // dataSize (real)
  v.setBigUint64(36, BigInt(pcm.length / 4), true); // sampleCount
  v.setUint32(44, 0, true); // tableLength
  let o = 48;
  out.set([0x66, 0x6d, 0x74, 0x20], o); v.setUint32(o + 4, 16, true);
  v.setUint16(o + 8, 1, true); v.setUint16(o + 10, 2, true); v.setUint32(o + 12, SR, true);
  v.setUint32(o + 16, SR * 4, true); v.setUint16(o + 20, 4, true); v.setUint16(o + 22, 16, true);
  o += 24;
  out.set([0x64, 0x61, 0x74, 0x61], o); v.setUint32(o + 4, 0xffffffff, true);
  out.set(pcm, o + 8);
  return out;
}

function extensible(pcm: Uint8Array): Uint8Array {
  const fmtLen = 40;
  const headerLen = 12 + 8 + fmtLen + 8;
  const out = new Uint8Array(headerLen + pcm.length);
  const v = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  v.setUint32(4, headerLen - 8 + pcm.length, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  out.set([0x66, 0x6d, 0x74, 0x20], 12);
  v.setUint32(16, fmtLen, true);
  v.setUint16(20, 0xfffe, true); // EXTENSIBLE
  v.setUint16(22, 2, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  v.setUint16(36, 22, true); // cbSize
  v.setUint16(38, 16, true); // validBits
  v.setUint32(40, 3, true); // channelMask
  v.setUint16(44, 1, true); // SubFormat GUID first 2 bytes = PCM
  out.set([0x64, 0x61, 0x74, 0x61], 12 + 8 + fmtLen);
  v.setUint32(12 + 8 + fmtLen + 4, pcm.length, true);
  out.set(pcm, headerLen);
  return out;
}

async function* chunks(bytes: Uint8Array, size = 65536): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, Math.min(i + size, bytes.length));
  }
}

describe('parseWavHeader formats', () => {
  it('parses canonical RIFF PCM', () => {
    const h = parseWavHeader(canonical(pcmBytes(0.1)).buffer)!;
    expect(h.audioFormat).toBe(1);
    expect(h.dataOffset).toBe(44);
    expect(h.channels).toBe(2);
  });

  it('parses RF64 with a ds64 chunk (Zoom 2 GB splits)', () => {
    const pcm = pcmBytes(0.1);
    const h = parseWavHeader(rf64(pcm).buffer)!;
    expect(h).not.toBeNull();
    expect(h.audioFormat).toBe(1);
    expect(h.channels).toBe(2);
    expect(h.sampleRate).toBe(SR);
    expect(h.dataSize).toBe(pcm.length);
  });

  it('parses WAVE_FORMAT_EXTENSIBLE via the SubFormat GUID', () => {
    const h = parseWavHeader(extensible(pcmBytes(0.1)).buffer)!;
    expect(h.audioFormat).toBe(1);
    expect(h.bitsPerSample).toBe(16);
    expect(h.channels).toBe(2);
  });

  it('finds the data chunk past large metadata', () => {
    const base = canonical(pcmBytes(0.1));
    const metaSize = 100000;
    const out = new Uint8Array(base.length + 8 + metaSize);
    out.set(base.subarray(0, 12), 0);
    out.set([0x4c, 0x49, 0x53, 0x54], 12); // LIST
    new DataView(out.buffer).setUint32(16, metaSize, true);
    out.set(base.subarray(12), 20 + metaSize);
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    expect(MAX_WAV_HEADER_BYTES).toBeGreaterThan(metaSize);
    const h = parseWavHeader(out.buffer)!;
    expect(h).not.toBeNull();
    expect(h.dataOffset).toBe(44 + 8 + metaSize);
  });
});

describe('Slicer accepts real-world WAV variants', () => {
  it('slices an RF64 file', async () => {
    const bytes = rf64(pcmBytes(12));
    const result = await new Slicer({}).run(chunks(bytes), { fileSizeBytes: bytes.length });
    expect(result.tracks.length).toBeGreaterThanOrEqual(1);
  });

  it('slices a file with >64 KB of header metadata', async () => {
    const base = canonical(pcmBytes(12));
    const metaSize = 100000;
    const out = new Uint8Array(base.length + 8 + metaSize);
    out.set(base.subarray(0, 12), 0);
    out.set([0x4c, 0x49, 0x53, 0x54], 12);
    new DataView(out.buffer).setUint32(16, metaSize, true);
    out.set(base.subarray(12), 20 + metaSize);
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    const result = await new Slicer({}).run(chunks(out), { fileSizeBytes: out.length });
    expect(result.tracks.length).toBeGreaterThanOrEqual(1);
  });
});