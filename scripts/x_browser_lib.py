#!/usr/bin/env python3
"""Shared helpers for the X (Twitter) Playwright login and publish scripts.

Both scripts drive a dedicated, isolated Chromium (or the installed Chrome) with
a per-profile persistent user-data directory, so each X account has its own
session and nothing touches the user's personal Chrome profile.
"""
import json
from browser_session import launch_browser

X_ORIGIN = "https://x.com"
LOGIN_URL = f"{X_ORIGIN}/i/flow/login"
HOME_URL = f"{X_ORIGIN}/home"
COMPOSE_URL = f"{X_ORIGIN}/compose/post"
# X sets auth_token once a session is authenticated.
LOGGED_IN_COOKIE = "auth_token"



def emit(payload, code=0):
    print(json.dumps(payload, separators=(",", ":")))
    raise SystemExit(code)


def import_playwright():
    try:
        from playwright.sync_api import sync_playwright

        return sync_playwright
    except ModuleNotFoundError:
        emit(
            {
                "ok": False,
                "message": (
                    "Playwright is not installed. Run "
                    "`crossposter install-instagram-browser-deps` or "
                    "`./scripts/install-instagram-browser-deps.sh` in Terminal "
                    "(the X browser method reuses the same engine)."
                ),
            },
            2,
        )


def launch_persistent(playwright, user_data_dir, headless, channel=None):
    """Use the configured channel and browser-native identity/window defaults."""
    return launch_browser(playwright, user_data_dir, headless, "X", channel)


def is_logged_in(context):
    """True when an X session cookie is present for this profile."""
    try:
        cookies = context.cookies(X_ORIGIN)
    except Exception:
        cookies = []

    return any(
        cookie.get("name") == LOGGED_IN_COOKIE and cookie.get("value")
        for cookie in cookies
    )


def first_page(context):
    return context.pages[0] if context.pages else context.new_page()


def friendly_error(exc):
    name = exc.__class__.__name__
    text = str(exc).strip()
    lowered = f"{name} {text}".lower()

    if "executable doesn't exist" in lowered or "playwright install" in lowered:
        return (
            "X browser engine is missing. Run "
            "`crossposter install-instagram-browser-deps` or "
            "`./scripts/install-instagram-browser-deps.sh` in Terminal, then try again."
        )

    if "timeout" in lowered or "timed out" in lowered:
        return (
            "X browser step timed out. X may have changed its layout or shown a checkpoint. "
            "Set X browser headless to false to watch it, or re-run Log in to X and finish "
            "any verification."
        )

    if len(text) > 240:
        text = f"{text[:237]}..."

    return f"{name}: {text}" if text else name
