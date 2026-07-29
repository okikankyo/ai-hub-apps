import numpy as np
import pytest

from interpreter.asr import TranscriptionResult
from interpreter.conversation import ConversationSession, confirmation_level, similarity
from interpreter.translate import EchoTranslator


class FakeTranscriber:
    def __init__(self, text: str, detected_language: str | None = None) -> None:
        self._text = text
        self._detected_language = detected_language

    def transcribe(self, audio, sample_rate, expected_language) -> TranscriptionResult:
        return TranscriptionResult(
            text=self._text, detected_language=self._detected_language
        )


def test_process_text_ja_to_en_populates_all_fields():
    session = ConversationSession(FakeTranscriber(""), EchoTranslator())

    turn = session.process_text("こんにちは", "ja")

    assert turn.speaker_lang == "ja"
    assert turn.listener_lang == "en"
    assert turn.original_text == "こんにちは"
    assert turn.translated_text == "[EN] こんにちは"
    assert turn.back_translated_text == "[JA] [EN] こんにちは"
    assert 0.0 <= turn.confirmation_score <= 1.0
    assert turn.confirmation_level in ("high", "medium", "low")
    assert session.turns == [turn]


def test_process_text_en_to_ja():
    session = ConversationSession(FakeTranscriber(""), EchoTranslator())

    turn = session.process_text("Hello", "en")

    assert turn.speaker_lang == "en"
    assert turn.listener_lang == "ja"
    assert turn.translated_text == "[JA] Hello"


def test_process_text_rejects_unsupported_language():
    session = ConversationSession(FakeTranscriber(""), EchoTranslator())

    with pytest.raises(ValueError):
        session.process_text("bonjour", "fr")


def test_process_utterance_uses_transcriber_then_translator():
    session = ConversationSession(
        FakeTranscriber("test audio transcript"), EchoTranslator()
    )

    turn = session.process_utterance(np.zeros(16000, dtype=np.float32), "ja")

    assert turn.original_text == "test audio transcript"
    assert turn.translated_text == "[EN] test audio transcript"


def test_multiple_turns_accumulate_in_order():
    session = ConversationSession(FakeTranscriber(""), EchoTranslator())

    first = session.process_text("one", "ja")
    second = session.process_text("two", "en")

    assert session.turns == [first, second]


def test_similarity_identical_strings_is_one():
    assert similarity("hello", "hello") == 1.0


def test_similarity_completely_different_strings_is_low():
    assert similarity("hello", "xyzzy") < 0.3


def test_similarity_is_case_and_whitespace_insensitive():
    assert similarity("  Hello World  ", "hello world") == 1.0


@pytest.mark.parametrize(
    ("score", "expected_level"),
    [(1.0, "high"), (0.6, "high"), (0.4, "medium"), (0.35, "medium"), (0.1, "low")],
)
def test_confirmation_level_thresholds(score, expected_level):
    assert confirmation_level(score) == expected_level
