import { Injectable, inject, signal } from '@angular/core';
import { DRY_EFFECT_CONFIG, bytesToBlob, type EffectChainConfig } from '@web-audio-tools/audio-core';
import { AudioSlicerService } from './audio-slicer.service';
import { PresetService } from './preset.service';
import type { AuditionRenderRequest } from './effect-render.worker';

interface RenderResponse {
  ok: boolean;
  wavBytes?: Uint8Array;
  durationSec?: number;
  error?: string;
}

/**
 * Audition: render-to-preview through the shared core path (in a worker), played
 * as a WAV blob. Tweaking the working config debounces a re-render and resumes
 * at the same playback position; a dry/wet toggle compares against the unprocessed
 * Track. No second DSP implementation — audition equals Export.
 */
@Injectable({ providedIn: 'root' })
export class AuditionService {
  private readonly slicer = inject(AudioSlicerService);
  private readonly presets = inject(PresetService);

  public readonly trackKey = signal<number | null>(null);
  public readonly rendering = signal(false);
  public readonly playing = signal(false);
  public readonly mode = signal<'wet' | 'dry'>('wet');
  public readonly error = signal<string | null>(null);
  public readonly durationSec = signal(0);

  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private worker: Worker | null = null;
  private renderToken = 0;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private resumeAt = 0;
  private resumePlaying = false;

  public audition(trackKey: number): void {
    this.trackKey.set(trackKey);
    this.mode.set('wet');
    this.resumeAt = 0;
    this.resumePlaying = true;
    void this.render(this.currentConfig());
  }

  public stop(): void {
    this.renderToken++;
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    this.worker?.terminate();
    this.worker = null;
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.revokeUrl();
    this.trackKey.set(null);
    this.playing.set(false);
    this.rendering.set(false);
  }

  public toggleDryWet(): void {
    const next = this.mode() === 'wet' ? 'dry' : 'wet';
    this.mode.set(next);
    this.captureResume();
    void this.render(this.currentConfig());
  }

  /** Called when the working config changes; debounced re-render, resume position. */
  public configChanged(): void {
    if (this.trackKey() === null || this.mode() === 'dry') {
      return;
    }
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      this.captureResume();
      void this.render(this.currentConfig());
    }, 300);
  }

  private currentConfig(): EffectChainConfig {
    return this.mode() === 'dry' ? DRY_EFFECT_CONFIG : this.presets.workingConfig();
  }

  private captureResume(): void {
    if (this.audio) {
      this.resumeAt = this.audio.currentTime;
      this.resumePlaying = !this.audio.paused;
    }
  }

  private async render(config: EffectChainConfig): Promise<void> {
    const key = this.trackKey();
    const recording = this.slicer.getCurrentRecording();
    const files = this.slicer.getCurrentFiles();
    const tracks = this.slicer.getTracksValue();
    const index = tracks.findIndex(t => t.key === key);
    if (key === null || !recording || index < 0 || files.length === 0) {
      return;
    }
    const track = tracks[index];
    const nextStart = index + 1 < tracks.length ? tracks[index + 1].startTime : undefined;
    const token = ++this.renderToken;
    this.rendering.set(true);
    this.error.set(null);

    this.worker?.terminate();
    const worker = new Worker(new URL('./effect-render.worker', import.meta.url), { type: 'module' });
    this.worker = worker;

    const request: AuditionRenderRequest = {
      files,
      header: recording.header,
      chunkDataBytes: recording.chunkDataBytes,
      startSec: track.startTime,
      endSec: track.endTime,
      config,
      sourceChannels: recording.header.channels,
      sampleRate: recording.header.sampleRate,
      maxDurationSec: nextStart !== undefined ? nextStart - track.startTime : undefined
    };

    const response = await new Promise<RenderResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<RenderResponse>) => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message || 'Audition worker error'));
      worker.onmessageerror = () => reject(new Error('Audition worker message error'));
      worker.postMessage(request);
    }).catch((error: Error) => ({ ok: false, error: error.message }) as RenderResponse);

    if (token !== this.renderToken) {
      worker.terminate();
      return;
    }
    worker.terminate();
    this.worker = null;
    this.rendering.set(false);

    if (!response.ok || !response.wavBytes) {
      this.error.set(response.error ?? 'Audition render failed.');
      return;
    }

    this.durationSec.set(response.durationSec ?? 0);
    this.revokeUrl();
    const blob = bytesToBlob(response.wavBytes, 'audio/wav');
    this.url = URL.createObjectURL(blob);
    this.playUrl(this.url);
  }

  private playUrl(url: string): void {
    const audio = this.audio ?? new Audio();
    this.audio = audio;
    audio.classList.add('html5-player');
    audio.src = url;
    const resumeAt = this.resumeAt;
    const shouldPlay = this.resumePlaying;
    audio.onloadedmetadata = () => {
      if (resumeAt > 0 && resumeAt < audio.duration) {
        audio.currentTime = resumeAt;
      }
    };
    audio.onplay = () => {
      this.playing.set(true);
      document.querySelectorAll<HTMLAudioElement>('audio.html5-player').forEach(player => {
        if (player !== audio) {
          player.pause();
        }
      });
    };
    audio.onpause = () => this.playing.set(false);
    audio.onended = () => this.playing.set(false);
    if (shouldPlay) {
      void audio.play().catch(() => this.playing.set(false));
    }
  }

  private revokeUrl(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
}