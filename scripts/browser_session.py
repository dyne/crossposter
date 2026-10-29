"""Browser defaults and ordinary login shared by the X/Instagram runners."""
import os
from pathlib import Path
import re
import time
from urllib.parse import urlparse


def launch_browser(playwright, user_data_dir, headless, prefix, channel=None):
    channel = channel or os.environ.get(f"{prefix}_BROWSER_CHANNEL", "").strip() or "auto"
    if channel not in ("auto", "chrome", "chromium"):
        raise ValueError(f"{prefix}_BROWSER_CHANNEL must be auto, chrome or chromium.")

    # Keep the actual browser user agent, locale and window size unless configured.
    options = {"headless": headless, "no_viewport": True}
    locale = os.environ.get(f"{prefix}_BROWSER_LOCALE", "").strip()
    if locale:
        if not re.fullmatch(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", locale):
            raise ValueError(f"{prefix}_BROWSER_LOCALE must be a language tag such as en-GB.")
        options["locale"] = locale
    viewport = os.environ.get(f"{prefix}_BROWSER_VIEWPORT", "").strip()
    if viewport:
        match = re.fullmatch(r"([1-9][0-9]{2,3})x([1-9][0-9]{2,3})", viewport)
        if not match:
            raise ValueError(f"{prefix}_BROWSER_VIEWPORT must be WIDTHxHEIGHT (100–9999 each).")
        options.pop("no_viewport")
        options["viewport"] = {"width": int(match[1]), "height": int(match[2])}

    directory = Path(user_data_dir).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    channels = ["chrome", "chromium"] if channel == "auto" else [channel]
    last_error = None
    for selected in channels:
        try:
            return playwright.chromium.launch_persistent_context(
                str(directory), channel=selected, **options
            )
        except Exception as error:
            last_error = error
    raise last_error


def login_session(context, timeout_ms, headless, prefix, label, login_url, is_logged_in):
    if is_logged_in(context):
        return {"ok": True, "message": f"{label} session is already saved for this profile."}

    visible_help = (
        f"Set {prefix}_BROWSER_LOGIN_HEADLESS=false and log in with a visible browser "
        "to complete any 2FA, CAPTCHA or account verification."
    )
    username = os.environ.get(f"{prefix}_BROWSER_LOGIN_USERNAME", "").strip()
    password = os.environ.get(f"{prefix}_BROWSER_LOGIN_PASSWORD", "")
    if headless and (not username or not password):
        return {"ok": False, "message": (
            f"Headless {label} login needs a saved session or both "
            f"{prefix}_BROWSER_LOGIN_USERNAME and {prefix}_BROWSER_LOGIN_PASSWORD. "
            + visible_help
        )}

    page = context.pages[0] if context.pages else context.new_page()
    deadline = time.monotonic() + max(timeout_ms, 1000) / 1000

    def remaining_ms():
        return max(1, int((deadline - time.monotonic()) * 1000))

    try:
        page.goto(login_url, wait_until="domcontentloaded", timeout=min(30_000, remaining_ms()))
        if headless:
            identifier = page.locator('input[name="username"], input[autocomplete="username"]').first
            identifier.fill(username, timeout=min(20_000, remaining_ms()))
            if prefix == "X":
                identifier.press("Enter", timeout=min(20_000, remaining_ms()))
            secret = page.locator('input[name="password"], input[type="password"]').first
            secret.fill(password, timeout=min(20_000, remaining_ms()))
            secret.press("Enter", timeout=min(20_000, remaining_ms()))
    except Exception:
        if headless:
            # Playwright errors may contain action arguments; never echo credentials.
            return {"ok": False, "message": f"Headless {label} login could not complete the sign-in form. " + visible_help}

    while time.monotonic() < deadline:
        if is_logged_in(context):
            return {"ok": True, "message": f"{label} session saved for this profile."}
        if headless and any(part in urlparse(page.url).path.lower() for part in ("/challenge", "/checkpoint", "/two_factor", "/account/access")):
            return {"ok": False, "message": f"{label} requires interactive verification. " + visible_help}
        try:
            page.wait_for_timeout(min(2000, remaining_ms()))
        except Exception:
            break

    if is_logged_in(context):
        return {"ok": True, "message": f"{label} session saved for this profile."}
    return {"ok": False, "message": f"{label} login did not complete before the timeout. " + visible_help}
