import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { App } from './app';
import { AudioSlicerService, type Track } from './audio-slicer.service';
import { TranscriptionService, type PromptApiDiagnostics } from './transcription.service';
import { WebMcpService } from './webmcp.service';
import type { SlicerState } from '@web-audio-tools/audio-core';

function makeTrack(id: number): Track {
  return {
    key: id, id, title: `Track ${id}`, titleSource: 'default',
    startTime: 0, endTime: 10, duration: 10, mp3Bytes: null,
    mp3Blob: null, mp3Url: null, transcription: null, status: 'done'
  };
}

let fixture: ComponentFixture<App>;
let component: App;
let audioMock: { removeTrack: ReturnType<typeof vi.fn>; updateTrackTitle: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
let transcriptionMock: { saveApiKey: ReturnType<typeof vi.fn>; saveTranscriptionLanguage: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  const initialState: SlicerState = {
    status: 'idle', fileName: '', progress: 0, currentTime: 0,
    totalDurationEstimate: 0, dbLevel: -100, currentTrackId: null, currentStateName: 'SILENCE'
  };
  const diagnostics: PromptApiDiagnostics = { status: 'unsupported', detail: 'test', lastError: null };

  audioMock = {
    removeTrack: vi.fn(),
    updateTrackTitle: vi.fn(),
    reset: vi.fn(),
    state$: new BehaviorSubject(initialState).asObservable(),
    tracks$: new BehaviorSubject<Track[]>([makeTrack(1)]).asObservable(),
    segments$: new BehaviorSubject([]).asObservable(),
    volumeLevel$: new Subject<number>().asObservable(),
    thresholdDb: -45, minSilenceDuration: 2, minSongDuration: 8, mp3Bitrate: 192,
    preRollSec: 0.3, postRollSec: 0.5,
    sliceWavFile: vi.fn(async () => undefined),
    cancelSlicing: vi.fn()
  } as unknown as typeof audioMock;

  transcriptionMock = {
    saveApiKey: vi.fn(),
    saveTranscriptionLanguage: vi.fn(),
    getApiKey: () => '',
    getTranscriptionLanguage: () => 'auto',
    refreshPromptApiDiagnostics: vi.fn(async () => diagnostics),
    promptApiDiagnostics$: new BehaviorSubject(diagnostics).asObservable()
  } as unknown as typeof transcriptionMock;

  await TestBed.configureTestingModule({
    imports: [App],
    providers: [
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
  it('creates and loads initial settings', () => {
    expect(component).toBeTruthy();
    expect(component.thresholdDb).toBe(-45);
    expect(component.preRollSec).toBe(0.3);
  });

  it('saveSettings persists values to the services', () => {
    component.apiKey = 'my-key';
    component.transcriptionLanguage = 'de';
    component.thresholdDb = -50;
    component.saveSettings();
    expect(transcriptionMock.saveApiKey).toHaveBeenCalledWith('my-key');
    expect(transcriptionMock.saveTranscriptionLanguage).toHaveBeenCalledWith('de');
    expect(component.showSettings).toBe(false);
  });

  it('toggles the track menu and closes on document click', () => {
    const event = { stopPropagation: vi.fn() } as unknown as Event;
    component.toggleTrackMenu(1, event);
    expect(component.openMenuTrackId).toBe(1);
    expect(event.stopPropagation).toHaveBeenCalled();

    component.onDocumentClick();
    expect(component.openMenuTrackId).toBeNull();
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