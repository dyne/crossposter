import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from browser_publish_verification import (  # noqa: E402
    classify_instagram_publish_response,
    classify_x_publish_response,
)


class XPublishVerificationTests(unittest.TestCase):
    def test_confirms_create_tweet_and_returns_permalink(self):
        outcome = classify_x_publish_response(
            "https://x.com/i/api/graphql/abc/CreateTweet",
            "POST",
            200,
            {
                "data": {
                    "create_tweet": {
                        "tweet_results": {"result": {"rest_id": "2084680334571155545"}}
                    }
                }
            },
        )

        self.assertEqual(
            outcome,
            {
                "ok": True,
                "message": "X confirmed the post.",
                "url": "https://x.com/i/status/2084680334571155545",
            },
        )

    def test_reports_graphql_rejection(self):
        outcome = classify_x_publish_response(
            "https://x.com/i/api/graphql/abc/CreateTweet",
            "POST",
            200,
            {"errors": [{"message": "You have already sent this post."}]},
        )

        self.assertEqual(
            outcome,
            {"ok": False, "message": "You have already sent this post."},
        )

    def test_ignores_unrelated_graphql_response(self):
        outcome = classify_x_publish_response(
            "https://x.com/i/api/graphql/abc/HomeTimeline",
            "POST",
            200,
            {"data": {}},
        )

        self.assertIsNone(outcome)


class InstagramPublishVerificationTests(unittest.TestCase):
    def test_confirms_photo_and_returns_permalink(self):
        outcome = classify_instagram_publish_response(
            "https://www.instagram.com/api/v1/media/configure/",
            "POST",
            200,
            {"status": "ok", "media": {"pk": "123", "code": "DboAoHICdI1"}},
            "image",
        )

        self.assertEqual(
            outcome,
            {
                "ok": True,
                "message": "Instagram confirmed the post.",
                "url": "https://www.instagram.com/p/DboAoHICdI1/",
            },
        )

    def test_confirms_reel_and_returns_permalink(self):
        outcome = classify_instagram_publish_response(
            "https://www.instagram.com/api/v1/media/configure_to_clips/",
            "POST",
            200,
            {"status": "ok", "media": {"id": "456", "code": "Dabc123"}},
            "video",
        )

        self.assertEqual(outcome["url"], "https://www.instagram.com/reel/Dabc123/")

    def test_reports_api_rejection(self):
        outcome = classify_instagram_publish_response(
            "https://www.instagram.com/api/v1/web/create/configure/",
            "POST",
            400,
            {"status": "fail", "message": "Please try again later."},
            "image",
        )

        self.assertEqual(
            outcome,
            {"ok": False, "message": "Please try again later."},
        )

    def test_ignores_upload_response(self):
        outcome = classify_instagram_publish_response(
            "https://www.instagram.com/rupload_igphoto/abc",
            "POST",
            200,
            {"status": "ok"},
            "image",
        )

        self.assertIsNone(outcome)


if __name__ == "__main__":
    unittest.main()
