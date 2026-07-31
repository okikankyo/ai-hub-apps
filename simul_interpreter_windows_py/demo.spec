# -*- mode: python ; coding: utf-8 -*-
# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
# PyInstaller spec for demo.py -- see README.md "Building a standalone .exe"
# for what this does and doesn't solve. Build with `.\build_exe.ps1` (which
# also handles the venv/dependency install), or directly via
# `pyinstaller demo.spec` once your venv already has this app's
# dependencies + pyinstaller installed.
#
# `collect_all` is used for the packages most likely to break under
# PyInstaller's static import analysis: qai_hub_models and onnxruntime both
# do a fair amount of dynamic/lazy importing and (for onnxruntime-qnn) ship
# native QNN execution-provider DLLs that aren't reachable via a plain
# `import` graph walk. If the built exe fails at runtime with a missing
# module/DLL, that's the first place to look -- add the offending package
# here rather than to hiddenimports/binaries by hand.
from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = [
    "win32com.client",
    "win32timezone",
    "pythoncom",
    "pywintypes",
]

for pkg in ("onnxruntime", "qai_hub_models", "sounddevice", "pyttsx3", "screeninfo"):
    pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hiddenimports

a = Analysis(
    ["demo.py"],
    pathex=[SPECPATH],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="demo",
    # Keeping a console window (rather than windowed/no-console) so
    # --list-audio-devices/--list-voices output and any startup tracebacks
    # are visible -- this hasn't been run on a real machine yet (see
    # README), so surfacing errors matters more than a clean window right
    # now. Switch to console=False once the build is confirmed working.
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="demo",
)
