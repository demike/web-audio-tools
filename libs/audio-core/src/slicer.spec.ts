import { describe, expect, it } from 'vitest';
import { Slicer } from './slicer';
import { LameMp3Encoder } from './mp3';
import type { TranscriptionPort } from './ports';
import { concat, fade, silence, tone, wavBytes } from './test-helpers';

function makeSlicer(transcription: TranscriptionPort | null = null): Slicer {
  return new Slicer({ encoderFactory: () => new LameMp3Encoder(), transcription });
}

async function waitFor(condition: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('Slicer region detection', () => {
  it('slices two pieces separated by silence and encodes both', async () => {
    const signal = concat(silence(2), tone(10, 0.5), silence(3), tone(10, 0.5), silence(2));
    const bytes = wavBytes([signal, signal]);
    const slicer = makeSlicer();
    const result = await slicer.run(chunks(bytes), { fileName: 't.wav', fileSizeBytes: bytes.length });

    expect(result.tracks).toHaveLength(2);
    for (const track of result.tracks) {
      expect(track.status).toBe('done');
      expect(track.mp3Bytes!.length).toBeGreaterThan(0);
      expect(track.mp3Bytes![0]).toBe(0xff);
    }
  });

  it('detects a piece panned entirely to the right channel', async () => {
    const left = concat(silence(2), silence(10), silence(2));
    const right = concat(silence(2), tone(10, 0.5), silence(2));
    const bytes = wavBytes([left, right]);
    const result = await makeSlicer().run(chunks(bytes), { fileSizeBytes: bytes.length });
    expect(result.tracks).toHaveLength(1);
  });

  it('discards regions shorter than minSongDuration', async () => {
    const signal = concat(silence(2), tone(2, 0.5), silence(3), tone(10, 0.5), silence(2));
    const bytes = wavBytes([signal, signal]);
    const result = await makeSlicer().run(chunks(bytes), { fileSizeBytes: bytes.length });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].duration).toBeGreaterThan(8);
  });

  it('captures a short loud announcement as a speech gap for external transcription', async () => {
    const signal = concat(silence(1), tone(2, 0.5, 300), silence(3), tone(10, 0.5), silence(2));
    const bytes = wavBytes([signal, signal]);
    const result = await makeSlicer(null).run(chunks(bytes), { fileSizeBytes: bytes.length });

    expect(result.tracks).toHaveLength(1);
    const speechGap = result.segments.find(s => s.speechWav);
    expect(speechGap).toBeDefined();
    expect(speechGap!.status).toBe('idle');
    expect(speechGap!.speechSampleRate).toBe(16000);
  });

  it('skips transcription when disabled', async () => {
    const signal = concat(silence(2), tone(2, 0.005, 300), silence(1), tone(10, 0.5), silence(2));
    const bytes = wavBytes([signal, signal]);
    const result = await makeSlicer().run(chunks(bytes), { fileSizeBytes: bytes.length, transcribeSpeechGaps: false });
    expect(result.segments.every(s => s.status === 'skipped')).toBe(true);
  });
});

describe('Slicer padding', () => {
  it('keeps the quiet attack and decay via pre/post-roll', async () => {
    const signal = concat(silence(3), fade(0.4, 0, 0.5), tone(8, 0.5), fade(0.4, 0.5, 0), silence(3));
    const bytes = wavBytes([signal, signal]);
    const result = await makeSlicer().run(chunks(bytes), { fileSizeBytes: bytes.length });

    const track = result.tracks[0];
    expect(track.startTime).toBeLessThan(3.0);
    expect(track.endTime).toBeGreaterThan(11.8);
    expect(track.duration).toBeGreaterThan(9.0);
  });

  it('respects zero padding', async () => {
    const signal = concat(silence(3), tone(8, 0.5), silence(3));
    const bytes = wavBytes([signal, signal]);
    const slicer = makeSlicer();
    slicer.parameters = { ...slicer.parameters, preRollSec: 0, postRollSec: 0 };
    const result = await slicer.run(chunks(bytes), { fileSizeBytes: bytes.length });
    const track = result.tracks[0];
    expect(track.startTime).toBeGreaterThanOrEqual(2.8);
    expect(track.duration).toBeLessThan(8.6);
  });
});

describe('Slicer transcription integration', () => {
  it('applies an extracted title from the transcription port', async () => {
    const port: TranscriptionPort = {
      hasProvider: async () => true,
      transcribeAudio: async () => 'Beethoven String Quartet opus 131',
      extractSongTitle: async () => ({ title: 'Beethoven - String Quartet Op. 131', source: 'transcription' })
    };
    const signal = concat(silence(1), tone(2, 0.005, 300), silence(1), tone(10, 0.5), silence(2));
    const bytes = wavBytes([signal, signal]);
    const result = await makeSlicer(port).run(chunks(bytes), { fileSizeBytes: bytes.length });

    expect(result.tracks[0].title).toBe('Beethoven - String Quartet Op. 131');
    expect(result.tracks[0].transcription).toBe('Beethoven String Quartet opus 131');
  });

  it('does not overwrite a manually edited title', async () => {
    let resolveTitle: ((value: { title: string; source: 'transcription' }) => void) | null = null;
    let titleRequested = false;
    const port: TranscriptionPort = {
      hasProvider: async () => true,
      transcribeAudio: async () => 'some announcement',
      extractSongTitle: () => {
        titleRequested = true;
        return new Promise(resolve => {
          resolveTitle = resolve;
        });
      }
    };
    const signal = concat(silence(1), tone(2, 0.005, 300), silence(1), tone(10, 0.5), silence(2));
    const bytes = wavBytes([signal, signal]);
    const slicer = makeSlicer(port);
    const runPromise = slicer.run(chunks(bytes), { fileSizeBytes: bytes.length });

    await waitFor(() => titleRequested);
    slicer.updateTrackTitle(1, 'My Manual Name', 'manual');
    resolveTitle!({ title: 'Auto Name', source: 'transcription' });
    await runPromise;

    expect(slicer.getTracksValue()[0].title).toBe('My Manual Name');
    expect(slicer.getTracksValue()[0].titleSource).toBe('manual');
  });

  it('removes an unwanted track', async () => {
    const signal = concat(silence(2), tone(10, 0.5), silence(3), tone(10, 0.5), silence(2));
    const bytes = wavBytes([signal, signal]);
    const slicer = makeSlicer();
    await slicer.run(chunks(bytes), { fileSizeBytes: bytes.length });
    expect(slicer.getTracksValue()).toHaveLength(2);

    slicer.removeTrackById(1);
    expect(slicer.getTracksValue()).toHaveLength(1);
    expect(slicer.getTracksValue()[0].id).toBe(2);
  });
});

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += 8192) {
    yield bytes.subarray(i, Math.min(i + 8192, bytes.length));
  }
}