import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AudioSlicerService, Track, SilenceSegment, SlicerState } from './audio-slicer.service';
import {
  PromptApiDiagnostics,
  PromptApiStatus,
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  TranscriptionLanguageCode,
  TranscriptionService
} from './transcription.service';
import { WebMcpService } from './webmcp.service';
import { Subscription } from 'rxjs';

type ModelContextCapable = {
  modelContext?: unknown;
};

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  public file: File | null = null;
  public state: SlicerState = {
    status: 'idle',
    fileName: '',
    progress: 0,
    currentTime: 0,
    totalDurationEstimate: 0,
    dbLevel: -100,
    currentTrackId: null,
    currentStateName: 'SILENCE'
  };

  public tracks: Track[] = [];
  public segments: SilenceSegment[] = [];
  
  // Settings
  public apiKey = '';
  public transcriptionLanguage: TranscriptionLanguageCode = 'auto';
  public transcriptionLanguageOptions = TRANSCRIPTION_LANGUAGE_OPTIONS;
  public thresholdDb = -45;
  public minSilenceDuration = 2.5;
  public minSongDuration = 8.0;
  public mp3Bitrate = 192;
  public transcribeSpeechGapsOnStart = true;
  public trackStartIndex = 1;

  // UI status
  public promptApiDiagnostics: PromptApiDiagnostics = {
    status: 'unsupported',
    detail: 'Prompt API status not checked yet.',
    lastError: null
  };
  public webMcpStatus: 'unsupported' | 'active' = 'unsupported';
  public showSettings = false;
  public isDragOver = false;

  // Visualizer history
  public volumeHistory: number[] = Array(80).fill(-100);
  
  // Track editing state
  public editingTrackId: number | null = null;
  public editingTitle = '';

  private readonly audioSlicerService = inject(AudioSlicerService);
  private readonly transcriptionService = inject(TranscriptionService);
  private readonly webMcpService = inject(WebMcpService);
  private readonly cdr = inject(ChangeDetectorRef);
  private subs: Subscription[] = [];

  public async ngOnInit(): Promise<void> {
    // 1. Load settings from localStorage
    this.apiKey = this.transcriptionService.getApiKey();
    this.transcriptionLanguage = this.transcriptionService.getTranscriptionLanguage();
    this.thresholdDb = this.audioSlicerService.thresholdDb;
    this.minSilenceDuration = this.audioSlicerService.minSilenceDuration;
    this.minSongDuration = this.audioSlicerService.minSongDuration;
    this.mp3Bitrate = this.audioSlicerService.mp3Bitrate;

    // 2. Subscriptions
    this.subs.push(
      this.audioSlicerService.state$.subscribe(s => {
        this.state = s;
        this.cdr.markForCheck();
      }),
      this.audioSlicerService.tracks$.subscribe(t => {
        this.tracks = t;
        this.cdr.markForCheck();
      }),
      this.audioSlicerService.segments$.subscribe(seg => {
        this.segments = seg;
        this.cdr.markForCheck();
      }),
      this.transcriptionService.promptApiDiagnostics$.subscribe(diagnostics => {
        this.promptApiDiagnostics = diagnostics;
        this.cdr.markForCheck();
      }),
      this.audioSlicerService.volumeLevel$.subscribe(db => {
        // Shift history and append new value
        this.volumeHistory.shift();
        this.volumeHistory.push(db);
        this.cdr.markForCheck();
      })
    );

    // 3. AI Support detection and WebMCP registration (Browser-only)
    if (typeof window !== 'undefined') {
      await this.transcriptionService.refreshPromptApiDiagnostics();

      const hasModelContext = Boolean(
        (navigator as Navigator & ModelContextCapable).modelContext
        || (document as Document & ModelContextCapable).modelContext
      );

      if (hasModelContext) {
        this.webMcpService.registerWebMcpTools();
        this.webMcpStatus = 'active';
      }
    }
  }

  public ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }

  // --- Settings Management ---
  public saveSettings(): void {
    this.transcriptionService.saveApiKey(this.apiKey);
    this.transcriptionService.saveTranscriptionLanguage(this.transcriptionLanguage);
    this.audioSlicerService.thresholdDb = Number(this.thresholdDb);
    this.audioSlicerService.minSilenceDuration = Number(this.minSilenceDuration);
    this.audioSlicerService.minSongDuration = Number(this.minSongDuration);
    this.audioSlicerService.mp3Bitrate = Number(this.mp3Bitrate);
    this.showSettings = false;
    if (typeof window !== 'undefined') {
      void this.transcriptionService.refreshPromptApiDiagnostics();
    }
  }

  public getPromptApiStatusLabel(status: PromptApiStatus): string {
    switch (status) {
      case 'available':
      case 'downloadable':
      case 'downloading':
      case 'unavailable':
      case 'unsupported':
        return status;
      case 'error':
      default:
        return 'runtime error';
    }
  }

  public get hasGeminiFallbackConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  // --- Drag & Drop / File Handling ---
  public onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.file = input.files[0];
      this.audioSlicerService.reset();
    }
  }

  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = true;
  }

  public onDragLeave(): void {
    this.isDragOver = false;
  }

  public onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
    if (event.dataTransfer && event.dataTransfer.files.length > 0) {
      const droppedFile = event.dataTransfer.files[0];
      if (droppedFile.name.toLowerCase().endsWith('.wav')) {
        this.file = droppedFile;
        this.audioSlicerService.reset();
      } else {
        alert('Please select a valid WAV audio file.');
      }
    }
  }

  // --- Slicing Controls ---
  public async startSlicing(): Promise<void> {
    if (!this.file) return;
    
    // Save current parameters to the service just in case
    this.saveSettings();

    try {
      await this.audioSlicerService.sliceWavFile(this.file, {
        transcribeSpeechGaps: this.transcribeSpeechGapsOnStart,
        trackStartIndex: this.trackStartIndex
      });
    } catch (e) {
      console.error(e);
      alert('Slicing failed: ' + (e as Error).message);
    }
  }

  public cancelSlicing(): void {
    this.audioSlicerService.cancelSlicing();
  }

  // --- Track Editing ---
  public startEditing(track: Track): void {
    this.editingTrackId = track.id;
    this.editingTitle = track.title;
  }

  public saveEditing(trackId: number): void {
    if (this.editingTitle.trim()) {
      this.audioSlicerService.updateTrackTitle(trackId, this.editingTitle.trim());
    }
    this.editingTrackId = null;
  }

  public cancelEditing(): void {
    this.editingTrackId = null;
  }

  // --- Download Helpers ---
  public downloadTrack(track: Track): void {
    if (!track.mp3Url || !track.mp3Blob) return;
    
    const element = document.createElement('a');
    element.href = track.mp3Url;
    // Sanitize filename
    const safeTitle = track.title.replace(/[^a-zA-Z0-9_\-\s]/g, '');
    element.download = `${safeTitle || 'Track'}.mp3`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  }

  public downloadAll(): void {
    const completedTracks = this.tracks.filter(t => t.status === 'done');
    if (completedTracks.length === 0) return;

    // Sequentially download each track
    completedTracks.forEach((track, index) => {
      setTimeout(() => {
        this.downloadTrack(track);
      }, index * 400); // Small timeout to prevent browser blocking multiple downloads
    });
  }

  // --- Formatting Helpers ---
  public formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds === Infinity) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const hundredths = Math.floor((seconds % 1) * 100);
    
    const pad = (n: number) => n < 10 ? '0' + n : n;
    return `${pad(mins)}:${pad(secs)}.${pad(hundredths)}`;
  }

  public formatVolumePercent(db: number): string {
    // Convert decibels (-100 to 0) to percentage (0% to 100%)
    if (db <= -100) return '0%';
    const percent = Math.max(0, Math.min(100, Math.round(((db + 100) / 100) * 100)));
    return `${percent}%`;
  }

  public getStatusClass(status: string): string {
    switch (status) {
      case 'done': return 'status-done';
      case 'encoding': return 'status-encoding';
      case 'pending': return 'status-pending';
      default: return 'status-failed';
    }
  }

  public getStatusIcon(status: string): string {
    switch (status) {
      case 'done': return 'fa-circle-check';
      case 'encoding': return 'fa-spinner fa-spin';
      case 'pending': return 'fa-clock';
      default: return 'fa-circle-xmark';
    }
  }
}
