# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Single control panel that can start/stop either (or both) interpreter
modes -- face-to-face conversation and PC-audio live subtitles -- from one
running app, sharing one loaded Whisper model and one translator instead of
loading them twice."""

from __future__ import annotations

import argparse
import queue
import threading
import tkinter as tk
from tkinter import ttk
from typing import Optional

from interpreter.asr import Transcriber
from interpreter.audio_loopback import LoopbackRecorder
from interpreter.conversation import ConversationSession
from interpreter.display_layout import detect_dual_monitor_layout
from interpreter.summarize import Summarizer
from interpreter.transcript import TranscriptLog
from interpreter.translate import Translator
from interpreter.tts import Speaker

STRINGS = {
    "start_conversation": "🧑‍🤝‍🧑  対面通訳を開始 / Start face-to-face",
    "stop_conversation": "🧑‍🤝‍🧑  対面通訳を停止 / Stop face-to-face",
    "start_subtitles": "🖥️  PC音声字幕を開始 / Start PC-audio subtitles",
    "stop_subtitles": "🖥️  PC音声字幕を停止 / Stop PC-audio subtitles",
    "show_transcript": "📝  文字起こし・要約を表示 / Show transcript & summary",
    "hide_transcript": "📝  文字起こし・要約を閉じる / Hide transcript & summary",
}


class LauncherApp:
    """Owns the shared Tk root and the process-wide Whisper/translator
    instances; conversation and subtitles are started/stopped independently
    as Toplevels of this root, so both can run at once if you want."""

    def __init__(
        self,
        transcriber: Transcriber,
        translator: Translator,
        summarizer: Summarizer,
        args: argparse.Namespace,
    ) -> None:
        self._transcriber = transcriber
        self._translator = translator
        self._summarizer = summarizer
        self._args = args
        self._transcript_log = TranscriptLog()

        self._conversation = None  # InterpreterApp | None
        self._subtitles_overlay = None
        self._subtitles_stop_event: Optional[threading.Event] = None
        self._transcript_panel = None  # TranscriptPanel | None

        self.root = tk.Tk()
        self.root.title("同時通訳 / Interpreter Launcher")

        frame = ttk.Frame(self.root, padding=24)
        frame.pack()

        ttk.Label(
            frame,
            text="どちらか(または両方)を開始してください",
            font=("", 12),
        ).pack(pady=(0, 12))

        self.conversation_button = ttk.Button(
            frame,
            text=STRINGS["start_conversation"],
            command=self._toggle_conversation,
        )
        self.conversation_button.pack(fill="x", ipady=10, pady=6)

        self.subtitles_button = ttk.Button(
            frame,
            text=STRINGS["start_subtitles"],
            command=self._toggle_subtitles,
        )
        self.subtitles_button.pack(fill="x", ipady=10, pady=6)

        self.transcript_button = ttk.Button(
            frame,
            text=STRINGS["show_transcript"],
            command=self._toggle_transcript_panel,
        )
        self.transcript_button.pack(fill="x", ipady=10, pady=6)

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def run(self) -> None:
        self.root.mainloop()

    # -- Face-to-face conversation mode -----------------------------------

    def _toggle_conversation(self) -> None:
        if self._conversation is None:
            self._start_conversation()
        else:
            self._stop_conversation()

    def _start_conversation(self) -> None:
        from gui.app_window import InterpreterApp

        def on_turn(turn) -> None:
            self._transcript_log.append(
                source="face_to_face",
                original_lang=turn.speaker_lang,
                original_text=turn.original_text,
                translated_lang=turn.listener_lang,
                translated_text=turn.translated_text,
            )

        session = ConversationSession(self._transcriber, self._translator, on_turn=on_turn)
        voice_by_lang = {}
        if self._args.ja_voice_id:
            voice_by_lang["ja"] = self._args.ja_voice_id
        if self._args.en_voice_id:
            voice_by_lang["en"] = self._args.en_voice_id
        speaker = Speaker(voice_by_lang=voice_by_lang, rate=self._args.tts_rate)
        layout = detect_dual_monitor_layout(
            guest_monitor_index=self._args.guest_monitor_index
        )

        self._conversation = InterpreterApp(
            session=session, speaker=speaker, layout=layout, master=self.root
        )
        self.conversation_button.configure(text=STRINGS["stop_conversation"])

    def _stop_conversation(self) -> None:
        if self._conversation is not None:
            self._conversation.close()
            self._conversation = None
        self.conversation_button.configure(text=STRINGS["start_conversation"])

    # -- PC-audio live subtitles mode --------------------------------------

    def _toggle_subtitles(self) -> None:
        if self._subtitles_overlay is None:
            self._start_subtitles()
        else:
            self._stop_subtitles()

    def _start_subtitles(self) -> None:
        from gui.subtitle_overlay import SubtitleOverlay
        from subtitles import run_pipeline

        recorder = LoopbackRecorder(
            chunk_seconds=self._args.chunk_seconds, device=self._args.loopback_device
        )
        results: "queue.Queue[tuple[str, str] | None]" = queue.Queue()
        stop_event = threading.Event()
        self._subtitles_stop_event = stop_event

        def on_entry(original: str, translated: str) -> None:
            self._transcript_log.append(
                source="pc_audio",
                original_lang="en",
                original_text=original,
                translated_lang="ja",
                translated_text=translated,
            )

        def on_overlay_close() -> None:
            stop_event.set()
            self._subtitles_overlay = None
            self.subtitles_button.configure(text=STRINGS["start_subtitles"])

        overlay = SubtitleOverlay(on_close=on_overlay_close, master=self.root)
        self._subtitles_overlay = overlay

        def poll() -> None:
            if self._subtitles_overlay is not overlay:
                return  # Stopped/replaced since this was scheduled.
            try:
                while True:
                    item = results.get_nowait()
                    if item is None:
                        return
                    original, translated = item
                    overlay.update_subtitle(original, translated)
            except queue.Empty:
                pass
            if not stop_event.is_set():
                self.root.after(200, poll)

        threading.Thread(
            target=run_pipeline,
            args=(
                recorder,
                self._transcriber,
                self._translator,
                results,
                stop_event,
                on_entry,
            ),
            daemon=True,
        ).start()
        poll()
        self.subtitles_button.configure(text=STRINGS["stop_subtitles"])

    def _stop_subtitles(self) -> None:
        if self._subtitles_stop_event is not None:
            self._subtitles_stop_event.set()
        if self._subtitles_overlay is not None:
            overlay, self._subtitles_overlay = self._subtitles_overlay, None
            overlay.close()
        self.subtitles_button.configure(text=STRINGS["start_subtitles"])

    # -- Shared transcript & summary panel -----------------------------------

    def _toggle_transcript_panel(self) -> None:
        if self._transcript_panel is None:
            self._start_transcript_panel()
        else:
            self._stop_transcript_panel()

    def _start_transcript_panel(self) -> None:
        from gui.transcript_panel import TranscriptPanel

        def on_panel_close() -> None:
            self._transcript_panel = None
            self.transcript_button.configure(text=STRINGS["show_transcript"])

        panel = TranscriptPanel(
            self._transcript_log,
            self._summarizer,
            master=self.root,
            on_close=on_panel_close,
        )
        self._transcript_panel = panel
        self.transcript_button.configure(text=STRINGS["hide_transcript"])

    def _stop_transcript_panel(self) -> None:
        if self._transcript_panel is not None:
            panel, self._transcript_panel = self._transcript_panel, None
            panel.close()
        self.transcript_button.configure(text=STRINGS["show_transcript"])

    # -- Shutdown -----------------------------------------------------------

    def _on_close(self) -> None:
        self._stop_conversation()
        self._stop_subtitles()
        self._stop_transcript_panel()
        self.root.destroy()
