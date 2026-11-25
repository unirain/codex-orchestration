"""Linux subreaper for one project test. Run under docker exec python3 -I."""
import ctypes
import os
from pathlib import Path
import re
import signal
import sys
import time

uid = int(sys.argv[1])
run_id = sys.argv[3]
if os.getuid() != 0 or uid in (0, 61000, 61001) or not re.fullmatch(r"[a-f0-9-]{36}", run_id):
    raise SystemExit("invalid test execution identity")
record = Path("/test-control") / run_id


def start_time(pid):
    # A Linux command name may include spaces and parentheses.
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


if sys.argv[2] == "cancel":
    try:
        pid, timestamp = record.read_text().split()
        if start_time(pid) == timestamp:
            os.kill(int(pid), signal.SIGUSR1)
    except (FileNotFoundError, ProcessLookupError):
        pass
    raise SystemExit(0)

if sys.argv[2] != "run":
    raise SystemExit("unknown test operation")
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), "subreaper unavailable")

cancelled = False


def cancel(*_):
    global cancelled
    cancelled = True


signal.signal(signal.SIGUSR1, cancel)
command = sys.stdin.read()
child = os.fork()
if child == 0:
    try:
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
        os.setsid()
        signal.signal(signal.SIGUSR1, signal.SIG_DFL)
        os.chdir("/workspace")
        os.dup2(os.open("/dev/null", os.O_RDONLY), 0)
        os.closerange(3, 65536)
        env = {key: os.environ[key] for key in (
            "PATH", "LANG", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "NO_PROXY", "no_proxy", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
            "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "GIT_SSL_CAINFO",
        ) if key in os.environ}
        os.execve("/bin/sh", ["sh", "-c", command], env)
    except BaseException:
        os._exit(126)

os.umask(0o077)
temporary = record.with_suffix(".tmp")
temporary.write_text(f"{os.getpid()} {start_time(os.getpid())}")
temporary.rename(record)
result = None
children_file = Path(f"/proc/self/task/{os.getpid()}/children")
try:
    while True:
        if cancelled or result is not None:
            # Killing direct children reparents their descendants here, even if
            # a package script called setsid or started a new process group.
            for value in children_file.read_text().split():
                try:
                    os.kill(int(value), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == child:
            code = os.waitstatus_to_exitcode(status)
            result = code if code >= 0 else 128 - code
        elif not pid:
            time.sleep(0.025)
finally:
    record.unlink(missing_ok=True)

raise SystemExit(137 if cancelled else (result if result is not None else 1))
