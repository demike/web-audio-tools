import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import {
  Slicer,
  bytesToBlob,
  createRecordingInput,
  createRegionSource,
  exportRegionToMp3,
  type AudioInput,
  type EffectChainConfig,
  type RecordingChunk,
  type RecordingInput,
  type RegionSource,
  type SilenceSegment,
  type SliceOptions,
  type SlicerState,
  type Track as CoreTrack
} from '@web-audio-tools/audio-core';
import { WorkerMp3Encoder, browserScheduler } from './browser-encoders';
import { SettingsService } from './settings.service';
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
  private chunkLabel = new BehaviorSubject<string>('');

  public state$ = this.state.asObservable();
  public tracks$ = this.tracks.asObservable();
  public segments$ = this.segments.asObservable();
  public volumeLevel$ = this.volumeLevel.asObservable();
  /** "Chunk i of n" while a multi-chunk Recording is being sliced; '' otherwise. */
  public chunkLabel$ = this.chunkLabel.asObservable();

  private readonly transcriptionService = inject(TranscriptionService);
  private readonly settingsService = inject(SettingsService);
  private currentFiles: File[] = [];
  private currentRecording: RecordingInput | null = null;

  /** Persistent core slicer; its observer drives the RxJS streams the UI consumes. */
  private readonly core = new Slicer({
    transcription: null,
    scheduler: browserScheduler,
    observer: {
      onState: state => {
        this.state.next(state);
        this.updateChunkLabel();
      },
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

  public getCurrentFiles(): File[] {
    return this.currentFiles;
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
    // The loaded Recording survives a reset (like the previous currentFile),
    // so tool-driven runs can slice it again; a new load replaces it.
    this.chunkLabel.next('');
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
    await this.sliceRecording([file], options);
  }

  /**
   * Slices a Recording: one or more WAV files joined into a single continuous
   * timeline. A single file is a one-chunk Recording — the same code path.
   */
  public async sliceRecording(files: File[], options: SliceOptions = {}): Promise<void> {
    this.reset();
    this.currentFiles = [...files];
    const recording = await createRecordingInput(this.toRecordingChunks(files));
    this.currentRecording = recording;
    const displayName = files.length === 1
      ? files[0].name
      : `${files[0].name} (+${files.length - 1} ${files.length === 2 ? 'chunk' : 'chunks'})`;
    await this.runInput(recording.input, {
      ...options,
      fileName: displayName,
      fileSizeBytes: recording.totalSizeBytes
    });
  }

  /** Builds RecordingChunks from browser Files (used by the UI and WebMCP). */
  public toRecordingChunks(files: File[]): RecordingChunk[] {
    return files.map(file => ({
      name: file.name,
      sizeBytes: file.size,
      open: () => file.stream(),
      openRange: (startByte, endByte) => file.slice(startByte, endByte).stream()
    }));
  }

  public getCurrentRecording(): RecordingInput | null {
    return this.currentRecording;
  }

  /** A re-readable region source for one Track (the shared Audition/Export path). */
  public regionSourceFor(track: CoreTrack): RegionSource {
    const recording = this.currentRecording;
    if (!recording || this.currentFiles.length === 0) {
      throw new Error('No Recording is loaded; slice a file before exporting or auditioning.');
    }
    return createRegionSource(this.toRecordingChunks(this.currentFiles), recording, track.startTime, track.endTime);
  }

  /**
   * On-demand Export of one Track: re-read its region, apply the effect config,
   * encode to MP3 (Worker encoder), and record the result on the core Track.
   * The reverb tail is capped so it never reaches the next Track's start.
   */
  public async exportTrack(trackKey: number, config: EffectChainConfig): Promise<{ durationSec: number } | null> {
    const recording = this.currentRecording;
    const tracks = this.core.getTracksValue();
    const index = tracks.findIndex(t => t.key === trackKey);
    if (!recording || index < 0) {
      return null;
    }
    const track = tracks[index];
    const nextStart = index + 1 < tracks.length ? tracks[index + 1].startTime : undefined;
    const maxDurationSec = nextStart !== undefined ? nextStart - track.startTime : undefined;
    this.core.setTrackStatus(trackKey, 'encoding');
    try {
      const result = await exportRegionToMp3(
        this.regionSourceFor(track),
        {
          config,
          sampleRate: recording.header.sampleRate,
          sourceChannels: recording.header.channels,
          maxDurationSec,
          scheduler: browserScheduler
        },
        () => new WorkerMp3Encoder(),
        this.settingsService.slicerParameters().mp3Bitrate
      );
      this.core.applyExportResult(trackKey, result.mp3Bytes, result.durationSec);
      return { durationSec: result.durationSec };
    } catch (error) {
      this.core.applyExportResult(trackKey, null);
      throw error;
    }
  }

  /** Exports every detected Track in order with the given effect config. */
  public async exportAll(config: EffectChainConfig): Promise<void> {
    for (const track of [...this.core.getTracksValue()]) {
      await this.exportTrack(track.key, config);
    }
  }

  private updateChunkLabel(): void {
    const recording = this.currentRecording;
    const label = recording && recording.chunkDataBytes.length > 1
      ? `Chunk ${recording.currentChunkIndex + 1} of ${recording.chunkDataBytes.length}`
      : '';
    if (label !== this.chunkLabel.getValue()) {
      this.chunkLabel.next(label);
    }
  }

  /** Runs the core slicer over an arbitrary input (used by the UI and tools). */
  public async runInput(input: AudioInput, options: SliceOptions = {}): Promise<void> {
    this.core.transcription = options.externalTranscription ? null : this.transcriptionService;
    this.core.parameters = this.settingsService.slicerParameters();

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