# Detection-only slicing, on-demand export, and a single DSP path for audition and export

Effects and Presets are applied per Track, after slicing. To support auditioning and tweaking Presets before committing, slicing becomes detection-only (boundaries, titles, and per-track analysis stats — no encoding), and processing + encoding move to an on-demand Export step that re-reads each Track's region from the source. Audition renders through the *same* pure-JS effect chain in `audio-core` (render-to-preview: worker render → WAV blob → `<audio>`), so audition, Export, and the CLI share one DSP implementation and cannot drift sonically. This fits the existing platform-agnostic core: no Web Audio API, no ffmpeg.wasm, identical results in browser and Node.

## Considered Options

- **Real-time Web Audio preview** (BiquadFilter/Convolver/DynamicsCompressor nodes): instant parameter response, but a second implementation of every effect, browser-only, that must be kept sonically identical to the export/CLI path. Rejected: two DSP codebases to maintain; render-to-preview's few-seconds-per-tweak latency is acceptable for preset evaluation.
- **Effects inline in the streaming encode during slicing** (today's architecture): rejected because normalize and auto noise profiling need whole-track knowledge, and a Preset switch after slicing would force re-encoding anyway. On-demand export never wastes encode work.

## Consequences

- Tracks are not instantly playable as MP3 after slicing; audition uses the rendered preview, and downloading/exporting a Track triggers its processing. The source must stay available for the session.
- No Track PCM is retained. Region re-reads use `file.slice(startByte, endByte).stream()` (browser) / `createReadStream(path, {start, end})` (Node) with byte-offset arithmetic from the WAV header; regions spanning multiple Chunks map onto per-chunk slices. A forward-only `WavStreamParser` cannot seek, so a region-reader helper is required.
- When normalize or noise reduction is enabled, the shared path first streams the region once to analyze it (peak level + per-bin noise profile via minimum statistics), then streams it again through the effect chain. Memory stays bounded to stream blocks and effect state — the multi-GB source is never loaded.
- Reverb tails ring past the sliced Track end (decay cutoff, capped at the next Track's start). Track boundaries remain the sliced truth; the manifest records the applied Preset snapshot and each output file's actual duration.
- If full-track render latency hurts preset iteration, the fallback is windowed rendering around the playhead with effect-state warm-up — still the same code path, not a second implementation.