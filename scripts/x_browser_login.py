#!/usr/bin/env python3
"""Visible or headless X login using an isolated persistent profile."""
import argparse

from browser_session import login_session
from x_browser_lib import (
    LOGIN_URL, emit, friendly_error, import_playwright, is_logged_in, launch_persistent,
)


def parse_args():
    parser = argparse.ArgumentParser(description="Log in to X using an isolated browser.")
    parser.add_argument("--user-data-dir", required=True)
    parser.add_argument("--timeout-ms", type=int, default=180_000)
    parser.add_argument("--headless", choices=["true", "false"], default="false")
    return parser.parse_args()


def run_login(context, timeout_ms, headless=False):
    return login_session(context, timeout_ms, headless, "X", "X", LOGIN_URL, is_logged_in)


def main():
    args = parse_args()
    sync_playwright = import_playwright()
    result = {"ok": False, "message": "X login did not complete."}
    with sync_playwright() as playwright:
        context = None
        try:
            headless = args.headless == "true"
            context = launch_persistent(playwright, args.user_data_dir, headless=headless)
            result = run_login(context, args.timeout_ms, headless=headless)
        except Exception as exc:
            result = {"ok": False, "message": friendly_error(exc)}
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass
    emit(result, 0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
