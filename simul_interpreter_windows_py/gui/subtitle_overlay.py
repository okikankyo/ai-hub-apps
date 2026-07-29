# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Borderless, always-on-top subtitle overlay for live PC-audio translation --
meant to float over a YouTube tab or a call app window, not replace it."""

from __future__ import annotations

import tkinter as tk
from tkinter import font as tkfont
from typing import Callable, Optional


class SubtitleOverlay:
    def __init__(self, on_close: Optional[Callable[[], None]] = None) -> None:
        self._on_close = on_close

        self.root = tk.Tk()
        self.root.title("Live Subtitles")
        self.root.attributes("-topmost", True)
        self.root.overrideredirect(True)
        self.root.configure(bg="#000000")
        try:
            self.root.attributes("-alpha", 0.85)
        except tk.TclError:
            pass  # Per-window alpha isn't supported on every platform/WM.

        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        width, height = min(1000, screen_w - 40), 160
        x = (screen_w - width) // 2
        y = screen_h - height - 60
        self.root.geometry(f"{width}x{height}+{x}+{y}")

        small_font = tkfont.Font(size=14)
        big_font = tkfont.Font(size=26, weight="bold")

        self.original_text = tk.StringVar()
        self.translated_text = tk.StringVar(value="Listening...")

        tk.Label(
            self.root,
            textvariable=self.original_text,
            font=small_font,
            fg="#bbbbbb",
            bg="#000000",
            wraplength=width - 40,
        ).pack(pady=(10, 0))
        tk.Label(
            self.root,
            textvariable=self.translated_text,
            font=big_font,
            fg="#ffffff",
            bg="#000000",
            wraplength=width - 40,
        ).pack(pady=(0, 10))

        # overrideredirect() removes the title bar, so there's no default way
        # to move or close the window -- wire up drag-to-move and
        # right-click/Escape-to-close instead.
        self.root.bind("<ButtonPress-1>", self._start_drag)
        self.root.bind("<B1-Motion>", self._do_drag)
        self.root.bind("<Button-3>", lambda _e: self.close())
        self.root.bind("<Escape>", lambda _e: self.close())
        self._drag_offset = (0, 0)

    def _start_drag(self, event: tk.Event) -> None:
        self._drag_offset = (event.x, event.y)

    def _do_drag(self, event: tk.Event) -> None:
        x = self.root.winfo_pointerx() - self._drag_offset[0]
        y = self.root.winfo_pointery() - self._drag_offset[1]
        self.root.geometry(f"+{x}+{y}")

    def update_subtitle(self, original_text: str, translated_text: str) -> None:
        self.original_text.set(original_text)
        self.translated_text.set(translated_text)

    def close(self) -> None:
        if self._on_close:
            self._on_close()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()
