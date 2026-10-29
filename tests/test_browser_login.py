import contextlib
import importlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from browser_session import launch_browser, login_session


class FakePage:
    def __init__(self, context, challenge=False, broken=False, authenticate=True):
        self.context = context
        self.url = "https://example.test/login"
        self.fields = {}
        self.challenge = challenge
        self.broken = broken
        self.authenticate = authenticate
        self.now = 0

    def goto(self, url, **kwargs):
        self.url = url

    def locator(self, selector):
        page = self

        class Field:
            @property
            def first(self):
                return self

            def fill(self, value, **kwargs):
                if page.broken:
                    raise RuntimeError("Do not expose fixture-password")
                page.fields["password" if 'password' in selector else "username"] = value

            def press(self, key, **kwargs):
                if 'password' in selector:
                    page.context.authenticated = page.authenticate and not page.challenge
                    if page.challenge:
                        page.url = "https://example.test/challenge/"
        return Field()

    def wait_for_timeout(self, milliseconds):
        self.now += milliseconds / 1000


class BrowserSessionTests(unittest.TestCase):
    def test_native_defaults_do_not_override_identity_locale_or_window(self):
        for prefix in ("X", "INSTAGRAM"):
            with self.subTest(prefix=prefix), tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
                browser = Mock()
                launch_browser(browser, folder, True, prefix)
                self.assertEqual(browser.chromium.launch_persistent_context.call_args.kwargs,
                                 {"channel": "chrome", "headless": True, "no_viewport": True})

    def test_configured_channel_locale_and_viewport_and_chrome_fallback(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "X_BROWSER_CHANNEL": "chromium", "X_BROWSER_LOCALE": "it-IT", "X_BROWSER_VIEWPORT": "1440x900"
        }, clear=True):
            browser = Mock()
            launch_browser(browser, folder, False, "X")
            self.assertEqual(browser.chromium.launch_persistent_context.call_args.kwargs,
                             {"channel": "chromium", "headless": False, "locale": "it-IT", "viewport": {"width": 1440, "height": 900}})
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            browser = Mock()
            browser.chromium.launch_persistent_context.side_effect = [RuntimeError("Chrome missing"), "context"]
            self.assertEqual(launch_browser(browser, folder, True, "X"), "context")
            self.assertEqual([c.kwargs["channel"] for c in browser.chromium.launch_persistent_context.call_args_list], ["chrome", "chromium"])

    def test_invalid_config_is_rejected_before_browser_launch(self):
        for key, value in (("CHANNEL", "unknown"), ("LOCALE", "bad locale"), ("VIEWPORT", "0x900")):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {f"X_BROWSER_{key}": value}, clear=True):
                browser = Mock()
                with self.assertRaises(ValueError):
                    launch_browser(browser, folder, True, "X")
                browser.chromium.launch_persistent_context.assert_not_called()

    def login(self, prefix, *, saved=False, credentials=True, challenge=False, broken=False, authenticate=True, headless=True):
        context = Mock(authenticated=saved)
        page = FakePage(context, challenge, broken, authenticate)
        context.pages = [page]
        env = {f"{prefix}_BROWSER_LOGIN_USERNAME": "fixture-user", f"{prefix}_BROWSER_LOGIN_PASSWORD": "fixture-password"} if credentials else {}
        with patch.dict(os.environ, env, clear=True), patch("browser_session.time.monotonic", side_effect=lambda: page.now):
            result = login_session(context, 1000, headless, prefix, prefix, "https://example.test/login", lambda c: c.authenticated)
        return result, page

    def test_headless_reuses_saved_session_without_credentials_or_navigation(self):
        result, page = self.login("X", saved=True, credentials=False)
        self.assertTrue(result["ok"])
        self.assertEqual(page.fields, {})

    def test_headless_submits_credentials_and_persists_authenticated_session(self):
        for prefix in ("X", "INSTAGRAM"):
            with self.subTest(prefix=prefix):
                result, page = self.login(prefix)
                self.assertTrue(result["ok"])
                self.assertEqual(page.fields, {"username": "fixture-user", "password": "fixture-password"})

    def test_missing_credentials_challenge_and_timeout_require_visible_login(self):
        for options in ({"credentials": False}, {"challenge": True}, {"authenticate": False}):
            with self.subTest(options=options):
                result, _ = self.login("INSTAGRAM", **options)
                self.assertFalse(result["ok"])
                self.assertIn("INSTAGRAM_BROWSER_LOGIN_HEADLESS=false", result["message"])

    def test_credential_action_errors_do_not_echo_password(self):
        result, _ = self.login("X", broken=True)
        self.assertFalse(result["ok"])
        self.assertNotIn("fixture-password", result["message"])

    def test_visible_login_does_not_submit_configured_credentials(self):
        result, page = self.login("X", headless=False)
        self.assertFalse(result["ok"])
        self.assertEqual(page.fields, {})

    def test_both_cli_entrypoints_forward_mode_and_close_context(self):
        for provider in ("x", "instagram"):
            module = importlib.import_module(f"{provider}_browser_login")
            for headless in ("false", "true"):
                with self.subTest(provider=provider, mode=headless):
                    browser = Mock()
                    playwright = Mock()
                    playwright.return_value.__enter__ = Mock(return_value=browser)
                    playwright.return_value.__exit__ = Mock(return_value=False)
                    context = Mock()
                    with patch.object(module, "import_playwright", return_value=playwright), \
                         patch.object(module, "launch_persistent", return_value=context) as launch, \
                         patch.object(module, "run_login", return_value={"ok": True}) as run, \
                         patch.object(sys, "argv", ["login", "--user-data-dir", "fixture", "--headless", headless]), \
                         contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as exit_result:
                        module.main()
                    self.assertEqual(exit_result.exception.code, 0)
                    self.assertEqual(launch.call_args.kwargs["headless"], headless == "true")
                    self.assertEqual(run.call_args.kwargs["headless"], headless == "true")
                    context.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
