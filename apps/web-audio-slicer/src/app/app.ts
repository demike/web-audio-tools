import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { compareNaturally, type EffectChainConfig, type Preset } from '@web-audio-tools/audio-core';
import { AudioSlicerService, Track, SilenceSegment, SlicerState } from './audio-slicer.service';
import { PresetService } from './preset.service';
import { AuditionService } from './audition.service';
import {
  PromptApiDiagnostics,
  PromptApiStatus,
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  TranscriptionLanguageCode,
  TranscriptionService
} from './transcription.service';
import { WebMcpService } from './webmcp.service';
import { SettingsService, type Settings } from './settings.service';
import { Subscription } from 'rxjs';

type ModelContextCapable = {
  modelContext?: unknown;
};

/** Card directories that never hold source recordings (Zoom TRASH/Export). */
const SKIPPED_FOLDERS = new Set(['trash', 'export']);

function isWavName(name: string): boolean {
  return name.toLowerCase().endsWith('.wav');
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  /** The loaded Recording: one or more WAV chunks, in playback order. */
  public files: File[] = [];
  /** Run option: substring filter applied to files discovered inside dropped folders. */
  public fileNameFilter = '';
  /** "Chunk i of n" while slicing a multi-chunk Recording. */
  public chunkLabel = '';
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
  
  // Settings: the SettingsService is the single source of truth; every valid
  // change is auto-saved. Accessors keep the template's ngModel bindings.
  public readonly settings = inject(SettingsService);
  public readonly presets = inject(PresetService);
  public readonly audition = inject(AuditionService);
  public exportingAll = false;
  public exportError: string | null = null;
  public transcriptionLanguageOptions = TRANSCRIPTION_LANGUAGE_OPTIONS;
  // Run option (per-run input, not a Setting): not persisted, not reset.
  public trackStartIndex = 1;

  public get apiKey(): string {
    return this.settings.apiKey();
  }
  public set apiKey(value: string) {
    this.settings.setApiKey(value);
  }

  public get transcriptionLanguage(): TranscriptionLanguageCode {
    return this.settings.settings().transcriptionLanguage;
  }
  public set transcriptionLanguage(value: TranscriptionLanguageCode) {
    this.settings.update({ transcriptionLanguage: value });
    if (typeof window !== 'undefined') {
      void this.transcriptionService.refreshPromptApiDiagnostics();
    }
  }

  public get thresholdDb(): number {
    return this.settings.settings().thresholdDb;
  }
  public set thresholdDb(value: number) {
    this.settings.update({ thresholdDb: value });
  }

  public get minSilenceDuration(): number {
    return this.settings.settings().minSilenceDuration;
  }
  public set minSilenceDuration(value: number) {
    this.settings.update({ minSilenceDuration: value });
  }

  public get minSongDuration(): number {
    return this.settings.settings().minSongDuration;
  }
  public set minSongDuration(value: number) {
    this.settings.update({ minSongDuration: value });
  }

  public get mp3Bitrate(): number {
    return this.settings.settings().mp3Bitrate;
  }
  public set mp3Bitrate(value: number) {
    this.settings.update({ mp3Bitrate: value });
  }

  public get preRollSec(): number {
    return this.settings.settings().preRollSec;
  }
  public set preRollSec(value: number) {
    this.settings.update({ preRollSec: value });
  }

  public get postRollSec(): number {
    return this.settings.settings().postRollSec;
  }
  public set postRollSec(value: number) {
    this.settings.update({ postRollSec: value });
  }

  public get transcribeSpeechGapsOnStart(): boolean {
    return this.settings.settings().transcribeSpeechGapsOnStart;
  }
  public set transcribeSpeechGapsOnStart(value: boolean) {
    this.settings.update({ transcribeSpeechGapsOnStart: value });
  }

  // UI status
  public promptApiDiagnostics: PromptApiDiagnostics = {
    status: 'unsupported',
    detail: 'Prompt API status not checked yet.',
    lastError: null
  };
  public webMcpStatus: 'unsupported' | 'active' = 'unsupported';
  public showSettings = false;
  public isDragOver = false;
  public isDownloadingModel = false;
  public modelDownloadProgress: number | null = null;

  // Visualizer history
  public volumeHistory: number[] = Array(80).fill(-100);
  
  // Track editing state
  public editingTrackId: number | null = null;
  public editingTitle = '';
  public openMenuTrackId: number | null = null;
  public menuTrack: Track | null = null;
  public menuPosition: { top: number; left: number } | null = null;

  private readonly audioSlicerService = inject(AudioSlicerService);
  private readonly transcriptionService = inject(TranscriptionService);
  private readonly webMcpService = inject(WebMcpService);
  private readonly cdr = inject(ChangeDetectorRef);
  private subs: Subscription[] = [];

  public async ngOnInit(): Promise<void> {
    // 1. Subscriptions
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
      }),
      this.audioSlicerService.chunkLabel$.subscribe(label => {
        this.chunkLabel = label;
        this.cdr.markForCheck();
      })
    );

    // 2. AI Support detection and WebMCP registration (Browser-only)
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
  public resetConfirmPending = false;

  public toggleSettings(): void {
    this.showSettings = !this.showSettings;
    if (!this.showSettings) {
      this.resetConfirmPending = false;
    }
  }

  public closeSettings(): void {
    this.showSettings = false;
    this.resetConfirmPending = false;
  }

  /** Two-step confirmation: the first click arms the reset, the second performs it. */
  public requestResetToDefaults(): void {
    if (!this.settings.anyModified()) return;
    if (!this.resetConfirmPending) {
      this.resetConfirmPending = true;
      return;
    }
    this.settings.resetToDefaults();
    this.resetConfirmPending = false;
  }

  public cancelResetToDefaults(): void {
    this.resetConfirmPending = false;
  }

  /** On blur, snap an invalid mid-edit input back to the last valid persisted value. */
  public revertInvalidInput(field: keyof Settings, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = String(this.settings.settings()[field]);
    if (input.value !== value) {
      input.value = value;
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

  /** Re-check Prompt API availability without a page reload. */
  public async refreshPromptApiStatus(): Promise<void> {
    await this.transcriptionService.refreshPromptApiDiagnostics();
    this.cdr.markForCheck();
  }

  /** Triggered by a button click so Chrome has the user activation it requires. */
  public async downloadOnDeviceModel(): Promise<void> {
    this.isDownloadingModel = true;
    this.modelDownloadProgress = 0;
    this.cdr.markForCheck();

    try {
      await this.transcriptionService.downloadPromptApiModel(fraction => {
        this.modelDownloadProgress = Math.round(fraction * 100);
        this.cdr.markForCheck();
      });
    } finally {
      this.isDownloadingModel = false;
      this.modelDownloadProgress = null;
      this.cdr.markForCheck();
    }
  }

  // --- Drag & Drop / File Handling ---
  public onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const wavFiles = Array.from(input.files).filter(file => isWavName(file.name));
      if (wavFiles.length > 0) {
        this.setFiles(wavFiles);
      }
    }
  }

  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = true;
  }

  public onDragLeave(): void {
    this.isDragOver = false;
  }

  public async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isDragOver = false;
    const transfer = event.dataTransfer;
    if (!transfer) {
      return;
    }

    // Capture entries and files synchronously: DataTransfer items are
    // invalidated once the handler yields.
    const items = Array.from(transfer.items ?? []);
    const entries = items.map(item => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null);
    const plainFiles = Array.from(transfer.files);

    const collected: File[] = [];
    if (entries.some(entry => entry !== null)) {
      for (const entry of entries) {
        if (entry) {
          await this.collectEntry(entry, collected, false);
        }
      }
    } else {
      collected.push(...plainFiles);
    }

    const wavFiles = collected.filter(file => isWavName(file.name));
    if (wavFiles.length === 0) {
      alert('Please select a valid WAV audio file.');
      return;
    }
    this.setFiles(wavFiles);
  }

  /**
   * Walks a dropped filesystem entry. Loose files are kept as given; files
   * discovered inside folders pass the folder filter. TRASH/Export are skipped.
   */
  private async collectEntry(entry: FileSystemEntry, out: File[], inFolder: boolean): Promise<void> {
    if (entry.isFile) {
      if (inFolder && !this.matchesFolderFilter(entry.name)) {
        return;
      }
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push(file);
    } else if (entry.isDirectory) {
      if (SKIPPED_FOLDERS.has(entry.name.toLowerCase())) {
        return;
      }
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most 100 entries per call; loop until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) {
          break;
        }
        for (const child of batch) {
          await this.collectEntry(child, out, true);
        }
      }
    }
  }

  private matchesFolderFilter(name: string): boolean {
    const filter = this.fileNameFilter.trim().toLowerCase();
    return filter === '' || name.toLowerCase().includes(filter);
  }

  /** A new load replaces the Recording; chunks sort naturally by file name. */
  private setFiles(files: File[]): void {
    this.files = [...files].sort((a, b) => compareNaturally(a.name, b.name));
    this.audioSlicerService.reset();
    this.cdr.markForCheck();
  }

  /** Fixes the playback order when file names don't sort chronologically. */
  public moveChunk(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.files.length) {
      return;
    }
    const files = [...this.files];
    [files[index], files[target]] = [files[target], files[index]];
    this.files = files;
    this.cdr.markForCheck();
  }

  public get totalSizeBytes(): number {
    return this.files.reduce((sum, file) => sum + file.size, 0);
  }

  // --- Slicing Controls ---
  public async startSlicing(): Promise<void> {
    if (this.files.length === 0) return;

    try {
      await this.audioSlicerService.sliceRecording(this.files, {
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

  // --- Track Context Menu ---
  @HostListener('document:click')
  public onDocumentClick(): void {
    if (this.openMenuTrackId !== null) {
      this.closeTrackMenu();
    }
  }

  public toggleTrackMenu(track: Track, event: Event): void {
    event.stopPropagation();
    if (this.openMenuTrackId === track.id) {
      this.closeTrackMenu();
      return;
    }

    // Render the menu as a fixed overlay at the app root so it escapes the
    // stacking contexts created by the glass panels' backdrop-filter.
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const menuWidth = 168;
    const menuHeight = 132;
    const left = Math.max(8, rect.right - menuWidth);
    let top = rect.bottom + 6;
    if (top + menuHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - menuHeight - 6);
    }

    this.menuPosition = { top, left };
    this.menuTrack = track;
    this.openMenuTrackId = track.id;
    this.cdr.markForCheck();
  }

  public closeTrackMenu(): void {
    this.openMenuTrackId = null;
    this.menuTrack = null;
    this.menuPosition = null;
    this.cdr.markForCheck();
  }

  public menuRename(track: Track): void {
    this.closeTrackMenu();
    this.startEditing(track);
  }

  public menuDownload(track: Track): void {
    this.closeTrackMenu();
    this.downloadTrack(track);
  }

  public removeTrack(track: Track): void {
    this.closeTrackMenu();
    this.audioSlicerService.removeTrack(track.id);
    this.cdr.markForCheck();
  }

  /** Ensures only one track player is active at a time. */
  public pauseOtherPlayers(event: Event): void {
    const current = event.target as HTMLAudioElement;
    document.querySelectorAll<HTMLAudioElement>('audio.html5-player').forEach(player => {
      if (player !== current) {
        player.pause();
      }
    });
  }

  // --- Effects, Presets & Audition ---
  public selectPreset(name: string): void {
    this.presets.select(name === '' ? null : name);
    this.audition.configChanged();
    this.cdr.markForCheck();
  }

  public updateEffect<K extends keyof EffectChainConfig>(kind: K, patch: Partial<EffectChainConfig[K]>): void {
    this.presets.updateSection(kind, patch);
    this.audition.configChanged();
    this.cdr.markForCheck();
  }

  public toggleEffect(kind: keyof EffectChainConfig): void {
    const current = this.presets.workingConfig()[kind];
    this.updateEffect(kind, { enabled: !current.enabled } as Partial<EffectChainConfig[typeof kind]>);
  }

  public savePreset(): void {
    const name = prompt('Save Preset as:', this.presets.selectedName() ?? 'My Preset');
    if (name && name.trim()) {
      this.presets.saveAsNew(name.trim());
      this.cdr.markForCheck();
    }
  }

  public deletePreset(name: string): void {
    this.presets.deleteUserPreset(name);
    this.cdr.markForCheck();
  }

  public async importPreset(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    const preset = this.presets.importFromJson(await file.text());
    if (!preset) {
      alert('That file is not a valid Preset JSON document.');
    }
    input.value = '';
    this.cdr.markForCheck();
  }

  public exportPresetFile(preset: Preset): void {
    const blob = new Blob([this.presets.exportJson(preset)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const element = document.createElement('a');
    element.href = url;
    element.download = `${preset.name.replace(/[^a-zA-Z0-9_\-\s]/g, '') || 'preset'}.json`;
    element.click();
    URL.revokeObjectURL(url);
  }

  public auditionTrack(track: Track): void {
    this.audition.audition(track.key);
    this.cdr.markForCheck();
  }

  public stopAudition(): void {
    this.audition.stop();
    this.cdr.markForCheck();
  }

  public toggleDryWet(): void {
    this.audition.toggleDryWet();
    this.cdr.markForCheck();
  }

  // --- Download / Export Helpers ---
  /** Downloads a Track, exporting it first if it hasn't been processed yet. */
  public async downloadTrack(track: Track): Promise<void> {
    this.exportError = null;
    if (track.status !== 'done' || !track.mp3Url) {
      try {
        await this.audioSlicerService.exportTrack(track.key, this.presets.workingConfig());
      } catch (error) {
        this.exportError = (error as Error).message;
        this.cdr.markForCheck();
        return;
      }
    }
    const fresh = this.audioSlicerService.getTracksValue().find(t => t.key === track.key);
    if (!fresh?.mp3Url || !fresh.mp3Blob) {
      return;
    }
    const element = document.createElement('a');
    element.href = fresh.mp3Url;
    const safeTitle = fresh.title.replace(/[^a-zA-Z0-9_\-\s]/g, '');
    element.download = `${safeTitle || 'Track'}.mp3`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
    this.cdr.markForCheck();
  }

  /** Exports every Track with the working config, then downloads them. */
  public async exportAndDownloadAll(): Promise<void> {
    if (this.tracks.length === 0 || this.exportingAll) {
      return;
    }
    this.exportingAll = true;
    this.exportError = null;
    this.cdr.markForCheck();
    try {
      await this.audioSlicerService.exportAll(this.presets.workingConfig());
      const done = this.audioSlicerService.getTracksValue().filter(t => t.status === 'done');
      done.forEach((track, index) => {
        setTimeout(() => this.downloadTrack(track), index * 400);
      });
    } catch (error) {
      this.exportError = (error as Error).message;
    } finally {
      this.exportingAll = false;
      this.cdr.markForCheck();
    }
  }

  public downloadAll(): void {
    void this.exportAndDownloadAll();
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
