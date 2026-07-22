import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class ConfigDefaultsTest(unittest.TestCase):
    def test_database_url_defaults_to_sqlite_when_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            import app.config as config

            reloaded = importlib.reload(config)

            self.assertEqual(reloaded.DATABASE_URL, "sqlite:///./local.db")


if __name__ == "__main__":
    unittest.main()
