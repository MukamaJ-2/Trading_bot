import os
import sys
import tempfile
from pathlib import Path

# Isolated state dir and demo-free settings before the app is imported.
os.environ["KITE_STATE_DIR"] = tempfile.mkdtemp(prefix="kite-test-")
os.environ["KITE_DEMO"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
