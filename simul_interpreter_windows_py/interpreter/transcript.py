# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""A single chronological log shared by both interpreter modes (face-to-face
conversation and PC-audio subtitles), so `gui/transcript_panel.py` can show
one scrollable history -- and summarize it -- regardless of which mode
produced each line.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime

SOURCE_LABELS = {"face_to_face": "\U0001f9d1‍\U0001f91d‍\U0001f9d1", "pc_audio": "\U0001f5a5️"}


@dataclass
class TranscriptEntry:
    source: str  # "face_to_face" | "pc_audio"
    original_lang: str
    original_text: str
    translated_lang: str
    translated_text: str
    timestamp: datetime = field(default_factory=datetime.now)

    @property
    def japanese_text(self) -> str:
        """Whichever of the two texts is Japanese -- entries alternate which
        field that is (mode 1 can go either direction; mode 2 is always
        `translated_text`), so callers that want a single-language view (e.g.
        the summarizer) should use this instead of picking a field directly.
        """
        return self.original_text if self.original_lang == "ja" else self.translated_text


class TranscriptLog:
    """Thread-safe append-only log: entries are written from ASR/translation
    worker threads and read from the Tk main thread via `snapshot()`."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: list[TranscriptEntry] = []

    def append(
        self,
        *,
        source: str,
        original_lang: str,
        original_text: str,
        translated_lang: str,
        translated_text: str,
    ) -> TranscriptEntry:
        entry = TranscriptEntry(
            source=source,
            original_lang=original_lang,
            original_text=original_text,
            translated_lang=translated_lang,
            translated_text=translated_text,
        )
        with self._lock:
            self._entries.append(entry)
        return entry

    def snapshot(self) -> list[TranscriptEntry]:
        with self._lock:
            return list(self._entries)


def format_chat_line(entry: TranscriptEntry) -> str:
    label = SOURCE_LABELS.get(entry.source, "")
    timestamp = entry.timestamp.strftime("%H:%M:%S")
    return (
        f"{timestamp} {label} {entry.original_text}\n"
        f"          → {entry.translated_text}"
    )


def format_summary_input(entries: list[TranscriptEntry]) -> str:
    """Renders entries as a timestamped, single-language (Japanese) transcript
    for the summarizer -- the model doesn't need to translate, only to follow
    and condense what's already in the reader's language."""
    lines = [
        f"[{entry.timestamp.strftime('%H:%M:%S')}] {entry.japanese_text}"
        for entry in entries
        if entry.japanese_text.strip()
    ]
    return "\n".join(lines)
