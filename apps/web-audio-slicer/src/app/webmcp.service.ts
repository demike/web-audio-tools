import { Injectable, inject } from '@angular/core';
import {
  MusicBrainzClient,
  createSlicerTools,
  type AudioInput,
  type SlicerToolTarget
} from '@web-audio-tools/audio-core';
import { AudioSlicerService } from './audio-slicer.service';

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
      removeTrackById: (trackId) => this.audioSlicerService.removeTrack(trackId)
    };

    const tools = createSlicerTools({
      slicer: slicerFacade,
      musicBrainz: new MusicBrainzClient(),
      resolveInput: async (source: string) => {
        const file = this.audioSlicerService.getCurrentFile();
        if (!file) {
          throw new Error('No WAV file is loaded. Load a file in the UI first, then call slice_wav with source "current".');
        }
        if (source !== 'current' && source !== file.name) {
          throw new Error(`Unknown source "${source}". In the browser, use "current" (the loaded file) or its name "${file.name}".`);
        }
        return file.stream();
      },
      fileSize: async () => this.audioSlicerService.getCurrentFile()?.size
    });

    for (const tool of tools) {
      modelContext.registerTool(tool);
    }
  }
}