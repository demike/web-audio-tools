import { Injectable } from '@angular/core';
import { AudioSlicerService } from './audio-slicer.service';

@Injectable({
  providedIn: 'root'
})
export class WebMcpService {
  constructor(private audioSlicerService: AudioSlicerService) {}

  /**
   * Initializes WebMCP tool registrations.
   * Checks both navigator.modelContext and document.modelContext.
   */
  public registerWebMcpTools(): void {
    const modelContext = (navigator as any).modelContext || (document as any).modelContext;

    if (!modelContext || typeof modelContext.registerTool !== 'function') {
      console.log('WebMCP Model Context API is not supported in this browser. Skipping tool registration.');
      return;
    }

    console.log('WebMCP Model Context API detected! Registering tools...');

    // 1. Get Slicer State Tool
    modelContext.registerTool({
      name: 'get_slicer_state',
      description: 'Retrieve the current state of the audio slicing process, including progress, current time, estimated duration, and status.',
      inputSchema: {
        type: 'object',
        properties: {}
      },
      execute: async () => {
        let stateVal: any = null;
        this.audioSlicerService.state$.subscribe(s => stateVal = s).unsubscribe();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(stateVal, null, 2)
            }
          ]
        };
      }
    });

    // 2. Get Tracks Tool
    modelContext.registerTool({
      name: 'get_tracks',
      description: 'Get the list of songs/tracks identified from the WAV file, along with their start times, durations, transcriptions, and MP3 encoding status.',
      inputSchema: {
        type: 'object',
        properties: {}
      },
      execute: async () => {
        const tracks = this.audioSlicerService.getTracksValue();
        const formattedTracks = tracks.map(t => ({
          id: t.id,
          title: t.title,
          startTimeSeconds: Math.round(t.startTime * 100) / 100,
          endTimeSeconds: Math.round(t.endTime * 100) / 100,
          durationSeconds: Math.round(t.duration * 100) / 100,
          status: t.status,
          transcriptionBeforeSong: t.transcription
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formattedTracks, null, 2)
            }
          ]
        };
      }
    });

    // 3. Update Track Title Tool
    modelContext.registerTool({
      name: 'update_track_title',
      description: 'Update the title of a specific audio track. Use this to refine or customize track names.',
      inputSchema: {
        type: 'object',
        properties: {
          trackId: {
            type: 'number',
            description: 'The numeric ID of the track to update'
          },
          title: {
            type: 'string',
            description: 'The new title for the track'
          }
        },
        required: ['trackId', 'title']
      },
      execute: async (params: { trackId: number; title: string }) => {
        const { trackId, title } = params;
        this.audioSlicerService.updateTrackTitle(trackId, title);
        
        return {
          content: [
            {
              type: 'text',
              text: `Successfully updated Track ${trackId} title to "${title}".`
            }
          ]
        };
      }
    });

    // 4. Get Silence Segments Tool
    modelContext.registerTool({
      name: 'get_silence_segments',
      description: 'Get the list of silent or spoken introductory segments identified between songs, along with their timestamps and transcription text.',
      inputSchema: {
        type: 'object',
        properties: {}
      },
      execute: async () => {
        const segments = this.audioSlicerService.getSegmentsValue();
        const formattedSegments = segments.map(s => ({
          id: s.id,
          startTimeSeconds: Math.round(s.startTime * 100) / 100,
          endTimeSeconds: Math.round(s.endTime * 100) / 100,
          durationSeconds: Math.round(s.duration * 100) / 100,
          status: s.status,
          transcriptionText: s.text
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formattedSegments, null, 2)
            }
          ]
        };
      }
    });
  }
}
