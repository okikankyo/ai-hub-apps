import sys
from pathlib import Path

# Make the app's own top-level packages (interpreter/, gui/) importable
# regardless of the directory pytest is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
