# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Dual-window UI: one window faces the Japanese speaker (also the control
surface), the other faces the foreign guest. Both are driven from the same
`ConversationSession`, so a turn spoken on either side updates both screens.
"""

from __future__ import annotations

import logging
import queue
import threading
import tkinter as tk
from tkinter import font as tkfont
from tkinter import ttk
from typing import Callable, Optional

import numpy as np

from interpreter.asr import SAMPLE_RATE
from interpreter.conversation import ConversationSession, Turn
from interpreter.display_layout import MonitorLayout
from interpreter.tts import Speaker

logger = logging.getLogger(__name__)

CONFIRM_COLORS = {"high": "#2e7d32", "medium": "#f9a825", "low": "#c62828"}

UI_STRINGS = {
    "ja": {
        "window_title": "同時通訳 - あなた",
        "you_said": "あなたの発話",
        "they_said": "相手の発話 (翻訳)",
        "heard_as": "相手にはこう伝わりました",
        "original": "原文",
        "record": "🎤  日本語で話す",
        "recording": "● 録音中 (もう一度押すと終了)",
        "processing": "翻訳しています...",
        "confirm": {
            "high": "意味は伝わっていそうです",
            "medium": "意味が変わっている可能性があります",
            "low": "意味が大きく変わっている可能性があります",
        },
        "history_title": "会話履歴",
    },
    "en": {
        "window_title": "Interpreter - Guest",
        "you_said": "What you said",
        "they_said": "What they said (translated)",
        "heard_as": "They heard this",
        "original": "Original",
        "record": "🎤  Speak English",
        "recording": "● Recording (tap again to stop)",
        "processing": "Translating...",
        "confirm": {
            "high": "Meaning likely came through",
            "medium": "Meaning may have shifted",
            "low": "Meaning may have changed significantly",
        },
        "history_title": "History",
    },
}


class AudioRecorder:
    """Push-to-talk microphone capture on top of `sounddevice`. Records into an
    in-memory buffer between `start()` and `stop()`."""

    def __init__(
        self, sample_rate: int = SAMPLE_RATE, device: Optional[int] = None
    ) -> None:
        self._sample_rate = sample_rate
        self._device = device
        self._stream = None
        self._frames: list[np.ndarray] = []

    def start(self) -> None:
        import sounddevice as sd

        self._frames = []

        def callback(indata, frames, time, status) -> None:
            if status:
                logger.warning("Audio input status: %s", status)
            self._frames.append(indata.copy())

        self._stream = sd.InputStream(
            samplerate=self._sample_rate,
            channels=1,
            device=self._device,
            callback=callback,
        )
        self._stream.start()

    def stop(self) -> np.ndarray:
        if self._stream is None:
            return np.zeros(0, dtype=np.float32)
        self._stream.stop()
        self._stream.close()
        self._stream = None
        if not self._frames:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(self._frames, axis=0).squeeze(-1)


class _WindowWidgets:
    """Widget handles for one side's window, plus the StringVars that drive them."""

    def __init__(self, lang: str, on_record_toggle: Callable[[str], None]) -> None:
        self.lang = lang
        self.headline = tk.StringVar()
        self.main_text = tk.StringVar()
        self.sub_label = tk.StringVar()
        self.sub_text = tk.StringVar()
        self.confirm_text = tk.StringVar()
        self.confirm_detail = tk.StringVar()
        self.record_button_text = tk.StringVar(value=UI_STRINGS[lang]["record"])
        self._on_record_toggle = on_record_toggle
        self.confirm_label_widget: ttk.Label | None = None
        self.record_button: ttk.Button | None = None
        self.history_widget: tk.Text | None = None

    def build(self, window: tk.Misc) -> None:
        strings = UI_STRINGS[self.lang]
        big_font = tkfont.Font(size=30, weight="bold")
        mid_font = tkfont.Font(size=18)
        small_font = tkfont.Font(size=13)

        pad = {"padx": 24, "pady": 10}
        ttk.Label(window, textvariable=self.headline, font=mid_font).pack(
            anchor="w", **pad
        )
        ttk.Label(
            window, textvariable=self.main_text, font=big_font, wraplength=900
        ).pack(anchor="w", fill="x", **pad)
        ttk.Label(window, textvariable=self.sub_label, font=small_font).pack(
            anchor="w", padx=24
        )
        ttk.Label(
            window,
            textvariable=self.sub_text,
            font=mid_font,
            wraplength=900,
            foreground="#555555",
        ).pack(anchor="w", fill="x", **pad)

        self.confirm_label_widget = ttk.Label(
            window, textvariable=self.confirm_text, font=small_font
        )
        self.confirm_label_widget.pack(anchor="w", padx=24)
        ttk.Label(
            window,
            textvariable=self.confirm_detail,
            font=small_font,
            foreground="#777777",
            wraplength=900,
        ).pack(anchor="w", padx=24, pady=(0, 10))

        self.record_button = ttk.Button(
            window,
            textvariable=self.record_button_text,
            command=lambda: self._on_record_toggle(self.lang),
        )
        self.record_button.pack(anchor="w", padx=24, pady=10, ipadx=20, ipady=10)

        ttk.Label(window, text=strings["history_title"], font=small_font).pack(
            anchor="w", padx=24, pady=(20, 0)
        )
        self.history_widget = tk.Text(window, height=8, font=small_font, wrap="word")
        self.history_widget.pack(fill="both", expand=True, padx=24, pady=10)
        self.history_widget.configure(state="disabled")

    def set_status(self, state: str) -> None:
        strings = UI_STRINGS[self.lang]
        if self.record_button is None:
            return
        if state == "recording":
            self.record_button_text.set(strings["recording"])
            self.record_button.state(["!disabled"])
        elif state == "processing":
            self.record_button_text.set(strings["processing"])
            self.record_button.state(["disabled"])
        else:
            self.record_button_text.set(strings["record"])
            self.record_button.state(["!disabled"])

    def append_history(self, line: str) -> None:
        if self.history_widget is None:
            return
        self.history_widget.configure(state="normal")
        self.history_widget.insert("end", line + "\n")
        self.history_widget.see("end")
        self.history_widget.configure(state="disabled")


class InterpreterApp:
    """Top-level controller: owns both Tk windows, the push-to-talk recorders,
    and dispatch of finished turns from the background ASR/translation thread
    back onto the Tk main thread."""

    def __init__(
        self,
        session: ConversationSession,
        speaker: Speaker,
        layout: MonitorLayout,
        recorder_factory: Callable[[], AudioRecorder] = AudioRecorder,
        master: tk.Misc | None = None,
    ) -> None:
        self._session = session
        self._speaker = speaker
        self._recorder_factory = recorder_factory
        self._results: queue.Queue[Turn | Exception] = queue.Queue()
        self._active_recorder: AudioRecorder | None = None
        self._active_lang: str | None = None
        # When embedded in a launcher (see gui/launcher.py), `master` is that
        # launcher's root and we must not create a second Tk() -- only one Tk
        # interpreter per process is supported. Standalone (demo.py), there's
        # no master, so this window is the root and owns the mainloop.
        self._owns_mainloop = master is None

        self.root = tk.Toplevel(master) if master is not None else tk.Tk()
        self.root.title(UI_STRINGS["ja"]["window_title"])
        self.root.geometry(layout.self_geometry)

        self.guest_window = tk.Toplevel(self.root)
        self.guest_window.title(UI_STRINGS["en"]["window_title"])
        self.guest_window.geometry(layout.guest_geometry)

        self._widgets = {
            "ja": _WindowWidgets("ja", self._toggle_record),
            "en": _WindowWidgets("en", self._toggle_record),
        }
        self._widgets["ja"].build(self.root)
        self._widgets["en"].build(self.guest_window)

        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.guest_window.protocol("WM_DELETE_WINDOW", self.close)

        self._reset_widget_text()
        self._poll_results()

    def run(self) -> None:
        """Blocks running this window's own Tk mainloop. Only valid when this
        app wasn't given a `master` -- if it was (i.e. it's embedded in a
        launcher), the launcher owns the mainloop instead; call `close()` when
        done rather than `run()`."""
        if not self._owns_mainloop:
            raise RuntimeError(
                "run() is only valid when InterpreterApp owns its own Tk root "
                "(master=None). This instance is embedded in another app's "
                "mainloop."
            )
        self.root.mainloop()

    def _reset_widget_text(self) -> None:
        for lang, widgets in self._widgets.items():
            strings = UI_STRINGS[lang]
            widgets.headline.set(strings["you_said"])
            widgets.sub_label.set(strings["heard_as"])

    def _toggle_record(self, lang: str) -> None:
        if self._active_lang == lang:
            self._finish_recording()
        elif self._active_lang is None:
            self._start_recording(lang)
        # A press on the other side's button while one side is recording is
        # ignored -- only one person speaks at a time in this design.

    def _start_recording(self, lang: str) -> None:
        recorder = self._recorder_factory()
        recorder.start()
        self._active_recorder = recorder
        self._active_lang = lang
        self._widgets[lang].set_status("recording")

    def _finish_recording(self) -> None:
        lang = self._active_lang
        recorder = self._active_recorder
        self._active_recorder = None
        self._active_lang = None
        if recorder is None or lang is None:
            return

        audio = recorder.stop()
        self._widgets[lang].set_status("processing")
        threading.Thread(
            target=self._process_audio, args=(audio, lang), daemon=True
        ).start()

    def _process_audio(self, audio: np.ndarray, lang: str) -> None:
        try:
            turn = self._session.process_utterance(audio, lang)
            self._results.put(turn)
        except Exception as exc:
            logger.exception("Failed to process utterance for lang=%s", lang)
            self._results.put(exc)

    def _poll_results(self) -> None:
        try:
            while True:
                item = self._results.get_nowait()
                if isinstance(item, Exception):
                    self._show_error(item)
                else:
                    self._render_turn(item)
        except queue.Empty:
            pass
        self.root.after(100, self._poll_results)

    def _render_turn(self, turn: Turn) -> None:
        for lang, widgets in self._widgets.items():
            self._render_window(widgets, turn)
            widgets.set_status("idle")
        self._speaker.speak(turn.translated_text, turn.listener_lang)

    def _render_window(self, widgets: _WindowWidgets, turn: Turn) -> None:
        strings = UI_STRINGS[widgets.lang]
        own_lang = widgets.lang

        if turn.speaker_lang == own_lang:
            widgets.headline.set(strings["you_said"])
            widgets.main_text.set(turn.original_text)
            widgets.sub_label.set(strings["heard_as"])
            widgets.sub_text.set(turn.translated_text)
            widgets.confirm_text.set(strings["confirm"][turn.confirmation_level])
            widgets.confirm_detail.set(
                f'({strings["heard_as"]} -> {UI_STRINGS[turn.listener_lang]["you_said"]}: '
                f"{turn.back_translated_text})"
            )
            if widgets.confirm_label_widget is not None:
                widgets.confirm_label_widget.configure(
                    foreground=CONFIRM_COLORS[turn.confirmation_level]
                )
            history_line = f"[{own_lang.upper()}] {turn.original_text}"
        else:
            widgets.headline.set(strings["they_said"])
            widgets.main_text.set(turn.translated_text)
            widgets.sub_label.set(strings["original"])
            widgets.sub_text.set(turn.original_text)
            widgets.confirm_text.set("")
            widgets.confirm_detail.set("")
            history_line = (
                f"[{turn.speaker_lang.upper()}->{own_lang.upper()}] {turn.translated_text}"
            )

        widgets.append_history(history_line)

    def _show_error(self, exc: Exception) -> None:
        logger.error("Pipeline error: %s", exc)
        for widgets in self._widgets.values():
            widgets.append_history(f"[!] {exc}")
            widgets.set_status("idle")

    def close(self) -> None:
        self._speaker.stop()
        self.root.destroy()
