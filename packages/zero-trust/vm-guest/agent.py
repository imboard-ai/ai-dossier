#!/usr/bin/env python3
"""In-VM side of the zero-trust worker broker (zt-broker-v1).

Runs as root inside the disposable VM and serves exactly three operations over
a virtio-serial port: exec (inside a hardened container), put and get (bounded,
workspace-relative, no symlink traversal). The host treats every reply as
untrusted; this agent holds no credentials and has no other host channel.
"""
import base64
import json
import os
import stat
import subprocess
import threading
import time

PORT = "/dev/virtio-ports/org.ai-dossier.zt.broker"
DMI_ENTRIES = "/sys/firmware/dmi/entries"
SCOPE_OEM = b"org.ai-dossier.zt.scope:"
WORKSPACE = "/var/lib/zt/workspace"
IMAGES = {"node": "zt-node:profile", "python": "zt-python:profile"}
WORKER_UID = 1000
MAX_LINE = 4 * 1024 * 1024
MAX_STREAM = 1024 * 1024
MAX_FILE = 1024 * 1024


def read_scope():
    # Only an explicit controller flag selects vm-root; anything else is container.
    # The flag is an SMBIOS type 11 OEM string set on the QEMU command line.
    try:
        subprocess.run(["modprobe", "dmi_sysfs"], check=False, capture_output=True)
        for entry in os.listdir(DMI_ENTRIES):
            if not entry.startswith("11-"):
                continue
            with open(os.path.join(DMI_ENTRIES, entry, "raw"), "rb") as handle:
                raw = handle.read(4096)
            # Formatted area (length in byte 1), then NUL-terminated strings.
            if SCOPE_OEM + b"vm-root" in raw[raw[1]:].split(b"\0"):
                return "vm-root"
    except (OSError, IndexError):
        pass
    return "container"


def container_limits():
    with open("/proc/meminfo") as handle:
        total_kib = int(handle.readline().split()[1])
    memory_mib = max(256, (total_kib // 1024) * 3 // 4)
    return memory_mib, os.cpu_count() or 1


def valid_path(value, allow_empty=False):
    if not isinstance(value, str):
        return None
    if value == "" and allow_empty:
        return []
    parts = value.split("/")
    if (
        not value
        or len(value.encode()) > 512
        or "\0" in value
        or "\\" in value
        or len(parts) > 32
        or any(p in ("", ".", "..") for p in parts)
    ):
        return None
    return parts


def open_parent(parts, create):
    """Walk from the workspace root without following any symlink."""
    fd = os.open(WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o755, dir_fd=fd)
                os.chown(part, WORKER_UID, WORKER_UID, dir_fd=fd, follow_symlinks=False)
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def op_put(request):
    parts = valid_path(request.get("path"))
    data = request.get("data")
    if parts is None or not isinstance(data, str):
        return {"ok": False, "error": "invalid_request"}
    raw = base64.b64decode(data, validate=True)
    if len(raw) > MAX_FILE:
        return {"ok": False, "error": "too_large"}
    parent = open_parent(parts, create=True)
    try:
        fd = os.open(
            parts[-1],
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
            0o644,
            dir_fd=parent,
        )
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return {"ok": False, "error": "not_regular"}
            os.write(fd, raw)
            os.fchmod(fd, 0o755 if request.get("executable") is True else 0o644)
            os.fchown(fd, WORKER_UID, WORKER_UID)
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    return {"ok": True}


def op_get(request):
    parts = valid_path(request.get("path"))
    if parts is None:
        return {"ok": False, "error": "invalid_request"}
    parent = open_parent(parts, create=False)
    try:
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                return {"ok": False, "error": "not_regular"}
            if info.st_size > MAX_FILE:
                return {"ok": False, "error": "too_large"}
            raw = os.read(fd, MAX_FILE + 1)
            if len(raw) > MAX_FILE:
                return {"ok": False, "error": "too_large"}
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    return {"ok": True, "data": base64.b64encode(raw).decode()}


def drain(stream, sink, state):
    while True:
        chunk = stream.read(65536)
        if not chunk:
            return
        room = MAX_STREAM - len(sink)
        if len(chunk) > room:
            state["truncated"] = True
        sink.extend(chunk[: max(room, 0)])


def op_exec(request, scope, exec_id):
    argv = request.get("argv")
    cwd = valid_path(request.get("cwd", ""), allow_empty=True)
    profile = request.get("profile")
    timeout_ms = request.get("timeoutMs")
    if (
        not isinstance(argv, list)
        or not argv
        or not all(isinstance(a, str) for a in argv)
        or cwd is None
        or profile not in IMAGES
        or not isinstance(timeout_ms, int)
    ):
        return {"ok": False, "error": "invalid_request"}
    name = "zt-exec-%d" % exec_id
    if scope == "vm-root":
        command = list(argv)
        workdir = os.path.join(WORKSPACE, *cwd)
        env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}
    else:
        memory_mib, cpus = container_limits()
        command = [
            "docker", "run", "--rm", "--name", name,
            "--network", "none",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges=true",
            "--read-only",
            "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=1g",
            "--pids-limit", "1024",
            "--memory", "%dm" % memory_mib,
            "--memory-swap", "%dm" % memory_mib,
            "--cpus", str(cpus),
            "--user", "%d:%d" % (WORKER_UID, WORKER_UID),
            "--env", "HOME=/tmp",
            "--mount", "type=bind,src=%s,dst=/workspace" % WORKSPACE,
            "--workdir", "/".join(["/workspace"] + cwd),
            IMAGES[profile],
        ] + argv
        workdir = "/"
        env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
    out, err, state = bytearray(), bytearray(), {"truncated": False}
    proc = subprocess.Popen(
        command, cwd=workdir, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    )
    readers = [
        threading.Thread(target=drain, args=(proc.stdout, out, state), daemon=True),
        threading.Thread(target=drain, args=(proc.stderr, err, state), daemon=True),
    ]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        proc.wait(timeout=timeout_ms / 1000.0)
    except subprocess.TimeoutExpired:
        timed_out = True
        if scope != "vm-root":
            subprocess.run(["docker", "kill", name], check=False, capture_output=True)
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            pass
        proc.wait()
    for reader in readers:
        reader.join(timeout=5)
    return {
        "ok": True,
        "exitCode": None if timed_out or proc.returncode < 0 else proc.returncode,
        "timedOut": timed_out,
        "truncated": state["truncated"],
        "stdout": base64.b64encode(bytes(out)).decode(),
        "stderr": base64.b64encode(bytes(err)).decode(),
    }


def main():
    scope = read_scope()
    while not os.path.exists(PORT):
        time.sleep(0.5)
    port = os.open(PORT, os.O_RDWR)
    reader = os.fdopen(port, "rb", buffering=0, closefd=False)
    pending = b""
    exec_id = 0

    def reply(frame):
        os.write(port, (json.dumps(dict(frame, v=1)) + "\n").encode())

    while True:
        chunk = reader.read(65536)
        if not chunk:
            time.sleep(0.2)  # host side not connected yet
            continue
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            rid = None
            try:
                request = json.loads(line)
                rid = request.get("id")
                op = request.get("op")
                if op == "hello":
                    reply({"id": rid, "hello": "zt-broker-v1", "scope": scope})
                    continue
                if op == "exec":
                    exec_id += 1
                    result = op_exec(request, scope, exec_id)
                elif op == "put":
                    result = op_put(request)
                elif op == "get":
                    result = op_get(request)
                else:
                    result = {"ok": False, "error": "invalid_op"}
            except FileNotFoundError:
                result = {"ok": False, "error": "not_found"}
            except Exception:  # noqa: BLE001 - never leak guest internals to the host
                result = {"ok": False, "error": "agent_error"}
            reply(dict(result, id=rid))
        if len(pending) > MAX_LINE:
            pending = b""


if __name__ == "__main__":
    main()
