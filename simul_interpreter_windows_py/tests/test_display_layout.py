from collections import namedtuple

import screeninfo

from interpreter.display_layout import detect_dual_monitor_layout

FakeMonitor = namedtuple("FakeMonitor", ["x", "y", "width", "height"])


def test_two_monitors_assigns_first_to_self_and_second_to_guest(monkeypatch):
    monitors = [FakeMonitor(0, 0, 1920, 1080), FakeMonitor(1920, 0, 1280, 720)]
    monkeypatch.setattr(screeninfo, "get_monitors", lambda: monitors)

    layout = detect_dual_monitor_layout(guest_monitor_index=1)

    assert layout.single_monitor is False
    assert layout.self_geometry == "1920x1080+0+0"
    assert layout.guest_geometry == "1280x720+1920+0"


def test_guest_monitor_index_out_of_range_clamps_to_last_monitor(monkeypatch):
    monitors = [FakeMonitor(0, 0, 1920, 1080), FakeMonitor(1920, 0, 1280, 720)]
    monkeypatch.setattr(screeninfo, "get_monitors", lambda: monitors)

    layout = detect_dual_monitor_layout(guest_monitor_index=5)

    assert layout.guest_geometry == "1280x720+1920+0"


def test_single_monitor_falls_back_to_split_layout(monkeypatch):
    monitors = [FakeMonitor(0, 0, 1920, 1080)]
    monkeypatch.setattr(screeninfo, "get_monitors", lambda: monitors)

    layout = detect_dual_monitor_layout()

    assert layout.single_monitor is True
    assert layout.self_geometry == "960x1080+0+0"
    assert layout.guest_geometry == "960x1080+960+0"


def test_no_monitors_detected_falls_back_to_defaults(monkeypatch):
    monkeypatch.setattr(screeninfo, "get_monitors", lambda: [])

    layout = detect_dual_monitor_layout()

    assert layout.single_monitor is True
    assert layout.self_geometry
    assert layout.guest_geometry


def test_screeninfo_error_is_treated_as_no_monitors(monkeypatch):
    def raise_error():
        raise screeninfo.common.ScreenInfoError("no backend")

    monkeypatch.setattr(screeninfo, "get_monitors", raise_error)

    layout = detect_dual_monitor_layout()

    assert layout.single_monitor is True
