/**
 * Browser adapters for the core seams: a Web Worker MP3 encoder (keeps encoding
 * off the main thread) and a requestAnimationFrame-based scheduler.
 */
import type { Mp3EncoderPort, Scheduler } from '@web-audio-tools/audio-core';

export const browserScheduler: Scheduler = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  yield: () => new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  })
};

/**
 * Adapts the existing mp3-encoder-worker.js to the core Mp3EncoderPort.
 * `encode` resolves when the worker acknowledges the window, so a saturated
 * worker backpressures the slicer just like the original flow control did.
 */
export class WorkerMp3Encoder implements Mp3EncoderPort {
  private worker: Worker | null = null;
  private queueDepth = 0;
  private readonly maxQueueDepth = 8;
  private capacityWaiters: Array<() => void> = [];
  private progressWaiters: Array<() => void> = [];
  private finishWaiter: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } | null = null;
  private failed: Error | null = null;

  public start(channels: number, sampleRate: number, bitrate: number): void {
    this.abort();
    this.failed = null;

    const worker = new Worker('/mp3-encoder-worker.js');
    this.worker = worker;

    worker.onmessage = ({ data }) => {
      const { event, blob, error } = data;

      if (event === 'progress') {
        this.queueDepth = Math.max(0, this.queueDepth - 1);
        this.notifyCapacity();
        this.progressWaiters.shift()?.();
        return;
      }

      if (event === 'finished') {
        this.resetFlow();
        const waiter = this.finishWaiter;
        this.finishWaiter = null;
        if (blob) {
          blob.arrayBuffer().then((buffer: ArrayBuffer) => waiter?.resolve(new Uint8Array(buffer)));
        } else {
          waiter?.resolve(new Uint8Array(0));
        }
        worker.terminate();
        this.worker = null;
        return;
      }

      if (event === 'error') {
        this.handleError(new Error(String(error)));
      }
    };

    worker.onerror = event => this.handleError(new Error(event.message || 'MP3 worker error'));
    worker.onmessageerror = () => this.handleError(new Error('MP3 worker message error'));

    worker.postMessage({ command: 'init', payload: { channels, sampleRate, bitrate } });
  }

  public async encode(channels: Float32Array[]): Promise<void> {
    if (this.failed) {
      throw this.failed;
    }
    await this.waitForCapacity();
    if (!this.worker || this.failed) {
      throw this.failed ?? new Error('MP3 worker not initialized');
    }

    this.queueDepth++;
    const copies = channels.map(channel => {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      return copy;
    });

    const worker = this.worker;
    return new Promise<void>((resolve, reject) => {
      this.progressWaiters.push(resolve);
      try {
        worker.postMessage(
          { command: 'encode', payload: { channelsData: copies } },
          copies.map(copy => copy.buffer)
        );
      } catch (error) {
        this.queueDepth = Math.max(0, this.queueDepth - 1);
        this.progressWaiters.pop();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public finish(): Promise<Uint8Array> {
    if (this.failed) {
      return Promise.reject(this.failed);
    }
    if (!this.worker) {
      return Promise.resolve(new Uint8Array(0));
    }

    const worker = this.worker;
    return new Promise<Uint8Array>((resolve, reject) => {
      this.finishWaiter = { resolve, reject };
      worker.postMessage({ command: 'finish' });
    });
  }

  public abort(): void {
    this.worker?.terminate();
    this.worker = null;
    this.resetFlow();
    this.finishWaiter?.reject(new Error('MP3 encoding aborted'));
    this.finishWaiter = null;
  }

  private handleError(error: Error): void {
    this.failed = error;
    this.worker?.terminate();
    this.worker = null;
    this.resetFlow();
    this.progressWaiters.splice(0).forEach(() => undefined);
    this.finishWaiter?.reject(error);
    this.finishWaiter = null;
  }

  private resetFlow(): void {
    this.queueDepth = 0;
    this.notifyCapacity();
  }

  private async waitForCapacity(): Promise<void> {
    while (this.worker && this.queueDepth >= this.maxQueueDepth && !this.failed) {
      await new Promise<void>(resolve => this.capacityWaiters.push(resolve));
    }
  }

  private notifyCapacity(): void {
    if (this.queueDepth >= this.maxQueueDepth || this.capacityWaiters.length === 0) {
      return;
    }
    this.capacityWaiters.splice(0).forEach(resolve => resolve());
  }
}