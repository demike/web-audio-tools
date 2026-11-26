import { describe, expect, it } from 'vitest';
import {
  chunkStartTimesSec,
  compareNaturally,
  createRecordingInput,
  type RecordingChunk
} from './recording';
import { WavStreamParser } from './wav';
import { SAMPLE_RATE, chunksOf, concat, silence, tone, wavBytes } from './test-helpers';

function chunkOf(name: string, bytes: Uint8Array, sizeBytes?: number): RecordingChunk {
  return {
    name,
    sizeBytes: sizeBytes ?? bytes.length,
    open: () => chunksOf(bytes, 997)
  };
}

async function collectPcm(input: AsyncIterable<Uint8Array>): Promise<Float32Array> {
  const parser = new WavStreamParser();
  const collected: number[] = [];
  for await (const bytes of input) {
    const parsed = parser.feed(bytes);
    if (parsed) {
      collected.push(...parsed[0]);
    }
  }
  const flushed = parser.flush();
  if (flushed) {
    collected.push(...flushed[0]);
  }
  return Float32Array.from(collected);
}

describe('createRecordingInput', () => {
  it('rejects an empty Recording', async () => {
    await expect(createRecordingInput([])).rejects.toThrow('at least one Chunk');
  });

  it('passes a single chunk through unchanged', async () => {
    const bytes = wavBytes([tone(0.1, 0.5)]);
    const recording = await createRecordingInput([chunkOf('a.wav', bytes)]);

    const joined: number[] = [];
    for await (const piece of recording.input) {
      joined.push(...piece);
    }
    expect(Uint8Array.from(joined)).toEqual(bytes);
    expect(recording.totalSizeBytes).toBe(bytes.length);
    expect(recording.chunkDataBytes).toEqual([bytes.length - 44]);
  });

  it('joins chunks into one continuous PCM timeline', async () => {
    const left = tone(0.25, 0.4, 300);
    const right = concat(tone(0.25, 0.4, 600), silence(0.1));
    const recording = await createRecordingInput([
      chunkOf('part1.wav', wavBytes([left])),
      chunkOf('part2.wav', wavBytes([right]))
    ]);

    const pcm = await collectPcm(recording.input);
    const expected = concat(left, right);
    expect(pcm.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i += 500) {
      expect(pcm[i]).toBeCloseTo(expected[i], 4);
    }
  });

  it('tracks the current chunk and per-chunk data bytes while streaming', async () => {
    const left = tone(0.1, 0.4);
    const right = tone(0.2, 0.4);
    const recording = await createRecordingInput([
      chunkOf('part1.wav', wavBytes([left])),
      chunkOf('part2.wav', wavBytes([right]))
    ]);

    const seenIndexes: number[] = [];
    let totalBytes = 0;
    for await (const piece of recording.input) {
      seenIndexes.push(recording.currentChunkIndex);
      totalBytes += piece.length;
    }
    expect(seenIndexes[0]).toBe(0);
    expect(seenIndexes[seenIndexes.length - 1]).toBe(1);
    expect(totalBytes).toBe(44 + left.length * 2 + right.length * 2);
    expect(recording.chunkDataBytes).toEqual([left.length * 2, right.length * 2]);

    const starts = chunkStartTimesSec(recording);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(left.length / SAMPLE_RATE, 6);
  });

  it('skips metadata chunks before data in later chunks', async () => {
    // A WAV with an odd-sized LIST chunk between fmt and data, like the
    // BEXT/iXML metadata recorders embed.
    const pcm = tone(0.05, 0.5);
    const base = wavBytes([pcm]);
    const listPayload = new Uint8Array([1, 2, 3]); // odd size -> pad byte
    const withList = new Uint8Array(base.length + 8 + listPayload.length + 1);
    withList.set(base.subarray(0, 36), 0); // RIFF + fmt
    const view = new DataView(withList.buffer);
    const writeTag = (offset: number, tag: string) => {
      for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
    };
    writeTag(36, 'LIST');
    view.setUint32(40, listPayload.length, true);
    withList.set(listPayload, 44);
    withList.set(base.subarray(36), 48); // data chunk
    view.setUint32(4, withList.length - 8, true); // fix RIFF size

    const recording = await createRecordingInput([
      chunkOf('a.wav', wavBytes([pcm])),
      chunkOf('b.wav', withList)
    ]);
    const parsed = await collectPcm(recording.input);
    expect(parsed.length).toBe(pcm.length * 2);
    expect(recording.chunkDataBytes[1]).toBe(pcm.length * 2);
  });

  it('fails fast on a sample rate mismatch, naming both chunks', async () => {
    const a = wavBytes([tone(0.05, 0.5)], SAMPLE_RATE);
    const b = wavBytes([tone(0.05, 0.5)], 48000);
    await expect(createRecordingInput([chunkOf('a.wav', a), chunkOf('b.wav', b)]))
      .rejects.toThrow(/"b\.wav" does not match "a\.wav": sample rate is 48000, expected 44100/);
  });

  it('fails fast on channel and bit depth mismatches', async () => {
    const mono = wavBytes([tone(0.05, 0.5)]);
    const stereo = wavBytes([tone(0.05, 0.5), tone(0.05, 0.5)]);
    await expect(createRecordingInput([chunkOf('a.wav', mono), chunkOf('b.wav', stereo)]))
      .rejects.toThrow(/channel count/);
  });

  it('rejects a chunk that is not a WAV', async () => {
    const garbage = new Uint8Array(4096).fill(7);
    await expect(createRecordingInput([chunkOf('a.wav', wavBytes([tone(0.05, 0.5)])), chunkOf('b.wav', garbage)]))
      .rejects.toThrow(/"b\.wav" is not a readable WAV file/);
  });

  it('sums chunk sizes only when every chunk reports one', async () => {
    const bytes = wavBytes([tone(0.05, 0.5)]);
    const withSizes = await createRecordingInput([chunkOf('a.wav', bytes, 100), chunkOf('b.wav', bytes, 200)]);
    expect(withSizes.totalSizeBytes).toBe(300);

    const partial: RecordingChunk = { name: 'c.wav', open: () => chunksOf(bytes) };
    const withoutSizes = await createRecordingInput([chunkOf('a.wav', bytes), partial]);
    expect(withoutSizes.totalSizeBytes).toBeUndefined();
  });
});

describe('compareNaturally', () => {
  it('orders digit runs numerically and ignores case', () => {
    const names = ['ZOOM0010.WAV', 'ZOOM0002.WAV', 'zoom0001.wav'];
    expect([...names].sort(compareNaturally)).toEqual(['zoom0001.wav', 'ZOOM0002.WAV', 'ZOOM0010.WAV']);
  });
});