"""Drive the actual CLI through a local PTY using only Python's stdlib.

This is automated terminal-input testing, not evidence of a human's consent.
The caller supplies a known local Node CLI command and a temporary workspace.
"""
import errno
import json
import os
import pty
import select
import signal
import subprocess
import sys
import time

request = json.load(sys.stdin)
master, slave = pty.openpty()
process = subprocess.Popen(
    request["command"], cwd=request["cwd"],
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
)
os.close(slave)
output = bytearray()
answered = False
timed_out = False
before_answer_result = None
deadline = time.monotonic() + 8
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                output.extend(chunk)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
        if not answered and b"Approve this exact plan?" in output:
            answered = True
            if request.get("beforeAnswerCommand"):
                mutation = subprocess.run(
                    request["beforeAnswerCommand"], cwd=request["cwd"],
                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5,
                )
                before_answer_result = {
                    "returncode": mutation.returncode,
                    "stdout": mutation.stdout,
                    "stderr": mutation.stderr,
                }
            if request.get("action") == "interrupt":
                process.send_signal(signal.SIGINT)
            else:
                os.write(master, (request["answer"] + "\n").encode())
        if process.poll() is not None and not ready:
            break
    if process.poll() is None:
        timed_out = True
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=2)
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=2)
    os.close(master)
print(json.dumps({
    "returncode": process.returncode,
    "transcript": output.decode("utf-8", errors="replace"),
    "answered": answered,
    "timedOut": timed_out,
    "beforeAnswerResult": before_answer_result,
}))
