param (
    [string]$venv_name = "AI_Hub_Interpreter",
    [string]$model = "whisper-base"
)

# One-shot build: creates/activates the same conda venv as `activate_venv.ps1`,
# installs this app's Python dependencies (same as `install_python_deps.ps1`),
# installs PyInstaller, then packages demo.py into a standalone demo.exe under
# dist\demo\. See README.md "Building a standalone .exe" for what this does
# and doesn't solve -- in particular, it does NOT bundle the QAIRT SDK's
# genie-t2t-run.exe or the models\ folder; both still need to sit next to
# dist\demo\demo.exe (or be reachable via PATH / --genie-executable), exactly
# as when running `python demo.py` from source.

$ErrorActionPreference = "Stop"

.\activate_venv.ps1 -name $venv_name
.\install_python_deps.ps1 -model $model

python -m pip install "pyinstaller==6.11.1"

pyinstaller demo.spec --noconfirm

Write-Host ""
Write-Host "Built dist\demo\demo.exe"
Write-Host "Before running it: copy (or symlink) your models\ folder next to dist\demo\demo.exe,"
Write-Host "and make sure genie-t2t-run.exe is on PATH (or pass --genie-executable with its"
Write-Host "full path). Then run it the same way as 'python demo.py', e.g.:"
Write-Host ""
Write-Host "  dist\demo\demo.exe --translator echo"
Write-Host ""
Write-Host "This build has not been run on a real machine yet -- if it fails with a missing"
Write-Host "module or DLL error, please share the exact error message so demo.spec's"
Write-Host "collect_all list can be fixed."
