/**
 * Platform-agnostic slicing pipeline: WAV stream parsing, the SILENCE/SONG
 * hysteresis state machine, and speech-gap transcription (via a transcription
 * port). Detection only — it finds Track boundaries and prepares gaps; it does
 * NOT encode. Effects and MP3 encoding happen later, on demand, in processing.ts
 * (the shared Audition/Export path). No Angular, DOM, Worker, or Node APIs are
 * referenced here — those live in adapters at the seams.
 */
import type {
  AudioInput,
  Scheduler,
  SlicerObserver,
  TranscriptionPort
} from './ports';
import {
  DEFAULT_SLICER_PARAMETERS,
  type SilenceSegment,
  type SliceOptions,
  type SliceResult,
  type SlicerParameters,
  type SlicerState,
  type TitleSource,
  type Track
} from './types';
import { WavStreamParser, calculateRms, createWavBytes, prepareSpeechAudio, rmsToDb } from './wav';

export interface SlicerDeps {
  transcription?: TranscriptionPort | null;
  observer?: SlicerObserver;
  scheduler?: Scheduler;
}

const defaultScheduler: Scheduler = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  yield: () => new Promise<void>(resolve => setTimeout(resolve, 0))
};

export class Slicer {
  public parameters: SlicerParameters = { ...DEFAULT_SLICER_PARAMETERS };

  /** Mutable so hosts can switch between embedded and calling-model transcription. */
  public transcription: TranscriptionPort | null;
  private readonly observer: SlicerObserver;
  private readonly scheduler: Scheduler;

  private tracks: Track[] = [];
  private segments: SilenceSegment[] = [];
  private state: SlicerState = this.initialState('');
  private cancelRequested = false;
  private pendingTranscriptions: Array<Promise<void>> = [];

  constructor(deps: SlicerDeps = {}) {
    this.transcription = deps.transcription ?? null;
    this.observer = deps.observer ?? {};
    this.scheduler = deps.scheduler ?? defaultScheduler;
  }

  public getTracksValue(): Track[] {
    return this.tracks;
  }

  public getSegmentsValue(): SilenceSegment[] {
    return this.segments;
  }

  public getStateValue(): SlicerState {
    return this.state;
  }

  public cancel(): void {
    this.cancelRequested = true;
  }

  public updateTrackTitle(trackId: number, title: string, titleSource: TitleSource = 'manual'): void {
    const track = this.tracks.find(t => t.id === trackId);
    if (track) {
      track.title = title;
      track.titleSource = titleSource;
      this.observer.onTrackUpdated?.(track);
    }
  }

  public updateTrackTitleByKey(trackKey: number, title: string, titleSource: TitleSource = 'manual'): void {
    const track = this.tracks.find(t => t.key === trackKey);
    if (track) {
      track.title = title;
      track.titleSource = titleSource;
      this.observer.onTrackUpdated?.(track);
    }
  }

  /** Removes a track the user doesn't want (e.g. a misdetected region). */
  public removeTrackById(trackId: number): void {
    const track = this.tracks.find(t => t.id === trackId);
    if (track) {
      this.removeTrack(track.key);
    }
  }

  /** Marks a detected Track as being processed/encoded by the Export stage. */
  public setTrackStatus(trackKey: number, status: Track['status']): void {
    const track = this.tracks.find(t => t.key === trackKey);
    if (track) {
      track.status = status;
      this.observer.onTrackUpdated?.(track);
    }
  }

  /**
   * Records the result of the on-demand Export stage onto a detected Track.
   * The Track's boundaries stay the sliced truth; the encoded audio may ring
   * past them (reverb tail), so the processed duration is reported separately.
   */
  public applyExportResult(trackKey: number, mp3Bytes: Uint8Array | null, processedDurationSec?: number): void {
    const track = this.tracks.find(t => t.key === trackKey);
    if (!track) {
      return;
    }
    track.mp3Bytes = mp3Bytes;
    track.status = mp3Bytes ? 'done' : 'failed';
    if (processedDurationSec !== undefined) {
      track.processedDuration = processedDurationSec;
    }
    this.observer.onTrackUpdated?.(track);
  }

  public async run(input: AudioInput, options: SliceOptions = {}): Promise<SliceResult> {
    this.reset(options.fileName ?? '');
    this.cancelRequested = false;

    const transcribeSpeechGaps = options.transcribeSpeechGaps ?? true;
    const trackStartIndex = this.normalizeTrackStartIndex(options.trackStartIndex);

    const bytesPerSecond = 44100 * 2 * 2;
    const fileSizeHint = options.fileSizeBytes ?? 0;
    let estimatedDuration = fileSizeHint > 0 ? fileSizeHint / bytesPerSecond : 0;
    let durationEstimateUpdated = false;
    this.patchState({ totalDurationEstimate: estimatedDuration });

    let currentState: 'SILENCE' | 'SONG' = 'SILENCE';
    let sampleRate = 44100;
    let numChannels = 2;
    let totalSamplesProcessed = 0;

    let trackKeyCounter = 0;
    let nextTrackIndex = trackStartIndex;
    let currentSongTrack: Track | null = null;
    let songStartSec = 0;
    const getCurrentSongTrack = (): Track | null => currentSongTrack;

    let silenceSegmentCounter = 0;
    let currentSilenceBuffer: Float32Array[][] = [];
    let silenceStartSec = 0;

    let pendingSilenceBuffer: Float32Array[][] = [];
    let silenceTimerSec = 0;
    let silenceDropStartSec = 0;

    let shortSongBuffer: Float32Array[][] = [];
    let shortSongBufferSec = 0;
    let shortSongBufferComplete = false;

    const captureShortSongWindow = (windowChannels: Float32Array[], windowDuration: number): void => {
      if (shortSongBufferComplete) {
        return;
      }
      shortSongBuffer = this.appendChannelChunks(shortSongBuffer, windowChannels);
      shortSongBufferSec += windowDuration;
      if (shortSongBufferSec >= this.parameters.minSongDuration) {
        shortSongBuffer = [];
        shortSongBufferComplete = true;
      }
    };

    // Rolling pre-roll buffer: the most recent preRollSec of audio, updated after
    // each window. At a song start it holds the quiet attack just before the
    // threshold crossing, so the piece's fade-in isn't cut off.
    let preRoll: Float32Array[] = [];
    const appendPreRoll = (windowChannels: Float32Array[]): void => {
      const maxSamples = Math.round(this.parameters.preRollSec * sampleRate);
      if (maxSamples <= 0) {
        preRoll = [];
        return;
      }
      preRoll = windowChannels.map((channel, c) => {
        const existing = preRoll[c] ?? new Float32Array(0);
        const combined = new Float32Array(existing.length + channel.length);
        combined.set(existing);
        combined.set(channel, existing.length);
        return combined.length > maxSamples ? combined.subarray(combined.length - maxSamples) : combined;
      });
    };

    const windowSize = 8192;
    let analysisLeftover: Float32Array[] = [];
    let lastUiUpdateTick = 0;
    let pendingUiDb = -100;
    let pendingUiCurrentTime = 0;
    let windowsProcessedSinceYield = 0;
    let lastYieldTick = this.scheduler.now();

    const flushUiUpdate = (force = false): void => {
      const now = this.scheduler.now();
      if (!force && now - lastUiUpdateTick < 50) {
        return;
      }
      lastUiUpdateTick = now;
      this.observer.onVolume?.(pendingUiDb);
      this.patchState({
        currentTime: pendingUiCurrentTime,
        dbLevel: pendingUiDb,
        progress: estimatedDuration > 0 ? Math.min(100, Math.round((pendingUiCurrentTime / estimatedDuration) * 100)) : 0
      });
    };

    const processWindow = async (windowChannels: Float32Array[]): Promise<void> => {
      const windowSampleCount = windowChannels[0]?.length ?? 0;
      if (windowSampleCount === 0) {
        return;
      }

      const windowDuration = windowSampleCount / sampleRate;
      let rms = 0;
      for (const channel of windowChannels) {
        rms = Math.max(rms, calculateRms(channel));
      }
      const db = rmsToDb(rms);
      const currentTime = totalSamplesProcessed / sampleRate;
      const progressTime = (totalSamplesProcessed + windowSampleCount) / sampleRate;

      pendingUiDb = db;
      pendingUiCurrentTime = progressTime;
      flushUiUpdate();
      totalSamplesProcessed += windowSampleCount;

      if (currentState === 'SILENCE') {
        if (db > this.parameters.thresholdDb) {
          currentState = 'SONG';
          this.patchState({ currentStateName: 'SONG' });

          if (this.hasChannelChunks(currentSilenceBuffer)) {
            const silenceEndSec = currentTime;
            const silenceDuration = silenceEndSec - silenceStartSec;
            if (silenceDuration > 0.5) {
              silenceSegmentCounter++;
              const segment: SilenceSegment = {
                id: silenceSegmentCounter,
                startTime: silenceStartSec,
                endTime: silenceEndSec,
                duration: silenceDuration,
                text: null,
                status: 'transcribing'
              };
              this.registerSilenceSegment(segment, this.mergeChannelChunks(currentSilenceBuffer), sampleRate, trackKeyCounter + 1, transcribeSpeechGaps);
            }
          }

          currentSilenceBuffer = [];
          trackKeyCounter++;
          const preRollDuration = (preRoll[0]?.length ?? 0) / sampleRate;
          songStartSec = currentTime - preRollDuration;
          currentSongTrack = {
            key: trackKeyCounter,
            id: nextTrackIndex,
            title: `Track ${nextTrackIndex}`,
            titleSource: 'default',
            startTime: songStartSec,
            endTime: 0,
            duration: 0,
            mp3Bytes: null,
            transcription: null,
            status: 'pending'
          };

          this.tracks.push(currentSongTrack);
          this.observer.onTrackAdded?.(currentSongTrack);
          this.patchState({ currentTrackId: currentSongTrack.id });

          shortSongBuffer = this.createChannelChunkBuffers(numChannels);
          shortSongBufferSec = 0;
          shortSongBufferComplete = false;
          captureShortSongWindow(windowChannels, windowDuration);
        } else {
          if (currentSilenceBuffer.length === 0) {
            silenceStartSec = currentTime;
            currentSilenceBuffer = this.createChannelChunkBuffers(numChannels);
          }
          currentSilenceBuffer = this.appendChannelChunks(currentSilenceBuffer, windowChannels);
        }
      } else if (currentState === 'SONG') {
        if (db < this.parameters.thresholdDb) {
          if (silenceTimerSec === 0) {
            silenceDropStartSec = currentTime;
            pendingSilenceBuffer = this.createChannelChunkBuffers(numChannels);
          }

          pendingSilenceBuffer = this.appendChannelChunks(pendingSilenceBuffer, windowChannels);
          captureShortSongWindow(windowChannels, windowDuration);
          silenceTimerSec += windowDuration;

          if (silenceTimerSec >= this.parameters.minSilenceDuration) {
            currentState = 'SILENCE';
            this.patchState({ currentStateName: 'SILENCE', currentTrackId: null });

            const songEndSec = silenceDropStartSec;
            const songDuration = songEndSec - songStartSec;
            let appliedPostRollSec = 0;

            if (songDuration >= this.parameters.minSongDuration && currentSongTrack) {
              // Post-roll: keep the quiet decay right after the level drop so the
              // piece's fade-out isn't cut. Steal it from the pending silence so
              // the next gap doesn't also contain it.
              const postRollSamples = Math.round(this.parameters.postRollSec * sampleRate);
              if (postRollSamples > 0 && this.hasChannelChunks(pendingSilenceBuffer)) {
                const mergedPending = this.mergeChannelChunks(pendingSilenceBuffer);
                const take = Math.min(postRollSamples, mergedPending[0].length);
                appliedPostRollSec = take / sampleRate;
                pendingSilenceBuffer = mergedPending.map(ch => {
                  const rest = ch.subarray(take);
                  const copy = new Float32Array(rest.length);
                  copy.set(rest);
                  return [copy];
                });
              }
              currentSongTrack.endTime = songEndSec + appliedPostRollSec;
              currentSongTrack.duration = currentSongTrack.endTime - songStartSec;
              nextTrackIndex++;
              this.observer.onTrackUpdated?.(currentSongTrack);
            } else if (currentSongTrack) {
              if (!shortSongBufferComplete && songDuration > 0.5 && this.hasChannelChunks(shortSongBuffer)) {
                silenceSegmentCounter++;
                const segment: SilenceSegment = {
                  id: silenceSegmentCounter,
                  startTime: songStartSec,
                  endTime: songEndSec,
                  duration: songDuration,
                  text: null,
                  status: 'transcribing'
                };
                this.registerSilenceSegment(segment, this.mergeChannelChunks(shortSongBuffer), sampleRate, trackKeyCounter + 1, transcribeSpeechGaps);
              }
              this.removeTrack(currentSongTrack.key);
            }

            shortSongBuffer = [];
            shortSongBufferSec = 0;
            shortSongBufferComplete = false;
            currentSongTrack = null;

            silenceStartSec = silenceDropStartSec + appliedPostRollSec;
            currentSilenceBuffer = pendingSilenceBuffer;
            pendingSilenceBuffer = [];
            silenceTimerSec = 0;
          }
        } else {
          if (silenceTimerSec > 0) {
            pendingSilenceBuffer = [];
            silenceTimerSec = 0;
          }
          captureShortSongWindow(windowChannels, windowDuration);
        }
      }

      appendPreRoll(windowChannels);
    };

    try {
      const parser = new WavStreamParser();

      for await (const chunk of input) {
        if (this.cancelRequested) {
          break;
        }

        const parsedChannels = parser.feed(chunk);

        if (parser.header) {
          sampleRate = parser.header.sampleRate;
          numChannels = parser.header.channels;
          if (!durationEstimateUpdated) {
            const headerBytesPerSecond = parser.header.sampleRate * parser.header.channels * (parser.header.bitsPerSample / 8);
            if (headerBytesPerSecond > 0 && fileSizeHint > 0) {
              estimatedDuration = fileSizeHint / headerBytesPerSecond;
              durationEstimateUpdated = true;
              this.patchState({ totalDurationEstimate: estimatedDuration });
            }
          }
        }

        if (parsedChannels && parsedChannels.length > 0) {
          const aligned = this.alignBufferWindows(analysisLeftover, parsedChannels, windowSize);
          analysisLeftover = aligned.leftover;
          const samplesToAnalyze = aligned.ready;

          if (samplesToAnalyze.length > 0 && samplesToAnalyze[0].length > 0) {
            const numWindows = Math.floor(samplesToAnalyze[0].length / windowSize);
            for (let w = 0; w < numWindows; w++) {
              const startIdx = w * windowSize;
              const endIdx = startIdx + windowSize;
              const windowChannels: Float32Array[] = [];
              for (let c = 0; c < numChannels; c++) {
                windowChannels.push(samplesToAnalyze[c].subarray(startIdx, endIdx));
              }

              await processWindow(windowChannels);
              windowsProcessedSinceYield++;

              if (windowsProcessedSinceYield >= 8 || this.scheduler.now() - lastYieldTick >= 8) {
                flushUiUpdate(true);
                await this.scheduler.yield();
                lastYieldTick = this.scheduler.now();
                windowsProcessedSinceYield = 0;
              }
            }
          }
        }
      }

      const finalChannels = parser.flush();
      if (finalChannels && finalChannels.length > 0) {
        const aligned = this.alignBufferWindows(analysisLeftover, finalChannels, windowSize);
        analysisLeftover = aligned.leftover;
        if (aligned.ready.length > 0 && aligned.ready[0].length > 0) {
          const numWindows = Math.floor(aligned.ready[0].length / windowSize);
          for (let w = 0; w < numWindows; w++) {
            const startIdx = w * windowSize;
            const windowChannels: Float32Array[] = [];
            for (let c = 0; c < numChannels; c++) {
              windowChannels.push(aligned.ready[c].subarray(startIdx, startIdx + windowSize));
            }
            await processWindow(windowChannels);
          }
        }
      }

      if (analysisLeftover.length > 0 && analysisLeftover[0].length > 0) {
        await processWindow(analysisLeftover);
        analysisLeftover = [];
      }

      flushUiUpdate(true);

      const currentTime = totalSamplesProcessed / sampleRate;
      const openSongTrack = getCurrentSongTrack();
      if (openSongTrack) {
        openSongTrack.endTime = currentTime;
        openSongTrack.duration = currentTime - songStartSec;
        nextTrackIndex++;
        this.observer.onTrackUpdated?.(openSongTrack);
        currentSongTrack = null;
      } else if (currentState === 'SILENCE' && this.hasChannelChunks(currentSilenceBuffer)) {
        const silenceDuration = currentTime - silenceStartSec;
        if (silenceDuration > 0.5) {
          silenceSegmentCounter++;
          const segment: SilenceSegment = {
            id: silenceSegmentCounter,
            startTime: silenceStartSec,
            endTime: currentTime,
            duration: silenceDuration,
            text: null,
            status: 'transcribing'
          };
          this.registerSilenceSegment(segment, this.mergeChannelChunks(currentSilenceBuffer), sampleRate, trackKeyCounter + 1, transcribeSpeechGaps);
        }
      }

      await Promise.all(this.pendingTranscriptions);
    } catch (error) {
      console.error('Error during slicing:', error);
      this.patchState({ status: 'idle' });
      throw error;
    } finally {
      this.patchState({ status: 'done', dbLevel: -100 });
    }

    return { tracks: this.tracks, segments: this.segments, state: this.state };
  }

  // --- internals ---

  private initialState(fileName: string): SlicerState {
    return {
      status: 'idle',
      fileName,
      progress: 0,
      currentTime: 0,
      totalDurationEstimate: 0,
      dbLevel: -100,
      currentTrackId: null,
      currentStateName: 'SILENCE'
    };
  }

  private reset(fileName: string): void {
    this.tracks = [];
    this.segments = [];
    this.pendingTranscriptions = [];
    this.state = { ...this.initialState(fileName), status: 'slicing' };
    this.observer.onState?.(this.state);
  }

  private patchState(patch: Partial<SlicerState>): void {
    this.state = { ...this.state, ...patch };
    this.observer.onState?.(this.state);
  }

  private removeTrack(trackKey: number): void {
    this.tracks = this.tracks.filter(t => t.key !== trackKey);
    this.observer.onTrackRemoved?.(trackKey);
  }

  private setSegmentStatus(segmentId: number, status: SilenceSegment['status'], text: string | null): void {
    const segment = this.segments.find(s => s.id === segmentId);
    if (segment) {
      segment.status = status;
      segment.text = text;
      this.observer.onSegmentUpdated?.(segment);
    }
  }

  private registerSilenceSegment(
    segment: SilenceSegment,
    pcmBuffer: Float32Array[],
    sampleRate: number,
    targetTrackKey: number,
    transcribeSpeechGaps: boolean
  ): void {
    if (!transcribeSpeechGaps) {
      segment.status = 'skipped';
      segment.text = 'Transcription disabled for this analysis run.';
      this.segments.push(segment);
      this.observer.onSegmentAdded?.(segment);
      return;
    }

    const speechAudio = prepareSpeechAudio(pcmBuffer, sampleRate);
    if (!speechAudio) {
      segment.status = 'skipped';
      segment.text = 'No audible speech detected in this gap.';
      this.segments.push(segment);
      this.observer.onSegmentAdded?.(segment);
      return;
    }

    segment.speechWav = createWavBytes([speechAudio.samples], speechAudio.sampleRate);
    segment.speechSampleRate = speechAudio.sampleRate;
    this.segments.push(segment);
    this.observer.onSegmentAdded?.(segment);

    if (!this.transcription) {
      // No embedded provider: leave the prepared audio for an external
      // transcriber (e.g. the calling model in the tool layer).
      segment.status = 'idle';
      this.observer.onSegmentUpdated?.(segment);
      return;
    }

    this.pendingTranscriptions.push(this.transcribeSegment(segment, targetTrackKey));
  }

  private async transcribeSegment(segment: SilenceSegment, targetTrackKey: number): Promise<void> {
    const wavBytes = segment.speechWav;
    const sampleRate = segment.speechSampleRate ?? 16000;
    if (!wavBytes) {
      return;
    }

    try {
      if (!this.transcription || !(await this.transcription.hasProvider())) {
        this.setSegmentStatus(segment.id, 'skipped', 'Transcription skipped: no transcription provider is available.');
        return;
      }

      const text = await this.transcription.transcribeAudio(wavBytes, sampleRate);
      if (text === null) {
        this.setSegmentStatus(segment.id, 'skipped', 'Transcription skipped: provider could not transcribe this gap.');
        return;
      }

      this.setSegmentStatus(segment.id, 'done', text);

      const track = this.tracks.find(t => t.key === targetTrackKey);
      if (track) {
        track.transcription = text;
        this.observer.onTrackUpdated?.(track);
      }

      const extractedTitle = await this.transcription.extractSongTitle(text);
      if (extractedTitle) {
        const target = this.tracks.find(t => t.key === targetTrackKey);
        if (target && target.titleSource !== 'manual') {
          this.updateTrackTitleByKey(targetTrackKey, extractedTitle.title, extractedTitle.source);
        }
      }
    } catch (error) {
      console.error(`Failed to transcribe segment ${segment.id}:`, error);
      this.setSegmentStatus(segment.id, 'failed', error instanceof Error ? error.message : 'Transcription failed');
    }
  }

  private normalizeTrackStartIndex(value: number | undefined): number {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.max(1, Math.floor(value ?? 1));
  }

  private alignBufferWindows(leftover: Float32Array[], incoming: Float32Array[], windowSize: number): { ready: Float32Array[]; leftover: Float32Array[] } {
    const combinedChannels = incoming.map((channel, index) => {
      const existingLeftover = leftover[index];
      if (!existingLeftover || existingLeftover.length === 0) {
        return channel;
      }
      const combined = new Float32Array(existingLeftover.length + channel.length);
      combined.set(existingLeftover);
      combined.set(channel, existingLeftover.length);
      return combined;
    });

    if (combinedChannels.length === 0 || combinedChannels[0].length === 0) {
      return { ready: [], leftover: [] };
    }

    const readyLength = combinedChannels[0].length - (combinedChannels[0].length % windowSize);
    if (readyLength <= 0) {
      return {
        ready: [],
        leftover: combinedChannels.map(channel => {
          const copy = new Float32Array(channel.length);
          copy.set(channel);
          return copy;
        })
      };
    }

    const newLeftoverLength = combinedChannels[0].length - readyLength;
    return {
      ready: combinedChannels.map(channel => channel.subarray(0, readyLength)),
      leftover: newLeftoverLength > 0
        ? combinedChannels.map(channel => {
            const remainder = channel.subarray(readyLength);
            const copy = new Float32Array(remainder.length);
            copy.set(remainder);
            return copy;
          })
        : []
    };
  }

  private createChannelChunkBuffers(channelCount: number): Float32Array[][] {
    return Array.from({ length: channelCount }, () => [] as Float32Array[]);
  }

  private appendChannelChunks(dest: Float32Array[][], source: Float32Array[]): Float32Array[][] {
    const target = dest.length > 0 ? dest : this.createChannelChunkBuffers(source.length);
    for (let c = 0; c < source.length; c++) {
      const copy = new Float32Array(source[c].length);
      copy.set(source[c]);
      target[c].push(copy);
    }
    return target;
  }

  private hasChannelChunks(chunks: Float32Array[][]): boolean {
    return chunks.length > 0 && chunks[0].length > 0;
  }

  private mergeChannelChunks(chunks: Float32Array[][]): Float32Array[] {
    return chunks.map(channelChunks => {
      const totalLength = channelChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of channelChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return merged;
    });
  }
}