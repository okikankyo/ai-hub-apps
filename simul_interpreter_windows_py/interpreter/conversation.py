# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Conversation state for a face-to-face Japanese <-> English interpretation
session, including the "did my meaning survive translation" confirmation
check via back-translation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from difflib import SequenceMatcher
from typing import Callable, Optional

import numpy as np

from interpreter.asr import SAMPLE_RATE, Transcriber
from interpreter.translate import Translator

LANGUAGE_PAIR = {"ja": "en", "en": "ja"}

# Thresholds for `similarity()`, a same-language string comparison between the
# original utterance and its round-trip back-translation. This is a coarse,
# model-free heuristic meant to flag "you may want to double check this,"
# not a claim of semantic equivalence.
_HIGH_CONFIRMATION_THRESHOLD = 0.6
_MEDIUM_CONFIRMATION_THRESHOLD = 0.35


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.strip().lower(), b.strip().lower()).ratio()


def confirmation_level(score: float) -> str:
    if score >= _HIGH_CONFIRMATION_THRESHOLD:
        return "high"
    if score >= _MEDIUM_CONFIRMATION_THRESHOLD:
        return "medium"
    return "low"


@dataclass
class Turn:
    speaker_lang: str
    listener_lang: str
    original_text: str
    translated_text: str
    back_translated_text: str
    confirmation_score: float
    confirmation_level: str
    timestamp: datetime = field(default_factory=datetime.now)


class ConversationSession:
    """Owns the running transcript for one interpretation session and drives
    each utterance through ASR -> translation -> back-translation."""

    def __init__(
        self,
        transcriber: Transcriber,
        translator: Translator,
        on_turn: Optional[Callable[[Turn], None]] = None,
    ) -> None:
        self._transcriber = transcriber
        self._translator = translator
        self._on_turn = on_turn
        self.turns: list[Turn] = []

    def process_utterance(
        self, audio: np.ndarray, speaker_lang: str, sample_rate: int = SAMPLE_RATE
    ) -> Turn:
        """Transcribe recorded audio spoken in `speaker_lang`, translate it for the
        other party, and back-translate the result for a meaning-confirmation check.
        """
        transcription = self._transcriber.transcribe(audio, sample_rate, speaker_lang)
        return self._process_text(transcription.text, speaker_lang)

    def process_text(self, text: str, speaker_lang: str) -> Turn:
        """Same as `process_utterance`, for already-transcribed (or typed) text --
        used by callers that don't have raw audio, e.g. tests or a typed-input
        fallback in the GUI."""
        return self._process_text(text, speaker_lang)

    def _process_text(self, text: str, speaker_lang: str) -> Turn:
        if speaker_lang not in LANGUAGE_PAIR:
            raise ValueError(f"Unsupported language: {speaker_lang!r}")
        listener_lang = LANGUAGE_PAIR[speaker_lang]

        translated_text = self._translator.translate(text, speaker_lang, listener_lang)
        back_translated_text = self._translator.translate(
            translated_text, listener_lang, speaker_lang
        )
        score = similarity(text, back_translated_text)

        turn = Turn(
            speaker_lang=speaker_lang,
            listener_lang=listener_lang,
            original_text=text,
            translated_text=translated_text,
            back_translated_text=back_translated_text,
            confirmation_score=score,
            confirmation_level=confirmation_level(score),
        )
        self.turns.append(turn)
        if self._on_turn is not None:
            self._on_turn(turn)
        return turn
