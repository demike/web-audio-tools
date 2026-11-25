import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerMp3Encoder, browserScheduler } from './browser-encoders';

/** Simulates the mp3-encoder-worker.js message protocol. */
class FakeWorker {
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: { message: string }) => void) | null = null;
  public onmessageerror: (() => void) | null = null;
  public terminated = false;
  public failNext = false;

  constructor(public url: string) {}

  public postMessage(message: { command: string }): void {
    queueMicrotask(() => {
      if (this.failNext) {
        this.onmessage?.({ data: { event: 'error', error: 'boom' } });
        return;
      }
      if (message.command === 'init') {
        this.onmessage?.({ data: { event: 'initialized' } });
      } else if (message.command === 'encode') {
        this.onmessage?.({ data: { event: 'progress' } });
      } else if (message.command === 'finish') {
        const blob = new Blob([new Uint8Array([0xff, 0xfb, 0x90])], { type: 'audio/mp3' });
        this.onmessage?.({ data: { event: 'finished', blob } });
      }
    });
  }

  public terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkerMp3Encoder', () => {
  it('encodes through the worker and returns the finished bytes', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const encoder = new WorkerMp3Encoder();
    encoder.start(2, 44100, 192);
    await encoder.encode([new Float32Array(1152), new Float32Array(1152)]);
    const bytes = await encoder.finish();
    expect(Array.from(bytes)).toEqual([0xff, 0xfb, 0x90]);
  });

  it('handles many windows (backpressure drains via progress events)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const encoder = new WorkerMp3Encoder();
    encoder.start(1, 44100, 128);
    for (let i = 0; i < 30; i++) {
      await encoder.encode([new Float32Array(1152)]);
    }
    const bytes = await encoder.finish();
    expect(bytes.length).toBe(3);
  });

  it('rejects when the worker reports an error', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const encoder = new WorkerMp3Encoder();
    encoder.start(1, 44100, 128);
    // Make the worker fail on the finish command.
    const worker = (encoder as unknown as { worker: FakeWorker }).worker;
    worker.failNext = true;
    await expect(encoder.finish()).rejects.toThrow('boom');
  });

  it('abort terminates the worker', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const encoder = new WorkerMp3Encoder();
    encoder.start(1, 44100, 128);
    const worker = (encoder as unknown as { worker: FakeWorker }).worker;
    encoder.abort();
    expect(worker.terminated).toBe(true);
  });
});

describe('browserScheduler', () => {
  it('provides a monotonic-ish clock and a yielding hook', async () => {
    expect(typeof browserScheduler.now()).toBe('number');
    await expect(browserScheduler.yield()).resolves.toBeUndefined();
  });
});