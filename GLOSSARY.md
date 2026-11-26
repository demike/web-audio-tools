# Web Audio Tools

Tools for slicing audio files into tracks at silence boundaries, with optional transcription of speech gaps. A platform-agnostic core is shared by a browser app and a CLI.

## Language

**Recording**:
One continuous stretch of audio supplied to a single run, made up of one or more Chunks. A Recording has one timeline: tracks and silence gaps may span Chunk boundaries.
_Avoid_: session, playlist, batch

**Chunk**:
One WAV file that forms part of a Recording. A single-file run is a Recording with exactly one Chunk.
_Avoid_: part, split, segment (a segment is a silence gap), input file

**Track**:
One detected song region of a Recording, bounded by silence gaps, that becomes one output audio file. A Track's boundaries are fixed by slicing; Effects are applied to its audio afterwards. The processed audio may ring past the Track's end (a reverb tail), but its boundaries never change.
_Avoid_: segment (a segment is a silence gap), clip, lane

**Settings**:
User preferences that persist across sessions and can be reset to Defaults: the Slicer Parameters, the transcription language, and whether speech gaps are transcribed on start. The API key is stored alongside Settings but is a credential, not a preference.
_Avoid_: preferences, options, config

**Slicer Parameters**:
The six numeric settings that control slicing and encoding: silence threshold, minimum silence duration, minimum song duration, MP3 bitrate, pre-roll, and post-roll.
_Avoid_: slicer options, engine settings

**Defaults**:
The canonical initial values of all Settings, defined once in the core and shared by every platform. A Setting that differs from its Default is "modified".
_Avoid_: factory settings, initial values

**Run Options**:
Per-run inputs that are not persisted and not reset, such as the track start index and the Recording.
_Avoid_: settings (when referring to per-run inputs)

**Reset to Defaults**:
The act of restoring every Setting to its Default and discarding the persisted values. The API key survives a reset.
_Avoid_: clear settings, restore factory settings

**Effect**:
One audio processor applied to a Track's audio after slicing, such as normalization, EQ, reverb, compression, or noise reduction. Effects never influence silence detection or Track boundaries.
_Avoid_: plugin, effect set (an effect set is a Preset)

**Preset**:
A named, reusable effect configuration: the Effects applied to every Track of a run, their order, and their parameter values. Factory Presets ship with the tool; users can save their own. Selecting a Preset is a Run Option. Tweaking a selected Preset's parameters makes it modified; it can then be saved as a new Preset.
_Avoid_: effect set, profile, patch, settings (when referring to a Preset), defaults (when referring to Factory Presets)

**Export**:
The on-demand act of processing a Track with the selected Preset and encoding it to an output file. Export happens after slicing, never during it.
_Avoid_: bounce, mixdown, save (when referring to Export)

**Audition**:
Listening to a Track with a Preset applied, produced by rendering the Track's audio through the same Effect chain that Export uses, without writing an output file. Audition exists to evaluate and tweak Presets; it never changes the Track or the Recording.
_Avoid_: preview, playback (when referring to Audition)