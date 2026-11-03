"""Optional source-checkout fixture for the user's later manual MCP debugging.

Never starts Codex or approves an action. Providers are intercepted by the
existing regression guard. Run this yourself in a terminal, after building.
"""
import argparse
import base64
import datetime
import getpass
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    if not (repository / '.next/BUILD_ID').is_file():
        parser.error('Run npm run build in the source checkout first.')
    if not sys.stdin.isatty():
        parser.error('Run in a local terminal so the owner password can be entered without echo.')
    password = getpass.getpass('Choose a distinct non-placeholder fixture owner password (hidden): ')
    confirmation = getpass.getpass('Confirm fixture password (hidden): ')
    if not password or password != confirmation or len(password) > 1024 or any(character in password for character in '\0\r\n'):
        parser.error('Passwords must match and fit the local approval credential rules.')
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix='crossposter-manual-fixture-'))
    app, data, media, logs = [root / name for name in ['app', 'data', 'media', 'logs']]
    for directory in [app, data, media, logs]:
        directory.mkdir(mode=0o700)
    for entry in ['.next', 'node_modules', 'public']:
        (app / entry).symlink_to(repository / entry, target_is_directory=True)
    shutil.copyfile(repository / 'package.json', app / 'package.json')
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    origin = 'http://127.0.0.1:' + str(port)
    environment = {'PATH': os.environ.get('PATH', ''), 'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1'}
    with (logs / 'setup.log').open('w') as output:
        setup = subprocess.run(['node', str(repository / 'scripts/setup-control.mjs'), '--data-root', str(data), '--origin', origin], env=environment, stdout=output, stderr=subprocess.STDOUT)
    if setup.returncode:
        print('Fixture setup failed; private logs retained at ' + str(logs), file=sys.stderr)
        return setup.returncode
    (data / 'poster.config.local.json').write_text(json.dumps({'values': {'DEVTO_API_KEY': 'runtime-base-canary'}, 'profiles': {'devto': [{'id': 'uncertain', 'label': 'Synthetic uncertainty target', 'values': {'DEVTO_API_KEY': 'runtime-profile-canary'}}]}}))
    (data / 'fixture-provider-release').write_text('Allow synthetic success immediately; no remote request is made.\n')
    (media / 'fixture.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cYhQAAAAASUVORK5CYII='))
    command = ['node', str(repository / 'scripts/codex-crossposter.mjs'), '--console', '--data-dir', str(data), '--endpoint', origin, '--media-root', str(media)]
    (root / 'fixture-info.json').write_text(json.dumps({'origin': origin, 'dataRoot': str(data), 'mediaRoot': str(media), 'targetIds': ['devto:base', 'devto:uncertain'], 'manualClientCommand': command, 'syntheticProvidersOnly': True}, indent=2) + '\n')
    backend = None
    def record(event, **values):
        with (logs / 'lifecycle.jsonl').open('a') as output:
            output.write(json.dumps({'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **values}) + '\n')
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    record('start', origin=origin)
    try:
        with (logs / 'backend.log').open('w') as output:
            backend = subprocess.Popen(['node', '--import', str(repository / 'tests/control-provider-guard.mjs'), str(repository / 'node_modules/next/dist/bin/next'), 'start', str(app), '--hostname', '127.0.0.1', '--port', str(port)], cwd=app, env={**environment, 'CROSSPOSTER_APP_ROOT': str(app), 'CROSSPOSTER_DATA_DIR': str(data), 'CROSSPOSTER_TIMEZONE': 'Europe/Berlin', 'POSTER_DISABLE_SCHEDULER': 'false', 'POSTER_ADMIN_PASSWORD': password}, stdout=output, stderr=subprocess.STDOUT)
            del password, confirmation
            for _ in range(100):
                if backend.poll() is not None:
                    raise RuntimeError('Fixture backend exited during startup')
                try:
                    with urllib.request.urlopen(origin + '/api/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError('Fixture backend did not become ready')
            record('ready', backendPid=backend.pid)
            print('Synthetic-provider fixture only. No Codex process has been started.\nPrivate backend logs/data: ' + str(root))
            print('In a separate terminal, launch the manual console:\n' + shlex.join(command))
            print('Targets: devto:base (synthetic success), devto:uncertain (synthetic accepted-response uncertainty).')
            print('Use media/fixture.png under the printed fixture root. Enter the owner password only in the local approval page.')
            print('Keep this terminal running; Ctrl-C stops and awaits only this backend. Logs and disposable data are retained.', flush=True)
            return backend.wait()
    except KeyboardInterrupt:
        return 130
    except SystemExit as error:
        return error.code if isinstance(error.code, int) else 1
    except Exception:
        record('startup_failure')
        print('Fixture failed. Inspect private logs at ' + str(logs), file=sys.stderr)
        return 1
    finally:
        if backend and backend.poll() is None:
            backend.terminate()
            try:
                backend.wait(timeout=8)
            except subprocess.TimeoutExpired:
                backend.kill()
                backend.wait()
        record('end', backendExit=backend.returncode if backend else None)


if __name__ == '__main__':
    sys.exit(main())
