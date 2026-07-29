import queue
import threading

import numpy as np

from interpreter.asr import TranscriptionResult
from interpreter.audio_loopback import LoopbackChunk
from interpreter.translate import EchoTranslator
from subtitles import run_pipeline


class FakeRecorder:
    """Stands in for LoopbackRecorder: start()/stop() are no-ops so the test
    doesn't need a real audio device -- `chunks` is pre-filled directly."""

    def __init__(self, chunks):
        self.chunks: "queue.Queue[LoopbackChunk]" = queue.Queue()
        for chunk in chunks:
            self.chunks.put(chunk)
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


class FakeTranscriber:
    def __init__(self, text: str) -> None:
        self._text = text

    def transcribe(self, audio, sample_rate, expected_language) -> TranscriptionResult:
        return TranscriptionResult(text=self._text, detected_language=expected_language)


def _run_until_drained(recorder, transcriber, translator, on_entry=None):
    results: "queue.Queue[tuple[str, str] | None]" = queue.Queue()
    stop_event = threading.Event()

    thread = threading.Thread(
        target=run_pipeline,
        args=(recorder, transcriber, translator, results, stop_event, on_entry),
        daemon=True,
    )
    thread.start()
    # Give the pipeline a moment to drain the pre-filled chunk(s), then stop it.
    import time

    time.sleep(0.2)
    stop_event.set()
    thread.join(timeout=2.0)
    return results


def test_run_pipeline_calls_on_entry_with_original_and_translated_text():
    chunk = LoopbackChunk(audio=np.zeros(1600, dtype=np.float32), sample_rate=16000)
    recorder = FakeRecorder([chunk])
    seen = []

    _run_until_drained(
        recorder,
        FakeTranscriber("hello there"),
        EchoTranslator(),
        on_entry=lambda original, translated: seen.append((original, translated)),
    )

    assert seen == [("hello there", "[JA] hello there")]


def test_run_pipeline_skips_on_entry_for_empty_transcription():
    chunk = LoopbackChunk(audio=np.zeros(1600, dtype=np.float32), sample_rate=16000)
    recorder = FakeRecorder([chunk])
    seen = []

    _run_until_drained(
        recorder,
        FakeTranscriber("   "),
        EchoTranslator(),
        on_entry=lambda original, translated: seen.append((original, translated)),
    )

    assert seen == []


def test_run_pipeline_works_without_on_entry_callback():
    chunk = LoopbackChunk(audio=np.zeros(1600, dtype=np.float32), sample_rate=16000)
    recorder = FakeRecorder([chunk])

    results = _run_until_drained(recorder, FakeTranscriber("hi"), EchoTranslator())

    items = []
    while not results.empty():
        items.append(results.get_nowait())
    assert ("hi", "[JA] hi") in items


def test_run_pipeline_starts_and_stops_the_recorder():
    recorder = FakeRecorder([])

    _run_until_drained(recorder, FakeTranscriber(""), EchoTranslator())

    assert recorder.started
    assert recorder.stopped
