# EPUB-to-Audiobook Queue and UI Improvements

Implementation checklist:

- [x] Add configurable multi-text defaults (enabled, 11 empty boxes, 50 chapters per section, note retention).
- [x] Make MP3 the UI/API generation default while preserving the OpenAI-compatible WAV default.
- [x] Remove restored/sample/preset text from initial and reset flows.
- [x] Add editable book title and browser-only EPUB/TXT/folder upload and drag-and-drop controls.
- [x] Parse EPUB spine content and naturally ordered TXT bundles into validated spoken chapters.
- [x] Produce a single whole-book preview with warnings and selectable chapter sections.
- [x] Add safe chapter-aware output naming with collision avoidance and legacy fallback.
- [x] Persist imports, normalized sections, queue manifests, assigned filenames, and checkpoints.
- [x] Process sections sequentially under a global generation lock with bounded intermediate storage.
- [x] Add pause, resume, retry-failed, cancel, interruption recovery, and progress APIs/UI.
- [x] Package a streaming MP3 encoding path that does not require a system FFmpeg executable.
- [x] Keep `/tts` and `/tts/multi` backward compatible with optional book/chapter metadata.
- [x] Add focused automated coverage for TXT parsing, gaps, grouping, naming, collisions, and persistence.
- [x] Run Python syntax checks, focused unit tests, and whitespace validation.
