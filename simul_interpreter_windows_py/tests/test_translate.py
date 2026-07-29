import json
import subprocess
from pathlib import Path

import pytest

from interpreter.translate import ChatTemplate, EchoTranslator, GenieTranslator

METADATA = {
    "genie": {
        "chat_template": {
            "system_prefix": "<|system|>",
            "system_suffix": "<|end|>",
            "user_prefix": "<|user|>",
            "user_suffix": "<|end|>",
            "assistant_prefix": "<|assistant|>",
            "default_system_prompt": "You are a helpful assistant.",
        }
    }
}


@pytest.fixture
def metadata_path(tmp_path: Path) -> Path:
    path = tmp_path / "metadata.json"
    path.write_text(json.dumps(METADATA), encoding="utf-8")
    return path


def test_chat_template_from_metadata_json(metadata_path: Path):
    template = ChatTemplate.from_metadata_json(metadata_path)

    assert template.system_prefix == "<|system|>"
    assert template.assistant_prefix == "<|assistant|>"


def test_chat_template_build_prompt_order(metadata_path: Path):
    template = ChatTemplate.from_metadata_json(metadata_path)

    prompt = template.build_prompt("Translate to English.", "こんにちは")

    assert prompt == (
        "<|system|>Translate to English.<|end|>"
        "<|user|>こんにちは<|end|>"
        "<|assistant|>"
    )


def test_echo_translator_tags_by_source_language():
    translator = EchoTranslator()

    assert translator.translate("hi", "ja", "en") == "[EN] hi"
    assert translator.translate("hi", "en", "ja") == "[JA] hi"


def test_echo_translator_empty_text_returns_empty():
    assert EchoTranslator().translate("   ", "ja", "en") == ""


def test_genie_translator_rejects_unconfigured_language_pair(metadata_path: Path):
    translator = GenieTranslator(
        genie_config_path="unused.json", chat_template_path=metadata_path
    )

    with pytest.raises(ValueError):
        translator.translate("bonjour", "fr", "en")


def test_genie_translator_invokes_cli_and_parses_stdout(monkeypatch, metadata_path: Path):
    captured = {}

    def fake_run(cmd, capture_output, text, timeout, check):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="  Hello there  \n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    translator = GenieTranslator(
        genie_config_path="genie_config.json",
        chat_template_path=metadata_path,
        executable="genie-t2t-run.exe",
    )
    result = translator.translate("こんにちは", "ja", "en")

    assert result == "Hello there"
    assert captured["cmd"][0] == "genie-t2t-run.exe"
    assert "--config" in captured["cmd"]
    assert "genie_config.json" in captured["cmd"]
    assert "--prompt" in captured["cmd"]


def test_genie_translator_empty_text_skips_subprocess(monkeypatch, metadata_path: Path):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("subprocess.run should not be called for empty text")

    monkeypatch.setattr(subprocess, "run", fail_if_called)

    translator = GenieTranslator(
        genie_config_path="genie_config.json", chat_template_path=metadata_path
    )
    assert translator.translate("   ", "ja", "en") == ""
