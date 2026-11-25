import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { App } from './app';
import { AudioSlicerService, type Track } from './audio-slicer.service';
import { TranscriptionService, type PromptApiDiagnostics } from './transcription.service';
import { WebMcpService } from './webmcp.service';
import { CONFIG_STORE } from './config-store';
import { DEFAULT_SETTINGS } from './settings.service';
import type { ConfigStore, SlicerState } from '@web-audio-tools/audio-core';

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

function makeTrack(id: number): Track {
  return {
    key: id, id, title: `Track ${id}`, titleSource: 'default',
    startTime: 0, endTime: 10, duration: 10, mp3Bytes: null,
    mp3Blob: null, mp3Url: null, transcription: null, status: 'done'
  };
}

let fixture: ComponentFixture<App>;
let component: App;
let store: MemoryConfigStore;
let audioMock: { removeTrack: ReturnType<typeof vi.fn>; updateTrackTitle: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; sliceWavFile: ReturnType<typeof vi.fn> };
let transcriptionMock: { refreshPromptApiDiagnostics: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  const initialState: SlicerState = {
    status: 'idle', fileName: '', progress: 0, currentTime: 0,
    totalDurationEstimate: 0, dbLevel: -100, currentTrackId: null, currentStateName: 'SILENCE'
  };
  const diagnostics: PromptApiDiagnostics = { status: 'unsupported', detail: 'test', lastError: null };

  store = new MemoryConfigStore();

  audioMock = {
    removeTrack: vi.fn(),
    updateTrackTitle: vi.fn(),
    reset: vi.fn(),
    state$: new BehaviorSubject(initialState).asObservable(),
    tracks$: new BehaviorSubject<Track[]>([makeTrack(1)]).asObservable(),
    segments$: new BehaviorSubject([]).asObservable(),
    volumeLevel$: new Subject<number>().asObservable(),
    sliceWavFile: vi.fn(async () => undefined),
    cancelSlicing: vi.fn()
  } as unknown as typeof audioMock;

  transcriptionMock = {
    refreshPromptApiDiagnostics: vi.fn(async () => diagnostics),
    promptApiDiagnostics$: new BehaviorSubject(diagnostics).asObservable()
  } as unknown as typeof transcriptionMock;

  await TestBed.configureTestingModule({
    imports: [App],
    providers: [
      { provide: CONFIG_STORE, useValue: store },
      { provide: AudioSlicerService, useValue: audioMock },
      { provide: TranscriptionService, useValue: transcriptionMock },
      { provide: WebMcpService, useValue: { registerWebMcpTools: vi.fn() } }
    ]
  }).compileComponents();

  fixture = TestBed.createComponent(App);
  component = fixture.componentInstance;
  fixture.detectChanges();
  await fixture.whenStable();
});

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('App component', () => {
  it('creates and loads initial settings from the SettingsService', () => {
    expect(component).toBeTruthy();
    expect(component.thresholdDb).toBe(-45);
    expect(component.preRollSec).toBe(0.3);
    expect(component.settings.settings()).toEqual(DEFAULT_SETTINGS);
  });

  it('auto-saves setting changes immediately', () => {
    component.thresholdDb = -50;
    component.transcriptionLanguage = 'de';
    expect(component.settings.settings().thresholdDb).toBe(-50);
    expect(component.settings.settings().transcriptionLanguage).toBe('de');
    const persisted = JSON.parse(store.get('web_audio_slicer_settings') ?? '{}');
    expect(persisted.values.thresholdDb).toBe(-50);
    expect(persisted.values.transcriptionLanguage).toBe('de');
  });

  it('ignores invalid numeric input, keeping the last valid value', () => {
    component.minSilenceDuration = Number.NaN;
    expect(component.minSilenceDuration).toBe(2);
    expect(store.get('web_audio_slicer_settings')).toBeNull();
  });

  it('flags modified settings for the field dots and the header badge', () => {
    expect(component.settings.anyModified()).toBe(false);
    component.thresholdDb = -50;
    expect(component.settings.modified().thresholdDb).toBe(true);
    expect(component.settings.modified().minSilenceDuration).toBe(false);
    expect(component.settings.anyModified()).toBe(true);
  });

  it('reset is a no-op when nothing is modified', () => {
    component.requestResetToDefaults();
    expect(component.resetConfirmPending).toBe(false);
  });

  it('reset requires two clicks, restores defaults, and keeps the apiKey', () => {
    component.apiKey = 'my-key';
    component.thresholdDb = -50;

    component.requestResetToDefaults();
    expect(component.resetConfirmPending).toBe(true);
    expect(component.thresholdDb).toBe(-50);

    component.requestResetToDefaults();
    expect(component.resetConfirmPending).toBe(false);
    expect(component.thresholdDb).toBe(-45);
    expect(component.apiKey).toBe('my-key');
    expect(store.get('web_audio_slicer_settings')).toBeNull();
  });

  it('closing the drawer cancels a pending reset confirmation', () => {
    component.thresholdDb = -50;
    component.showSettings = true;
    component.requestResetToDefaults();
    expect(component.resetConfirmPending).toBe(true);
    component.closeSettings();
    expect(component.resetConfirmPending).toBe(false);
    expect(component.showSettings).toBe(false);
    expect(component.thresholdDb).toBe(-50);
  });

  it('reverts an invalid input display to the last valid value on blur', () => {
    const input = { value: '' } as HTMLInputElement;
    component.revertInvalidInput('minSilenceDuration', { target: input } as unknown as Event);
    expect(input.value).toBe('2');
  });

  it('startSlicing uses the persisted transcribe-speech-gaps setting', async () => {
    component.transcribeSpeechGapsOnStart = false;
    component.file = { name: 'test.wav' } as File;
    await component.startSlicing();
    expect(audioMock.sliceWavFile).toHaveBeenCalledWith(component.file, {
      transcribeSpeechGaps: false,
      trackStartIndex: 1
    });
  });

  it('toggles the track menu and closes on document click', () => {
    const event = {
      stopPropagation: vi.fn(),
      currentTarget: { getBoundingClientRect: () => ({ right: 400, bottom: 300, top: 270, left: 370 }) }
    } as unknown as Event;
    component.toggleTrackMenu(makeTrack(1), event);
    expect(component.openMenuTrackId).toBe(1);
    expect(component.menuTrack?.id).toBe(1);
    expect(component.menuPosition).not.toBeNull();
    expect(event.stopPropagation).toHaveBeenCalled();

    component.onDocumentClick();
    expect(component.openMenuTrackId).toBeNull();
    expect(component.menuTrack).toBeNull();
    expect(component.menuPosition).toBeNull();
  });

  it('removeTrack delegates to the service and closes the menu', () => {
    component.openMenuTrackId = 1;
    component.removeTrack(makeTrack(1));
    expect(audioMock.removeTrack).toHaveBeenCalledWith(1);
    expect(component.openMenuTrackId).toBeNull();
  });

  it('menuRename opens the editor for the track', () => {
    component.menuRename(makeTrack(1));
    expect(component.editingTrackId).toBe(1);
    expect(component.editingTitle).toBe('Track 1');
    expect(component.openMenuTrackId).toBeNull();
  });

  it('pauses other players when one starts playing', () => {
    const current = { pause: vi.fn() } as unknown as HTMLAudioElement;
    const other = { pause: vi.fn() } as unknown as HTMLAudioElement;
    const spy = vi.spyOn(document, 'querySelectorAll').mockReturnValue([current, other] as unknown as NodeListOf<HTMLAudioElement>);
    component.pauseOtherPlayers({ target: current } as unknown as Event);
    expect(other.pause).toHaveBeenCalled();
    expect(current.pause).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});