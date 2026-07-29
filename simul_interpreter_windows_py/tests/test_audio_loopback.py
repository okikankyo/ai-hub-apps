import numpy as np
import pytest

from interpreter.audio_loopback import LoopbackRecorder


def test_ingest_flushes_once_chunk_samples_reached():
    recorder = LoopbackRecorder(chunk_seconds=1.0, sample_rate=1000)

    recorder.ingest(np.zeros((400, 2), dtype=np.float32))
    assert recorder.chunks.empty()

    recorder.ingest(np.zeros((400, 2), dtype=np.float32))
    assert recorder.chunks.empty()

    recorder.ingest(np.zeros((400, 2), dtype=np.float32))
    assert not recorder.chunks.empty()

    chunk = recorder.chunks.get_nowait()
    assert chunk.sample_rate == 1000
    assert len(chunk.audio) == 1200  # all buffered samples flush together


def test_ingest_downmixes_stereo_to_mono():
    recorder = LoopbackRecorder(chunk_seconds=0.001, sample_rate=1000)

    stereo = np.array([[1.0, 3.0], [2.0, 4.0]], dtype=np.float32)
    recorder.ingest(stereo)

    chunk = recorder.chunks.get_nowait()
    assert chunk.audio.ndim == 1
    np.testing.assert_allclose(chunk.audio, [2.0, 3.0])


def test_ingest_accepts_already_mono_audio():
    recorder = LoopbackRecorder(chunk_seconds=0.001, sample_rate=1000)

    recorder.ingest(np.array([0.1, 0.2, 0.3], dtype=np.float32))

    chunk = recorder.chunks.get_nowait()
    np.testing.assert_allclose(chunk.audio, [0.1, 0.2, 0.3])


def test_buffer_resets_after_flush():
    recorder = LoopbackRecorder(chunk_seconds=0.001, sample_rate=1000)

    recorder.ingest(np.array([0.1], dtype=np.float32))
    recorder.chunks.get_nowait()

    recorder.ingest(np.array([0.2], dtype=np.float32))
    chunk = recorder.chunks.get_nowait()
    np.testing.assert_allclose(chunk.audio, [0.2])


def test_stop_flushes_remaining_buffer_without_a_started_stream():
    recorder = LoopbackRecorder(chunk_seconds=10.0, sample_rate=1000)

    recorder.ingest(np.zeros((5, 2), dtype=np.float32))
    assert recorder.chunks.empty()

    recorder.stop()

    assert not recorder.chunks.empty()
    chunk = recorder.chunks.get_nowait()
    assert len(chunk.audio) == 5


def test_ingest_with_no_data_does_not_flush_empty_chunk():
    recorder = LoopbackRecorder(chunk_seconds=10.0, sample_rate=1000)
    recorder.stop()
    assert recorder.chunks.empty()


class _FakeDefault:
    def __init__(self, output_device):
        self.device = (0, output_device)


class _FakeSoundDeviceModule:
    def __init__(self, output_device):
        self.default = _FakeDefault(output_device)


def test_default_loopback_device_returns_default_output_index():
    fake_sd = _FakeSoundDeviceModule(output_device=3)
    assert LoopbackRecorder._default_loopback_device(fake_sd) == 3


def test_default_loopback_device_raises_when_none_configured():
    fake_sd = _FakeSoundDeviceModule(output_device=None)
    with pytest.raises(RuntimeError):
        LoopbackRecorder._default_loopback_device(fake_sd)
