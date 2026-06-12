import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { WavStreamParser, calculateRms, rmsToDb, createWavBlob } from './audio-helper';
import { TranscriptionService } from './transcription.service';

export interface Track {
  id: number;
  title: string;
  startTime: number;
  endTime: number;
  duration: number;
  mp3Blob: Blob | null;
  mp3Url: string | null;
  transcription: string | null;
  status: 'pending' | 'encoding' | 'done' | 'failed';
}

export interface SilenceSegment {
  id: number;
  startTime: number;
  endTime: number;
  duration: number;
  text: string | null;
  status: 'idle' | 'transcribing' | 'done' | 'failed';
}

export interface SlicerState {
  status: 'idle' | 'slicing' | 'done';
  fileName: string;
  progress: number;
  currentTime: number;
  totalDurationEstimate: number;
  dbLevel: number;
  currentTrackId: number | null;
  currentStateName: 'SILENCE' | 'SONG';
}

@Injectable({
  providedIn: 'root'
})
export class AudioSlicerService {
  // Slicing parameters (user customizable)
  public thresholdDb = -45; // Volume threshold for silence (dB)
  public minSilenceDuration = 2.0; // Minimum silence duration to trigger split (s)
  public minSongDuration = 8.0; // Minimum song duration to save (s)
  public mp3Bitrate = 192; // MP3 bitrate (kbps)

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

  private activeWorker: Worker | null = null;
  private cancelRequested = false;
  private workerQueueDepth = 0;
  private workerCapacityWaiters: Array<() => void> = [];
  private readonly maxWorkerQueueDepth = 8;

  constructor(
    private transcriptionService: TranscriptionService
  ) {}

  public getTracksValue(): Track[] {
    return this.tracks.getValue();
  }

  public getSegmentsValue(): SilenceSegment[] {
    return this.segments.getValue();
  }

  public updateTrackTitle(trackId: number, title: string): void {
    const currentTracks = this.tracks.getValue();
    const updatedTracks = currentTracks.map(t => t.id === trackId ? { ...t, title } : t);
    this.tracks.next(updatedTracks);
  }

  public cancelSlicing(): void {
    this.cancelRequested = true;
  }

  /**
   * Resets the entire slicer state.
   */
  public reset(): void {
    this.cancelRequested = false;
    this.tracks.next([]);
    this.segments.next([]);
    if (this.activeWorker) {
      this.activeWorker.terminate();
      this.activeWorker = null;
    }
    this.resetWorkerFlowControl();
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
   * Main slicing entry point. Streams a WAV file and splits it.
   */
  public async sliceWavFile(file: File): Promise<void> {
    this.reset();
    this.state.next({
      ...this.state.getValue(),
      status: 'slicing',
      fileName: file.name
    });

    // Estimate duration: 16-bit stereo 44.1kHz WAV has ~176400 bytes/sec
    const bytesPerSecond = 44100 * 2 * 2;
    let estimatedDuration = file.size / bytesPerSecond;
    let durationEstimateUpdated = false;
    this.state.next({
      ...this.state.getValue(),
      totalDurationEstimate: estimatedDuration
    });

    const stream = file.stream();
    const reader = stream.getReader();
    const parser = new WavStreamParser();

    // Hysteresis State Machine Variables
    let currentState: 'SILENCE' | 'SONG' = 'SILENCE';
    let sampleRate = 44100;
    let numChannels = 2;

    let totalSamplesProcessed = 0;
    
    // Song accumulation worker state
    let songTrackCounter = 0;
    let currentSongTrack: Track | null = null;
    let songStartSec = 0;
    const getCurrentSongTrack = (): Track | null => currentSongTrack;

    // Silence accumulation state
    let silenceSegmentCounter = 0;
    let currentSilenceBuffer: Float32Array[][] = [];
    let silenceStartSec = 0;

    // Lookahead buffer for potential silence (when in SONG state and volume drops)
    let pendingSilenceBuffer: Float32Array[][] = [];
    let silenceTimerSec = 0;
    let silenceDropStartSec = 0;

    // RMS analysis window settings
    const windowSize = 8192; // ~185ms at 44.1kHz
    let analysisLeftover: Float32Array[] = [];
    let lastUiUpdateTick = 0;
    let pendingUiDb = -100;
    let pendingUiCurrentTime = 0;
    let windowsProcessedSinceYield = 0;
    let lastYieldTick = this.getNow();

    const flushUiUpdate = (force = false): void => {
      const now = this.getNow();
      if (!force && now - lastUiUpdateTick < 50) {
        return;
      }

      lastUiUpdateTick = now;
      this.volumeLevel.next(pendingUiDb);
      this.state.next({
        ...this.state.getValue(),
        currentTime: pendingUiCurrentTime,
        dbLevel: pendingUiDb,
        progress: Math.min(100, Math.round((pendingUiCurrentTime / estimatedDuration) * 100))
      });
    };

    const processWindow = (windowChannels: Float32Array[]): void => {
      const windowSampleCount = windowChannels[0]?.length ?? 0;
      if (windowSampleCount === 0) {
        return;
      }

      const windowDuration = windowSampleCount / sampleRate;
      const rms = calculateRms(windowChannels[0]); // Analyze left channel for silence
      const db = rmsToDb(rms);
      const currentTime = totalSamplesProcessed / sampleRate;
      const progressTime = (totalSamplesProcessed + windowSampleCount) / sampleRate;

      pendingUiDb = db;
      pendingUiCurrentTime = progressTime;
      flushUiUpdate();

      totalSamplesProcessed += windowSampleCount;

      if (currentState === 'SILENCE') {
        if (db > this.thresholdDb) {
          currentState = 'SONG';
          this.state.next({
            ...this.state.getValue(),
            currentStateName: 'SONG'
          });

          if (this.hasChannelChunks(currentSilenceBuffer)) {
            const silenceEndSec = currentTime;
            const silenceDuration = silenceEndSec - silenceStartSec;

            if (silenceDuration > 0.5) {
              silenceSegmentCounter++;
              const segmentId = silenceSegmentCounter;
              const segment: SilenceSegment = {
                id: segmentId,
                startTime: silenceStartSec,
                endTime: silenceEndSec,
                duration: silenceDuration,
                text: null,
                status: 'transcribing'
              };

              const current = this.segments.getValue();
              this.segments.next([...current, segment]);

              this.transcribeSegmentInBackground(
                segment,
                this.mergeChannelChunks(currentSilenceBuffer),
                sampleRate,
                songTrackCounter + 1
              );
            }
          }

          currentSilenceBuffer = [];

          songTrackCounter++;
          songStartSec = currentTime;
          currentSongTrack = {
            id: songTrackCounter,
            title: `Track ${songTrackCounter}`,
            startTime: songStartSec,
            endTime: 0,
            duration: 0,
            mp3Blob: null,
            mp3Url: null,
            transcription: null,
            status: 'encoding'
          };

          const current = this.tracks.getValue();
          this.tracks.next([...current, currentSongTrack!]);
          this.state.next({
            ...this.state.getValue(),
            currentTrackId: currentSongTrack!.id
          });

          this.initMp3Worker(this.getMp3ExportChannelCount(numChannels), sampleRate, currentSongTrack.id);
          this.feedSamplesToWorker(windowChannels);
        } else {
          if (currentSilenceBuffer.length === 0) {
            silenceStartSec = currentTime;
            currentSilenceBuffer = this.createChannelChunkBuffers(numChannels);
          }
          currentSilenceBuffer = this.appendChannelChunks(currentSilenceBuffer, windowChannels);
        }
      } else if (currentState === 'SONG') {
        if (db < this.thresholdDb) {
          if (silenceTimerSec === 0) {
            silenceDropStartSec = currentTime;
            pendingSilenceBuffer = this.createChannelChunkBuffers(numChannels);
          }

          pendingSilenceBuffer = this.appendChannelChunks(pendingSilenceBuffer, windowChannels);
          silenceTimerSec += windowDuration;

          if (silenceTimerSec >= this.minSilenceDuration) {
            currentState = 'SILENCE';
            this.state.next({
              ...this.state.getValue(),
              currentStateName: 'SILENCE',
              currentTrackId: null
            });

            const songEndSec = silenceDropStartSec;
            const songDuration = songEndSec - songStartSec;

            if (songDuration >= this.minSongDuration && currentSongTrack) {
              currentSongTrack.endTime = songEndSec;
              currentSongTrack.duration = songDuration;
              this.finishMp3Worker(currentSongTrack.id);
            } else if (currentSongTrack) {
              this.discardCurrentTrack(currentSongTrack.id);
            }

            currentSongTrack = null;

            silenceStartSec = silenceDropStartSec;
            currentSilenceBuffer = pendingSilenceBuffer;
            pendingSilenceBuffer = [];
            silenceTimerSec = 0;
          }
        } else {
          if (silenceTimerSec > 0) {
            this.feedSamplesToWorker(this.mergeChannelChunks(pendingSilenceBuffer));
            pendingSilenceBuffer = [];
            silenceTimerSec = 0;
          }

          this.feedSamplesToWorker(windowChannels);
        }
      }
    };

    try {
      while (true) {
        if (this.cancelRequested) {
          reader.releaseLock();
          break;
        }

        const { done, value } = await reader.read();
        
        // Feed chunk to parser
        let parsedChannels: Float32Array[] | null = null;
        if (value) {
          parsedChannels = parser.feed(value);
        } else if (done) {
          parsedChannels = parser.flush();
        }

        if (parser.header) {
          sampleRate = parser.header.sampleRate;
          numChannels = parser.header.channels;

          if (!durationEstimateUpdated) {
            const headerBytesPerSecond = parser.header.sampleRate * parser.header.channels * (parser.header.bitsPerSample / 8);
            if (headerBytesPerSecond > 0) {
              estimatedDuration = file.size / headerBytesPerSecond;
              durationEstimateUpdated = true;
              this.state.next({
                ...this.state.getValue(),
                totalDurationEstimate: estimatedDuration
              });
            }
          }
        }

        if (parsedChannels && parsedChannels.length > 0) {
          // 1. Accumulate parsed samples for analysis window alignment
          const alignedChannels = this.alignBufferWindows(analysisLeftover, parsedChannels, windowSize);
          analysisLeftover = alignedChannels.leftover;
          const samplesToAnalyze = alignedChannels.ready;

          if (samplesToAnalyze.length > 0 && samplesToAnalyze[0].length > 0) {
            const numWindows = Math.floor(samplesToAnalyze[0].length / windowSize);

            for (let w = 0; w < numWindows; w++) {
              await this.waitForWorkerCapacity();

              const startIdx = w * windowSize;
              const endIdx = startIdx + windowSize;

              // Extract sample window for each channel
              const windowChannels: Float32Array[] = [];
              for (let c = 0; c < numChannels; c++) {
                windowChannels.push(samplesToAnalyze[c].subarray(startIdx, endIdx));
              }

              processWindow(windowChannels);
              windowsProcessedSinceYield++;

              if (windowsProcessedSinceYield >= 8 || this.getNow() - lastYieldTick >= 8) {
                flushUiUpdate(true);
                await this.yieldToMainThread();
                lastYieldTick = this.getNow();
                windowsProcessedSinceYield = 0;
              }
            }
          }
        }

        if (done) {
          break;
        }
      }

      if (analysisLeftover.length > 0 && analysisLeftover[0].length > 0) {
        await this.waitForWorkerCapacity();
        processWindow(analysisLeftover);
        analysisLeftover = [];
      }

      flushUiUpdate(true);

      // --- Handle End of Stream ---
      const currentTime = totalSamplesProcessed / sampleRate;
      const openSongTrack = getCurrentSongTrack();

      if (openSongTrack) {
        // Feed any pending silence lookahead buffer (since stream ended, we include it all)
        if (silenceTimerSec > 0 && this.hasChannelChunks(pendingSilenceBuffer)) {
          await this.waitForWorkerCapacity();
          this.feedSamplesToWorker(this.mergeChannelChunks(pendingSilenceBuffer));
        }
        
        openSongTrack.endTime = currentTime;
        openSongTrack.duration = currentTime - songStartSec;
        this.finishMp3Worker(openSongTrack.id);
      } else if (currentState === 'SILENCE' && this.hasChannelChunks(currentSilenceBuffer)) {
        // Transcribe final silence segment
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

          const current = this.segments.getValue();
          this.segments.next([...current, segment]);

          this.transcribeSegmentInBackground(
            segment,
            this.mergeChannelChunks(currentSilenceBuffer),
            sampleRate,
            songTrackCounter + 1
          );
        }
      }

    } catch (error) {
      console.error('Error during slicing:', error);
      this.state.next({
        ...this.state.getValue(),
        status: 'idle'
      });
      throw error;
    } finally {
      this.state.next({
        ...this.state.getValue(),
        status: 'done',
        dbLevel: -100
      });
    }
  }

  /**
   * Helper to align sample buffers with analysis windows.
   */
  private alignBufferWindows(leftover: Float32Array[], incoming: Float32Array[], windowSize: number): { ready: Float32Array[], leftover: Float32Array[] } {
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

  private appendChannelBuffers(dest: Float32Array[], source: Float32Array[]): Float32Array[] {
    const result: Float32Array[] = [];
    for (let c = 0; c < dest.length; c++) {
      const merged = new Float32Array(dest[c].length + source[c].length);
      merged.set(dest[c]);
      merged.set(source[c], dest[c].length);
      result.push(merged);
    }
    return result;
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

  private getNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private yieldToMainThread(): Promise<void> {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }

      setTimeout(resolve, 0);
    });
  }

  // --- Worker Management ---
  private initMp3Worker(channels: number, sampleRate: number, trackId: number): void {
    if (this.activeWorker) {
      this.activeWorker.terminate();
    }
    this.resetWorkerFlowControl();

    const worker = new Worker('/mp3-encoder-worker.js');

    this.activeWorker = worker;

    worker.onmessage = ({ data }) => {
      const { event, blob, error } = data;

      if (event === 'progress') {
        this.workerQueueDepth = Math.max(0, this.workerQueueDepth - 1);
        this.notifyWorkerCapacityAvailable();
        return;
      }

      if (event === 'initialized') {
        return;
      }

      if (event === 'finished') {
        this.resetWorkerFlowControl();
      }

      if (event === 'finished' && blob) {
        const currentTracks = this.tracks.getValue();
        const updatedTracks = currentTracks.map(t => {
          if (t.id === trackId) {
            return {
              ...t,
              mp3Blob: blob,
              mp3Url: URL.createObjectURL(blob),
              status: 'done' as const
            };
          }
          return t;
        });
        this.tracks.next(updatedTracks);
      } else if (event === 'error') {
        this.resetWorkerFlowControl();
        console.error('MP3 Encoder Worker Error:', error);
        if (this.activeWorker === worker) {
          worker.terminate();
          this.activeWorker = null;
        }
        const currentTracks = this.tracks.getValue();
        const updatedTracks = currentTracks.map(t => 
          t.id === trackId ? { ...t, status: 'failed' as const } : t
        );
        this.tracks.next(updatedTracks);
      }
    };

    worker.onerror = (event) => {
      this.resetWorkerFlowControl();
      if (this.activeWorker === worker) {
        worker.terminate();
        this.activeWorker = null;
      }
      console.error('MP3 Encoder Worker Uncaught Error:', event.message);
      const currentTracks = this.tracks.getValue();
      const updatedTracks = currentTracks.map(t =>
        t.id === trackId ? { ...t, status: 'failed' as const } : t
      );
      this.tracks.next(updatedTracks);
    };

    worker.onmessageerror = () => {
      this.resetWorkerFlowControl();
      if (this.activeWorker === worker) {
        worker.terminate();
        this.activeWorker = null;
      }
      console.error('MP3 Encoder Worker Message Error');
      const currentTracks = this.tracks.getValue();
      const updatedTracks = currentTracks.map(t =>
        t.id === trackId ? { ...t, status: 'failed' as const } : t
      );
      this.tracks.next(updatedTracks);
    };

    worker.postMessage({
      command: 'init',
      payload: {
        channels,
        sampleRate,
        bitrate: this.mp3Bitrate
      }
    });
  }

  private feedSamplesToWorker(channelsData: Float32Array[]): void {
    if (this.activeWorker) {
      const normalizedChannels = this.normalizeChannelsForMp3(channelsData);
      const workerChannels = normalizedChannels.map(channel => {
        const copy = new Float32Array(channel.length);
        copy.set(channel);
        return copy;
      });

      this.workerQueueDepth += 1;

      try {
        this.activeWorker.postMessage(
          {
            command: 'encode',
            payload: {
              channelsData: workerChannels
            }
          },
          workerChannels.map(channel => channel.buffer)
        );
      } catch (error) {
        this.workerQueueDepth = Math.max(0, this.workerQueueDepth - 1);
        this.notifyWorkerCapacityAvailable();
        throw error;
      }
    }
  }

  private finishMp3Worker(trackId: number): void {
    if (this.activeWorker) {
      this.activeWorker.postMessage({ command: 'finish' });
      this.activeWorker = null; // Let the onmessage handler finish and terminate it
    }
  }

  private discardCurrentTrack(trackId: number): void {
    if (this.activeWorker) {
      this.activeWorker.terminate();
      this.activeWorker = null;
    }
    this.resetWorkerFlowControl();
    const currentTracks = this.tracks.getValue();
    const filteredTracks = currentTracks.filter(t => t.id !== trackId);
    this.tracks.next(filteredTracks);
  }

  private async waitForWorkerCapacity(): Promise<void> {
    while (
      !this.cancelRequested &&
      this.activeWorker &&
      this.workerQueueDepth >= this.maxWorkerQueueDepth
    ) {
      await new Promise<void>(resolve => {
        this.workerCapacityWaiters.push(resolve);
      });
    }
  }

  private notifyWorkerCapacityAvailable(): void {
    if (this.workerQueueDepth >= this.maxWorkerQueueDepth || this.workerCapacityWaiters.length === 0) {
      return;
    }

    const waiters = this.workerCapacityWaiters.splice(0);
    waiters.forEach(resolve => resolve());
  }

  private resetWorkerFlowControl(): void {
    this.workerQueueDepth = 0;
    this.notifyWorkerCapacityAvailable();
  }

  private getMp3ExportChannelCount(sourceChannels: number): number {
    if (sourceChannels <= 1) {
      return 1;
    }

    return sourceChannels === 2 ? 2 : 1;
  }

  private normalizeChannelsForMp3(channelsData: Float32Array[]): Float32Array[] {
    if (channelsData.length <= 2) {
      return channelsData;
    }

    const sampleCount = channelsData[0]?.length ?? 0;
    const mono = new Float32Array(sampleCount);

    for (let channelIndex = 0; channelIndex < channelsData.length; channelIndex++) {
      const channel = channelsData[channelIndex];
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
        mono[sampleIndex] += channel[sampleIndex];
      }
    }

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      mono[sampleIndex] /= channelsData.length;
    }

    return [mono];
  }

  // --- Transcription and AI Refinement ---
  private transcribeSegmentInBackground(
    segment: SilenceSegment,
    pcmBuffer: Float32Array[],
    sampleRate: number,
    targetTrackId: number
  ): void {
    // 1. Encode PCM to WAV blob
    const wavBlob = createWavBlob(pcmBuffer, sampleRate);
    
    this.transcriptionService.transcribeAudio(wavBlob)
      .then(async text => {
        const currentSegments = this.segments.getValue();
        const updatedSegments = currentSegments.map(s => 
          s.id === segment.id ? { ...s, text, status: 'done' as const } : s
        );
        this.segments.next(updatedSegments);

        const currentTracks = this.tracks.getValue();
        const updatedTracks = currentTracks.map(t => 
          t.id === targetTrackId ? { ...t, transcription: text } : t
        );
        this.tracks.next(updatedTracks);

        const extractedTitle = await this.transcriptionService.extractSongTitle(text);
        if (extractedTitle) {
          this.updateTrackTitle(targetTrackId, extractedTitle);
        }
      })
      .catch(err => {
        console.error(`Failed to transcribe segment ${segment.id}:`, err);
        const currentSegments = this.segments.getValue();
        const updatedSegments = currentSegments.map(s => 
          s.id === segment.id
            ? {
                ...s,
                status: 'failed' as const,
                text: err instanceof Error ? err.message : 'Transcription failed'
              }
            : s
        );
        this.segments.next(updatedSegments);
      });
  }
}
