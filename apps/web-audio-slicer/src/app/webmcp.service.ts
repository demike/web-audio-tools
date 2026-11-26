import { Injectable, inject } from '@angular/core';
import {
  MusicBrainzClient,
  createRecordingInput,
  createSlicerTools,
  type AudioInput,
  type SlicerToolTarget
} from '@web-audio-tools/audio-core';
import { AudioSlicerService } from './audio-slicer.service';
import { PresetService } from './preset.service';

type WebMcpContext = {
  registerTool: (tool: {
    name: string;
    description: string;
    inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
    execute: (params: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
  }) => void;
};

type ModelContextCapable = {
  modelContext?: WebMcpContext;
};

/**
 * Registers the core's portable tool set with WebMCP. Transcription is done by
 * the calling model: slice_wav leaves prepared gap audio, the model fetches it
 * (get_gap_audio), transcribes it, and names tracks via set_track_title.
 */
@Injectable({
  providedIn: 'root'
})
export class WebMcpService {
  private readonly audioSlicerService = inject(AudioSlicerService);
  private readonly presets = inject(PresetService);

  public registerWebMcpTools(): void {
    const modelContext = (navigator as Navigator & ModelContextCapable).modelContext
      || (document as Document & ModelContextCapable).modelContext;

    if (!modelContext || typeof modelContext.registerTool !== 'function') {
      console.log('WebMCP Model Context API is not supported in this browser. Skipping tool registration.');
      return;
    }

    console.log('WebMCP Model Context API detected! Registering tools...');

    const core = this.audioSlicerService.getCoreSlicer();

    // Facade so tool-driven slicing resets the UI and uses the service's
    // parameters, while reads/writes go through the same core the UI watches.
    const slicerFacade: SlicerToolTarget = {
      transcription: null,
      run: async (input: AudioInput, options) => {
        this.audioSlicerService.reset();
        await this.audioSlicerService.runInput(input, { ...options, externalTranscription: true });
        return {
          tracks: core.getTracksValue(),
          segments: core.getSegmentsValue(),
          state: core.getStateValue()
        };
      },
      getTracksValue: () => core.getTracksValue(),
      getSegmentsValue: () => core.getSegmentsValue(),
      getStateValue: () => core.getStateValue(),
      updateTrackTitle: (trackId, title, titleSource) => this.audioSlicerService.updateTrackTitle(trackId, title, titleSource),
      removeTrackById: (trackId) => this.audioSlicerService.removeTrack(trackId),
      applyExportResult: (trackKey, mp3Bytes, processedDurationSec) => core.applyExportResult(trackKey, mp3Bytes, processedDurationSec)
    };

    const tools = createSlicerTools({
      slicer: slicerFacade,
      musicBrainz: new MusicBrainzClient(),
      resolveInput: async (source: string) => {
        const files = this.audioSlicerService.getCurrentFiles();
        if (files.length === 0) {
          throw new Error('No WAV file is loaded. Load a file in the UI first, then call slice_wav with source "current".');
        }
        if (source !== 'current' && !files.some(file => file.name === source)) {
          throw new Error(`Unknown source "${source}". In the browser, use "current" (the loaded recording) or a loaded file name.`);
        }
        // "current" (or any loaded chunk name) resolves to the whole loaded
        // Recording: all chunks joined into one continuous stream.
        const recording = await createRecordingInput(this.audioSlicerService.toRecordingChunks(files));
        return recording.input;
      },
      fileSize: async () => {
        const files = this.audioSlicerService.getCurrentFiles();
        return files.length > 0 ? files.reduce((sum, file) => sum + file.size, 0) : undefined;
      },
      exportTrack: async track => {
        const result = await this.audioSlicerService.exportTrack(track.key, this.presets.workingConfig());
        const encoded = core.getTracksValue().find(t => t.key === track.key);
        if (!result || !encoded?.mp3Bytes) {
          return null;
        }
        return { mp3Bytes: encoded.mp3Bytes, durationSec: result.durationSec };
      }
    });

    for (const tool of tools) {
      modelContext.registerTool(tool);
    }
  }
}