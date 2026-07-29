from interpreter.transcript import TranscriptLog, format_chat_line, format_summary_input


def test_entry_japanese_text_uses_original_when_speaker_is_japanese():
    log = TranscriptLog()
    entry = log.append(
        source="face_to_face",
        original_lang="ja",
        original_text="こんにちは",
        translated_lang="en",
        translated_text="Hello",
    )

    assert entry.japanese_text == "こんにちは"


def test_entry_japanese_text_uses_translated_when_speaker_is_english():
    log = TranscriptLog()
    entry = log.append(
        source="pc_audio",
        original_lang="en",
        original_text="hello",
        translated_lang="ja",
        translated_text="こんにちは",
    )

    assert entry.japanese_text == "こんにちは"


def test_log_snapshot_preserves_append_order():
    log = TranscriptLog()
    log.append(
        source="face_to_face",
        original_lang="ja",
        original_text="one",
        translated_lang="en",
        translated_text="one-en",
    )
    log.append(
        source="pc_audio",
        original_lang="en",
        original_text="two",
        translated_lang="ja",
        translated_text="two-ja",
    )

    entries = log.snapshot()

    assert [e.original_text for e in entries] == ["one", "two"]


def test_snapshot_is_a_copy_not_a_live_view():
    log = TranscriptLog()
    log.append(
        source="face_to_face",
        original_lang="ja",
        original_text="one",
        translated_lang="en",
        translated_text="one-en",
    )

    snapshot = log.snapshot()
    log.append(
        source="face_to_face",
        original_lang="ja",
        original_text="two",
        translated_lang="en",
        translated_text="two-en",
    )

    assert len(snapshot) == 1


def test_format_chat_line_includes_original_and_translated_text():
    log = TranscriptLog()
    entry = log.append(
        source="pc_audio",
        original_lang="en",
        original_text="hello there",
        translated_lang="ja",
        translated_text="こんにちは",
    )

    line = format_chat_line(entry)

    assert "hello there" in line
    assert "こんにちは" in line


def test_format_summary_input_uses_japanese_text_and_is_chronological():
    log = TranscriptLog()
    log.append(
        source="face_to_face",
        original_lang="ja",
        original_text="一つ目",
        translated_lang="en",
        translated_text="first",
    )
    log.append(
        source="pc_audio",
        original_lang="en",
        original_text="second in english",
        translated_lang="ja",
        translated_text="二つ目",
    )

    text = format_summary_input(log.snapshot())
    lines = text.splitlines()

    assert len(lines) == 2
    assert "一つ目" in lines[0]
    assert "二つ目" in lines[1]
    assert "second in english" not in text


def test_format_summary_input_skips_empty_entries():
    log = TranscriptLog()
    log.append(
        source="pc_audio",
        original_lang="en",
        original_text="   ",
        translated_lang="ja",
        translated_text="   ",
    )
    log.append(
        source="pc_audio",
        original_lang="en",
        original_text="hi",
        translated_lang="ja",
        translated_text="やあ",
    )

    text = format_summary_input(log.snapshot())

    assert text.count("\n") == 0
    assert "やあ" in text
