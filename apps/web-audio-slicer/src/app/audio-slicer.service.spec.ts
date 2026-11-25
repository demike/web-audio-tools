import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { createWavBytes, type ConfigStore } from '@web-audio-tools/audio-core';
import { AudioSlicerService } from './audio-slicer.service';
import { CONFIG_STORE } from './config-store';
import { SettingsService } from './settings.service';
import { TranscriptionService } from './transcription.service';

class MemoryConfigStore implements ConfigStore {
  public readonly data = new Map<string, string>();
  public get(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  public set(key: string, value: string): void {
    this.data.set(key, value);
  }
  public remove(key: string): void {
    this.data.delete(key);
  }
}

class FakeWorker {
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: { message: string }) => void) | null = null;
  public onmessageerror: (() => void) | null = null;
  public terminated = false;
  constructor(public url: string) {}
  public postMessage(message: { command: string }): void {
    queueMicrotask(() => {
      if (message.command === 'encode') {
        this.onmessage?.({ data: { event: 'progress' } });
      } else if (message.command === 'finish') {
        this.onmessage?.({ data: { event: 'finished', blob: new Blob([new Uint8Array([0xff, 0xfb])], { type: 'audio/mp3' }) } });
      } else {
        this.onmessage?.({ data: { event: 'initialized' } });
      }
    });
  }
  public terminate(): void {
    this.terminated = true;
  }
}

const SR = 44100;
function tone(seconds: number, amp: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin(2 * Math.PI * 440 * i / SR);
  }
  return out;
}
function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR));
}
function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
function twoPieceWav(): Uint8Array {
  const signal = concat(silence(2), tone(10, 0.5), silence(3), tone(10, 0.5), silence(2));
  return createWavBytes([signal, signal], SR);
}
async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += 8192) {
    yield bytes.subarray(i, Math.min(i + 8192, bytes.length));
  }
}

let service: AudioSlicerService;
let settings: SettingsService;

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  const transcriptionMock = {
    hasProvider: vi.fn(async () => false),
    transcribeAudio: vi.fn(async () => null),
    extractSongTitle: vi.fn(async () => null)
  } as unknown as TranscriptionService;

  TestBed.configureTestingModule({
    providers: [
      AudioSlicerService,
      { provide: CONFIG_STORE, useValue: new MemoryConfigStore() },
      { provide: TranscriptionService, useValue: transcriptionMock }
    ]
  });
  service = TestBed.inject(AudioSlicerService);
  settings = TestBed.inject(SettingsService);
});

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

describe('AudioSlicerService', () => {
  it('slices a WAV into tracks and exposes them via the stream', async () => {
    const bytes = twoPieceWav();
    await service.runInput(chunks(bytes), { fileName: 'test.wav', fileSizeBytes: bytes.length });

    const tracks = service.getTracksValue();
    expect(tracks).toHaveLength(2);
    expect(tracks.every(t => t.status === 'done')).toBe(true);
    expect(tracks.every(t => t.mp3Url !== null && t.mp3Blob !== null)).toBe(true);
  });

  it('sliceWavFile accepts a File and estimates progress', async () => {
    const bytes = twoPieceWav();
    const file = new File([bytes.buffer as ArrayBuffer], 'rehearsal.wav', { type: 'audio/wav' });
    await service.sliceWavFile(file);
    expect(service.getTracksValue()).toHaveLength(2);
    expect(service.getCurrentFile()).toBe(file);
  });

  it('updates a track title', async () => {
    const bytes = twoPieceWav();
    await service.runInput(chunks(bytes), { fileSizeBytes: bytes.length });
    service.updateTrackTitle(1, 'My Title', 'manual');
    expect(service.getTracksValue()[0].title).toBe('My Title');
    expect(service.getTracksValue()[0].titleSource).toBe('manual');
  });

  it('removes a track and revokes its URL', async () => {
    const bytes = twoPieceWav();
    await service.runInput(chunks(bytes), { fileSizeBytes: bytes.length });
    const url = service.getTracksValue()[0].mp3Url;
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    service.removeTrack(1);
    expect(service.getTracksValue()).toHaveLength(1);
    expect(service.getTracksValue()[0].id).toBe(2);
    expect(revokeSpy).toHaveBeenCalledWith(url);
  });

  it('runs with the current Settings from the SettingsService', async () => {
    // Pieces are 10s; raising the minimum song duration above that filters
    // the first piece out, proving settings flow into the engine at run time.
    // (The core always keeps the unfinished tail piece at EOF.)
    settings.update({ minSongDuration: 60 });
    const bytes = twoPieceWav();
    await service.runInput(chunks(bytes), { fileSizeBytes: bytes.length });
    expect(service.getTracksValue()).toHaveLength(1);
  });

  it('reset clears tracks and segments', async () => {
    const bytes = twoPieceWav();
    await service.runInput(chunks(bytes), { fileSizeBytes: bytes.length });
    service.reset();
    expect(service.getTracksValue()).toHaveLength(0);
    expect(service.getSegmentsValue()).toHaveLength(0);
  });
});