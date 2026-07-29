# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Companion window: a scrollable, chat-style transcript of everything either
interpreter mode has produced, plus an on-device-LLM summary that stays
readable even if the topic changed partway through. Kept separate from the
live overlay/dual-display windows so those can stay small and uncluttered.
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
from tkinter import ttk
from typing import Callable, Optional

from interpreter.summarize import Summarizer
from interpreter.transcript import TranscriptLog, format_chat_line, format_summary_input


class TranscriptPanel:
    def __init__(
        self,
        transcript_log: TranscriptLog,
        summarizer: Summarizer,
        master: Optional[tk.Misc] = None,
        on_close: Optional[Callable[[], None]] = None,
        auto_refresh_ms: int = 20_000,
    ) -> None:
        self._log = transcript_log
        self._summarizer = summarizer
        self._on_close = on_close
        self._auto_refresh_ms = auto_refresh_ms
        self._owns_mainloop = master is None
        self._rendered_count = 0
        self._summarized_count = 0
        self._summarizing = False
        # Summarization runs on a background thread (see `_summarize_worker`),
        # which must never touch Tk directly -- like the rest of this app's
        # background threads, it only pushes onto a plain queue, and this
        # panel's own `after`-scheduled `_poll` (main thread) drains it.
        self._summary_results: "queue.Queue[tuple[str, Optional[Exception]]]" = queue.Queue()

        self.root = tk.Toplevel(master) if master is not None else tk.Tk()
        self.root.title("文字起こし・要約 / Transcript & Summary")
        self.root.geometry("640x480")

        notebook = ttk.Notebook(self.root)
        notebook.pack(fill="both", expand=True)

        transcript_frame = ttk.Frame(notebook)
        notebook.add(transcript_frame, text="文字起こし")
        self.transcript_text = self._build_scrollable_text(transcript_frame)

        summary_frame = ttk.Frame(notebook)
        notebook.add(summary_frame, text="要約")
        button_row = ttk.Frame(summary_frame)
        button_row.pack(fill="x")
        self.refresh_button = ttk.Button(
            button_row, text="更新 / Refresh", command=self.refresh_summary
        )
        self.refresh_button.pack(side="left", padx=8, pady=8)
        self.summary_status = tk.StringVar()
        ttk.Label(button_row, textvariable=self.summary_status).pack(side="left")
        self.summary_text = self._build_scrollable_text(summary_frame)

        self._auto_refresh_timer_id: Optional[str] = None
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self._poll()

    @staticmethod
    def _build_scrollable_text(parent: tk.Misc) -> tk.Text:
        text = tk.Text(parent, wrap="word", state="disabled")
        scrollbar = ttk.Scrollbar(parent, command=text.yview)
        text.configure(yscrollcommand=scrollbar.set)
        text.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        return text

    def _poll(self) -> None:
        self._render_new_entries()
        self._drain_summary_results()
        self.root.after(300, self._poll)

    def _drain_summary_results(self) -> None:
        try:
            while True:
                summary, error = self._summary_results.get_nowait()
                self._on_summary_done(summary, error)
        except queue.Empty:
            pass

    def _render_new_entries(self) -> None:
        entries = self._log.snapshot()
        if len(entries) <= self._rendered_count:
            return
        new_entries = entries[self._rendered_count :]
        self._rendered_count = len(entries)

        at_bottom = self._is_scrolled_to_bottom(self.transcript_text)
        self.transcript_text.configure(state="normal")
        for entry in new_entries:
            self.transcript_text.insert("end", format_chat_line(entry) + "\n\n")
        self.transcript_text.configure(state="disabled")
        if at_bottom:
            self.transcript_text.see("end")

        if not self._summarizing and len(entries) - self._summarized_count >= 1:
            self._schedule_auto_refresh()

    def _schedule_auto_refresh(self) -> None:
        if self._auto_refresh_timer_id is not None:
            return  # Already waiting for a scheduled refresh.
        self._auto_refresh_timer_id = self.root.after(
            self._auto_refresh_ms, self._fire_auto_refresh
        )

    def _fire_auto_refresh(self) -> None:
        self._auto_refresh_timer_id = None
        if not self._summarizing:
            self.refresh_summary()

    @staticmethod
    def _is_scrolled_to_bottom(text_widget: tk.Text) -> bool:
        # yview() returns (top_fraction, bottom_fraction); bottom_fraction is
        # ~1.0 when the last line is visible. Checked before inserting so new
        # lines don't yank the view away from history the user scrolled up to
        # read -- only auto-follow if they were already at the bottom.
        _, bottom = text_widget.yview()
        return bottom >= 0.999

    def refresh_summary(self) -> None:
        entries = self._log.snapshot()
        if not entries:
            return
        self._summarizing = True
        self._summarized_count = len(entries)
        self.refresh_button.state(["disabled"])
        self.summary_status.set("要約を生成しています... / Summarizing...")
        threading.Thread(
            target=self._summarize_worker, args=(entries,), daemon=True
        ).start()

    def _summarize_worker(self, entries) -> None:
        transcript_text = format_summary_input(entries)
        try:
            summary = self._summarizer.summarize(transcript_text)
            error = None
        except Exception as exc:  # noqa: BLE001 -- surfaced to the UI, not swallowed
            summary, error = "", exc
        self._summary_results.put((summary, error))

    def _on_summary_done(self, summary: str, error: Optional[Exception]) -> None:
        self._summarizing = False
        self.refresh_button.state(["!disabled"])
        if error is not None:
            self.summary_status.set(f"要約に失敗しました / Failed: {error}")
            return
        self.summary_status.set("")
        self.summary_text.configure(state="normal")
        self.summary_text.delete("1.0", "end")
        self.summary_text.insert("1.0", summary)
        self.summary_text.configure(state="disabled")

    def close(self) -> None:
        if self._on_close:
            self._on_close()
        self.root.destroy()

    def run(self) -> None:
        """Blocks running this window's own Tk mainloop. Only valid when this
        panel wasn't given a `master`."""
        if not self._owns_mainloop:
            raise RuntimeError(
                "run() is only valid when TranscriptPanel owns its own Tk root "
                "(master=None). This instance is embedded in another app's "
                "mainloop."
            )
        self.root.mainloop()
