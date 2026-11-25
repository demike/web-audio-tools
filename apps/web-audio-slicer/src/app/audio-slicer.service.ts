import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import {
  Slicer,
  bytesToBlob,
  type AudioInput,
  type SilenceSegment,
  type SliceOptions,
  type SlicerState,
  type Track as CoreTrack
} from '@web-audio-tools/audio-core';
import { WorkerMp3Encoder, browserScheduler } from './browser-encoders';
import { TranscriptionService } from './transcription.service';

export type { SilenceSegment, SlicerState, SliceOptions };

/** Browser track adds object-URL playback fields on top of the core track. */
export interface Track extends CoreTrack {
  mp3Blob: Blob | null;
  mp3Url: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class AudioSlicerService {
  // Slicing parameters (user customizable)
  public thresholdDb = -45;
  public minSilenceDuration = 2.0;
  public minSongDuration = 8.0;
  public mp3Bitrate = 192;
  public preRollSec = 0.3;
  public postRollSec = 0.5;

  private state = new BehaviorSubject<SlicerState>({
    status: 'idle',
    fileName: '',
    progress: 0,
    currentTime: 0,
    totalDurationEstimate: 0,
    dbLevel: -100,
    currentTrackId: null,
    currentStateName: 'SILENCE'
  });

  private tracks = new BehaviorSubject<Track[]>([]);
  private segments = new BehaviorSubject<SilenceSegment[]>([]);
  private volumeLevel = new Subject<number>();

  public state$ = this.state.asObservable();
  public tracks$ = this.tracks.asObservable();
  public segments$ = this.segments.asObservable();
  public volumeLevel$ = this.volumeLevel.asObservable();

  private readonly transcriptionService = inject(TranscriptionService);
  private currentFile: File | null = null;

  /** Persistent core slicer; its observer drives the RxJS streams the UI consumes. */
  private readonly core = new Slicer({
    encoderFactory: () => new WorkerMp3Encoder(),
    transcription: null,
    scheduler: browserScheduler,
    observer: {
      onState: state => this.state.next(state),
      onVolume: db => this.volumeLevel.next(db),
      onTrackAdded: track => this.tracks.next([...this.tracks.getValue(), this.toBrowserTrack(track)]),
      onTrackUpdated: track => this.tracks.next(this.tracks.getValue().map(t => t.key === track.key ? this.toBrowserTrack(track) : t)),
      onTrackRemoved: key => {
        const removed = this.tracks.getValue().find(t => t.key === key);
        if (removed?.mp3Url) {
          URL.revokeObjectURL(removed.mp3Url);
        }
        this.tracks.next(this.tracks.getValue().filter(t => t.key !== key));
      },
      onSegmentAdded: segment => this.segments.next([...this.segments.getValue(), segment]),
      onSegmentUpdated: segment => this.segments.next(this.segments.getValue().map(s => s.id === segment.id ? segment : s))
    }
  });

  /** Exposed so the WebMCP tool layer can drive the same slicer the UI watches. */
  public getCoreSlicer(): Slicer {
    return this.core;
  }

  public getCurrentFile(): File | null {
    return this.currentFile;
  }

  public getTracksValue(): Track[] {
    return this.tracks.getValue();
  }

  public getSegmentsValue(): SilenceSegment[] {
    return this.segments.getValue();
  }

  public updateTrackTitle(trackId: number, title: string, titleSource: Track['titleSource'] = 'manual'): void {
    this.core.updateTrackTitle(trackId, title, titleSource);
  }

  public updateTrackTitleByKey(trackKey: number, title: string, titleSource: Track['titleSource'] = 'manual'): void {
    this.core.updateTrackTitleByKey(trackKey, title, titleSource);
  }

  /** Removes an unwanted track; the observer revokes its URL and updates the stream. */
  public removeTrack(trackId: number): void {
    this.core.removeTrackById(trackId);
  }

  public cancelSlicing(): void {
    this.core.cancel();
  }

  public reset(): void {
    this.core.cancel();
    this.revokeAllUrls();
    this.tracks.next([]);
    this.segments.next([]);
    this.state.next({
      status: 'idle',
      fileName: '',
      progress: 0,
      currentTime: 0,
      totalDurationEstimate: 0,
      dbLevel: -100,
      currentTrackId: null,
      currentStateName: 'SILENCE'
    });
  }

  /**
   * Main slicing entry point. Delegates to the platform-agnostic core Slicer,
   * wiring browser adapters (Worker encoder, Prompt API/Gemini transcription).
   */
  public async sliceWavFile(file: File, options: SliceOptions = {}): Promise<void> {
    this.reset();
    this.currentFile = file;
    await this.runInput(file.stream(), {
      ...options,
      fileName: file.name,
      fileSizeBytes: file.size
    });
  }

  /** Runs the core slicer over an arbitrary input (used by the UI and tools). */
  public async runInput(input: AudioInput, options: SliceOptions = {}): Promise<void> {
    this.core.transcription = options.externalTranscription ? null : this.transcriptionService;
    this.core.parameters = {
      thresholdDb: this.thresholdDb,
      minSilenceDuration: this.minSilenceDuration,
      minSongDuration: this.minSongDuration,
      mp3Bitrate: this.mp3Bitrate,
      preRollSec: this.preRollSec,
      postRollSec: this.postRollSec
    };

    try {
      await this.core.run(input, options);
    } catch (error) {
      console.error('Error during slicing:', error);
      throw error;
    }
  }

  private toBrowserTrack(core: CoreTrack): Track {
    const existing = this.tracks.getValue().find(t => t.key === core.key);
    let mp3Blob = existing?.mp3Blob ?? null;
    let mp3Url = existing?.mp3Url ?? null;

    if (core.mp3Bytes && !mp3Blob) {
      mp3Blob = bytesToBlob(core.mp3Bytes, 'audio/mp3');
      mp3Url = URL.createObjectURL(mp3Blob);
    }

    return { ...core, mp3Blob, mp3Url };
  }

  private revokeAllUrls(): void {
    for (const track of this.tracks.getValue()) {
      if (track.mp3Url) {
        URL.revokeObjectURL(track.mp3Url);
      }
    }
  }
}