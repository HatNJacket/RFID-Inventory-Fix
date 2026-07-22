import unittest
from unittest.mock import Mock, patch

from print_agent import AppClient


class PrintAgentBatchTest(unittest.TestCase):
    def test_claim_uses_configured_limit(self):
        client = AppClient("http://example.test", None)
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"jobs": []}

        with patch("print_agent.requests.post", return_value=response) as mock_post:
            client.claim(limit=3)

        mock_post.assert_called_once_with(
            "http://example.test/api/print-jobs/claim",
            params={"limit": 3},
            headers={},
            timeout=30,
        )


if __name__ == "__main__":
    unittest.main()
