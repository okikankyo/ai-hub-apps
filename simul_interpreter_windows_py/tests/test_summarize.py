import subprocess
from pathlib import Path

import pytest

from interpreter.summarize import EchoSummarizer, GenieSummarizer

METADATA = {
    "genie": {
        "chat_template": {
            "system_prefix": "<|system|>",
            "system_suffix": "<|end|>",
            "user_prefix": "<|user|>",
            "user_suffix": "<|end|>",
            "assistant_prefix": "<|assistant|>",
        }
    }
}


@pytest.fixture
def metadata_path(tmp_path: Path) -> Path:
    import json

    path = tmp_path / "metadata.json"
    path.write_text(json.dumps(METADATA), encoding="utf-8")
    return path


def test_echo_summarizer_empty_text_returns_empty():
    assert EchoSummarizer().summarize("   ") == ""


def test_echo_summarizer_echoes_input_with_tag():
    result = EchoSummarizer().summarize("[10:00:00] hello")

    assert result == "[SUMMARY]\n[10:00:00] hello"


def test_genie_summarizer_invokes_cli_and_parses_stdout(monkeypatch, metadata_path: Path):
    captured = {}

    def fake_run(cmd, capture_output, text, timeout, check):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="  Topic A, then topic B.  \n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    summarizer = GenieSummarizer(
        genie_config_path="genie_config.json",
        chat_template_path=metadata_path,
        executable="genie-t2t-run.exe",
    )
    result = summarizer.summarize("[10:00:00] one\n[10:05:00] two")

    assert result == "Topic A, then topic B."
    assert captured["cmd"][0] == "genie-t2t-run.exe"
    assert "--config" in captured["cmd"]
    assert "genie_config.json" in captured["cmd"]
    assert "--prompt" in captured["cmd"]
    # The system prompt (built into the assembled prompt) should ask for
    # chronological, topic-shift-aware structure -- that's the whole point of
    # this feature versus a generic one-paragraph summary.
    prompt = captured["cmd"][captured["cmd"].index("--prompt") + 1]
    assert "chronological" in prompt.lower()
    assert "topic" in prompt.lower()


def test_genie_summarizer_empty_text_skips_subprocess(monkeypatch, metadata_path: Path):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("subprocess.run should not be called for empty text")

    monkeypatch.setattr(subprocess, "run", fail_if_called)

    summarizer = GenieSummarizer(
        genie_config_path="genie_config.json", chat_template_path=metadata_path
    )
    assert summarizer.summarize("   ") == ""
