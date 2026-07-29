# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Turns a running transcript (see `interpreter/transcript.py`) into a short,
chronologically-organized summary -- so that if the topic drifted partway
through a long conversation or video, you can still tell what was said when,
instead of getting one blended paragraph.

Reuses the same on-device Genie LLM as `interpreter/translate.py` (just a
different system prompt), since a summary is a short, occasional request --
a good fit for the same NPU-accelerated path already loaded for translation,
rather than a separate model.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Protocol

from interpreter.translate import ChatTemplate, run_genie_completion

# Told explicitly to preserve chronology and flag topic shifts, since a
# general-purpose instruct LLM's default instinct is to blend everything
# into one tidy paragraph -- which is exactly what loses the "topic changed
# partway through" structure this is meant to keep visible.
SUMMARY_SYSTEM_PROMPT = (
    "You will be given a timestamped transcript of a live conversation or "
    "audio feed, in Japanese. The topic may change one or more times. "
    "Summarize it in Japanese, preserving chronological order: split the "
    "summary into separate bullet points per topic (not one blended "
    "paragraph), and when the topic changes partway through, start a new "
    "bullet noting the approximate time it changed. Be concise. Output only "
    "the summary."
)


class Summarizer(Protocol):
    def summarize(self, transcript_text: str) -> str: ...


class GenieSummarizer:
    """Same CLI contract as `GenieTranslator` -- see its docstring for the
    `genie-t2t-run --config <path> --prompt <text>` assumption and how to
    override it if your QAIRT SDK version differs."""

    def __init__(
        self,
        genie_config_path: str | Path,
        chat_template_path: str | Path,
        executable: str = "genie-t2t-run.exe",
        config_flag: str = "--config",
        prompt_flag: str = "--prompt",
        timeout_seconds: float = 45.0,
        response_parser: Callable[[str], str] | None = None,
    ) -> None:
        self._genie_config_path = str(genie_config_path)
        self._template = ChatTemplate.from_metadata_json(chat_template_path)
        self._executable = executable
        self._config_flag = config_flag
        self._prompt_flag = prompt_flag
        self._timeout_seconds = timeout_seconds
        self._response_parser = response_parser or self._default_response_parser

    def summarize(self, transcript_text: str) -> str:
        if not transcript_text.strip():
            return ""

        prompt = self._template.build_prompt(SUMMARY_SYSTEM_PROMPT, transcript_text)
        stdout = run_genie_completion(
            self._executable,
            self._config_flag,
            self._genie_config_path,
            self._prompt_flag,
            prompt,
            self._timeout_seconds,
        )
        return self._response_parser(stdout)

    @staticmethod
    def _default_response_parser(stdout: str) -> str:
        return stdout.strip()


class EchoSummarizer:
    """Dev/test stand-in for `GenieSummarizer` -- no model, NPU, or
    Windows-only executable required. Not a real summary."""

    def summarize(self, transcript_text: str) -> str:
        if not transcript_text.strip():
            return ""
        return "[SUMMARY]\n" + transcript_text
