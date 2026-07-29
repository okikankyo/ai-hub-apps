# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Speech-to-text for the simultaneous interpreter, backed by Whisper running on the
Snapdragon NPU via ONNX Runtime + QNN (same model family as ../whisper_windows_py)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

import numpy as np

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000


@dataclass
class TranscriptionResult:
    text: str
    # Language whisper's decoder emitted a language token for (e.g. "ja", "en"),
    # or None if it could not be determined from the output tokens.
    detected_language: str | None


class Transcriber(Protocol):
    def transcribe(
        self, audio: np.ndarray, sample_rate: int, expected_language: str
    ) -> TranscriptionResult: ...


class WhisperTranscriber:
    """Transcribes short utterances using qai_hub_models' precompiled, QNN-accelerated
    Whisper encoder/decoder. Whisper is multilingual and auto-detects the spoken
    language, so the same pair of models is reused for both the Japanese and the
    English side of the conversation.
    """

    def __init__(
        self,
        encoder_path: str,
        decoder_path: str,
        model_id: str = "openai/whisper-base",
    ) -> None:
        # Imported lazily: qai_hub_models + onnxruntime-qnn are heavy, Windows/NPU-only
        # dependencies that dev/test code paths should not need to import.
        from qai_hub_models.models._shared.hf_whisper.app import HfWhisperApp
        from qai_hub_models.utils.onnx.torch_wrapper import OnnxModelTorchWrapper

        self._app = HfWhisperApp(
            OnnxModelTorchWrapper.OnNPU(encoder_path),
            OnnxModelTorchWrapper.OnNPU(decoder_path),
            model_id,
        )

    def transcribe(
        self, audio: np.ndarray, sample_rate: int, expected_language: str
    ) -> TranscriptionResult:
        tokens = self._app.transcribe_tokens(audio, sample_rate)
        text = self._app.tokenizer.decode(tokens, skip_special_tokens=True).strip()
        detected_language = self._detect_language(tokens)
        if detected_language and detected_language != expected_language:
            logger.warning(
                "Expected speech in '%s' but Whisper detected '%s'. Transcript: %r",
                expected_language,
                detected_language,
                text,
            )
        return TranscriptionResult(text=text, detected_language=detected_language)

    def _detect_language(self, tokens: list[int]) -> str | None:
        tokenizer = self._app.tokenizer
        # The language token is one of the first few tokens the decoder emits,
        # right after <|startoftranscript|>, e.g. "<|ja|>" or "<|en|>".
        for token_id in tokens[:4]:
            token_str = tokenizer.decode([token_id]).strip()
            if token_str.startswith("<|") and token_str.endswith("|>"):
                code = token_str[2:-2]
                if code in ("ja", "en"):
                    return code
        return None
