# Web Audio Tools

Tools for slicing audio files into tracks at silence boundaries, with optional transcription of speech gaps. A platform-agnostic core is shared by a browser app and a CLI.

## Language

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
Per-run inputs that are not persisted and not reset, such as the track start index and the input file.
_Avoid_: settings (when referring to per-run inputs)

**Reset to Defaults**:
The act of restoring every Setting to its Default and discarding the persisted values. The API key survives a reset.
_Avoid_: clear settings, restore factory settings