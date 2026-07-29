# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Captures this PC's own audio *output* (a YouTube tab, an online call app's
incoming audio, etc.) for live subtitle translation -- for when you can't get
the other party to run any translation themselves.

This is WASAPI loopback capture, which is Windows-only: PortAudio opens an
*input* stream on an *output* device and, with `WasapiSettings(loopback=True)`,
receives whatever that device is currently playing instead of playing to it.
"""

from __future__ import annotations

import logging
import queue
from dataclasses import dataclass

import numpy as np

from interpreter.asr import SAMPLE_RATE

logger = logging.getLogger(__name__)


@dataclass
class LoopbackChunk:
    audio: np.ndarray
    sample_rate: int


class LoopbackRecorder:
    """Streams system-output audio in fixed-size chunks, pushing each finished
    chunk onto `chunks` for a consumer thread to transcribe. Chunking on a
    timer (rather than voice-activity detection) mirrors
    ../whisper_windows_py/demo.py's `--stream-audio-chunk-size` approach --
    simple, and good enough for the several-second granularity live subtitles
    need.
    """

    def __init__(
        self,
        chunk_seconds: float = 6.0,
        sample_rate: int = SAMPLE_RATE,
        device: int | str | None = None,
    ) -> None:
        self._chunk_seconds = chunk_seconds
        self._sample_rate = sample_rate
        self._device = device
        self._chunk_samples = int(chunk_seconds * sample_rate)
        self.chunks: queue.Queue[LoopbackChunk] = queue.Queue()
        self._stream = None
        self._buffer: list[np.ndarray] = []
        self._buffered_samples = 0

    def start(self) -> None:
        import sounddevice as sd

        device = self._device
        if device is None:
            device = self._default_loopback_device(sd)

        extra_settings = None
        if hasattr(sd, "WasapiSettings"):
            extra_settings = sd.WasapiSettings(loopback=True)
        else:
            logger.warning(
                "sounddevice.WasapiSettings is unavailable on this platform -- "
                "system-audio loopback capture requires Windows + WASAPI."
            )

        self._stream = sd.InputStream(
            samplerate=self._sample_rate,
            channels=2,
            device=device,
            callback=self._on_audio,
            extra_settings=extra_settings,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        self._flush()

    def _on_audio(self, indata, frames, time, status) -> None:
        if status:
            logger.warning("Loopback input status: %s", status)
        self.ingest(indata)

    def ingest(self, indata: np.ndarray) -> None:
        """Core chunking logic, split out from the sounddevice callback so it
        can be unit-tested without a real audio device: downmixes a raw audio
        block to mono and flushes a chunk once enough samples have
        accumulated."""
        array = np.asarray(indata, dtype=np.float32)
        mono = array.mean(axis=1) if array.ndim == 2 and array.shape[1] > 1 else array.reshape(-1)
        self._buffer.append(mono)
        self._buffered_samples += len(mono)
        if self._buffered_samples >= self._chunk_samples:
            self._flush()

    def _flush(self) -> None:
        if not self._buffer:
            return
        audio = np.concatenate(self._buffer, axis=0)
        self._buffer = []
        self._buffered_samples = 0
        self.chunks.put(LoopbackChunk(audio=audio, sample_rate=self._sample_rate))

    @staticmethod
    def _default_loopback_device(sd) -> int:
        default_output = sd.default.device[1]
        if default_output is None or default_output < 0:
            raise RuntimeError(
                "No default output device found. Pass --loopback-device explicitly "
                "(see --list-audio-devices)."
            )
        return default_output
