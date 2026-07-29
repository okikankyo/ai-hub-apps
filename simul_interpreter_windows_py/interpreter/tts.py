# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Text-to-speech playback for the simultaneous interpreter.

There is no NPU-accelerated TTS model in Qualcomm AI Hub Models today, so this
uses the Windows SAPI5 voices already installed on the system through
`pyttsx3`. Speech runs on a dedicated background thread so it never blocks the
GUI or the ASR/translation pipeline.
"""

from __future__ import annotations

import logging
import queue
import threading

logger = logging.getLogger(__name__)


class Speaker:
    def __init__(
        self, voice_by_lang: dict[str, str] | None = None, rate: int | None = None
    ) -> None:
        self._voice_by_lang = voice_by_lang or {}
        self._rate = rate
        self._queue: queue.Queue[tuple[str, str] | None] = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def speak(self, text: str, lang: str) -> None:
        """Queue `text` to be spoken using the voice configured for `lang`."""
        if text.strip():
            self._queue.put((text, lang))

    def stop(self) -> None:
        self._queue.put(None)
        self._thread.join(timeout=2)

    def _run(self) -> None:
        import pyttsx3

        engine = pyttsx3.init()
        if self._rate:
            engine.setProperty("rate", self._rate)

        while True:
            item = self._queue.get()
            if item is None:
                return
            text, lang = item
            voice_id = self._voice_by_lang.get(lang)
            try:
                if voice_id:
                    engine.setProperty("voice", voice_id)
                engine.say(text)
                engine.runAndWait()
            except Exception:
                logger.exception("TTS playback failed for lang=%s", lang)


def list_installed_voices() -> list[tuple[str, str]]:
    """Return (voice_id, voice_name) for every SAPI5 voice installed on this
    machine. Use this to find the voice ids to pass as `voice_by_lang` to
    `Speaker`, e.g. {"ja": "<id of a Japanese voice>", "en": "<id of an English voice>"}.
    """
    import pyttsx3

    engine = pyttsx3.init()
    return [(v.id, v.name) for v in engine.getProperty("voices")]
