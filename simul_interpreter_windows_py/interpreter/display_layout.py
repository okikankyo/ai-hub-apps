# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Dual-monitor window placement for the interpreter's two interfaces:
one facing the Japanese speaker, one facing the foreign guest."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class MonitorLayout:
    # Tkinter geometry strings ("widthxheight+x+y") for each window.
    self_geometry: str
    guest_geometry: str
    # True if a second physical monitor wasn't found and the layout is a
    # same-screen fallback (e.g. for development on a single-monitor machine).
    single_monitor: bool


def detect_dual_monitor_layout(guest_monitor_index: int = 1) -> MonitorLayout:
    """Look up connected monitors and assign one to the self-facing (Japanese)
    window and one to the guest-facing window. Falls back to splitting a
    single monitor in half left/right if a second display isn't connected.
    """
    import screeninfo

    try:
        monitors = screeninfo.get_monitors()
    except screeninfo.common.ScreenInfoError:
        monitors = []

    if len(monitors) >= 2:
        self_m = monitors[0]
        guest_m = monitors[min(guest_monitor_index, len(monitors) - 1)]
        return MonitorLayout(
            self_geometry=_geometry(self_m),
            guest_geometry=_geometry(guest_m),
            single_monitor=False,
        )

    if not monitors:
        return MonitorLayout(
            self_geometry="800x600+0+0",
            guest_geometry="800x600+820+0",
            single_monitor=True,
        )

    m = monitors[0]
    half_width = m.width // 2
    return MonitorLayout(
        self_geometry=f"{half_width}x{m.height}+{m.x}+{m.y}",
        guest_geometry=f"{half_width}x{m.height}+{m.x + half_width}+{m.y}",
        single_monitor=True,
    )


def _geometry(monitor) -> str:
    return f"{monitor.width}x{monitor.height}+{monitor.x}+{monitor.y}"
