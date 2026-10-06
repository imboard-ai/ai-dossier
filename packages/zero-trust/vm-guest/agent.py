#!/usr/bin/env python3
"""In-VM side of the zero-trust worker broker (zt-broker-v1).

Runs as root inside the disposable VM and serves four operations over a
virtio-serial port: exec (inside a hardened container), put and get (bounded,
workspace-relative, no symlink traversal) and shutdown. The host treats every
reply as untrusted; this agent holds no credentials and has no other host channel.

In the provisioning phase (#1010) it also runs the package relay: the host dials
connections in through the VM's one forward, and the relay pairs each with a
worker connection from the internal provisioning network. The guest never opens
a connection toward the host; the forward and its absence are host policy.
"""
import base64
import json
import os
import shutil
import socket
import stat
import subprocess
import threading
import time

PORT = "/dev/virtio-ports/org.ai-dossier.zt.broker"
DMI_ENTRIES = "/sys/firmware/dmi/entries"
SCOPE_OEM = b"org.ai-dossier.zt.scope:"
PHASE_OEM = b"org.ai-dossier.zt.phase:"
WORKSPACE = "/var/lib/zt/workspace"
# Worker-writable directory outside the workspace (environments), kept across commands.
ENV_DIR = "/var/lib/zt/env"
ENV_MOUNT = "/opt/ztfc"
# Fresh per exec, outside the workspace: the supervisor reads the report from here.
REPORT_DIR = "/var/lib/zt/report"
REPORT_MOUNT = "/ztfc/report"
REPORT_FILE = "report.xml"
MAX_REPORT = 256 * 1024
# Provisioning relay: the host forward lands on RELAY_PORT (from slirp's host
# address only); workers reach RELAY_WORKER on an internal Docker network that has
# no other route.
RELAY_PORT = 7480
SLIRP_HOST = "10.0.2.2"
PROV_NETWORK = "zt-prov"
PROV_SUBNET = "172.30.255.0/24"
PROV_GATEWAY = "172.30.255.1"
RELAY_WORKER_PORT = 7481
RELAY_MAX_WORKERS = 64
RELAY_WAIT_S = 60
IMAGES = {"node": "zt-node:profile", "python": "zt-python:profile"}
WORKER_UID = 1000
MAX_LINE = 4 * 1024 * 1024
MAX_STREAM = 1024 * 1024
MAX_FILE = 1024 * 1024


def read_flags():
    # Only explicit controller flags select vm-root or provisioning; anything else
    # is container / verification. The flags are SMBIOS type 11 OEM strings set on
    # the QEMU command line.
    strings = []
    try:
        subprocess.run(["modprobe", "dmi_sysfs"], check=False, capture_output=True)
        for entry in os.listdir(DMI_ENTRIES):
            if not entry.startswith("11-"):
                continue
            with open(os.path.join(DMI_ENTRIES, entry, "raw"), "rb") as handle:
                raw = handle.read(4096)
            # Formatted area (length in byte 1), then NUL-terminated strings.
            strings.extend(raw[raw[1]:].split(b"\0"))
    except (OSError, IndexError):
        pass
    scope = "vm-root" if SCOPE_OEM + b"vm-root" in strings else "container"
    phase = "provisioning" if PHASE_OEM + b"provisioning" in strings else "verification"
    return scope, phase


class Relay:
    """Pairs host-dialed connections (through the one forward) with worker ones."""

    def __init__(self):
        self.pool = []
        self.cond = threading.Condition()
        self.workers = threading.BoundedSemaphore(RELAY_MAX_WORKERS)

    def start(self):
        subprocess.run(
            ["docker", "network", "create", "--internal", "--subnet", PROV_SUBNET,
             "--gateway", PROV_GATEWAY, PROV_NETWORK],
            check=False, capture_output=True,
        )
        host = self.listen("0.0.0.0", RELAY_PORT)
        worker = self.listen(PROV_GATEWAY, RELAY_WORKER_PORT)
        threading.Thread(target=self.accept_host, args=(host,), daemon=True).start()
        threading.Thread(target=self.accept_worker, args=(worker,), daemon=True).start()

    @staticmethod
    def listen(address, port):
        for _ in range(120):  # the bridge address appears once Docker set it up
            try:
                server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                server.bind((address, port))
                server.listen(128)
                return server
            except OSError:
                server.close()
                time.sleep(0.5)
        raise OSError("relay listen failed")

    def accept_host(self, server):
        while True:
            conn, peer = server.accept()
            # Only slirp delivers the host forward; anything else is not the host.
            if peer[0] != SLIRP_HOST:
                conn.close()
                continue
            with self.cond:
                self.pool.append(conn)
                self.cond.notify()

    def accept_worker(self, server):
        while True:
            conn, _ = server.accept()
            if not self.workers.acquire(blocking=False):
                conn.close()
                continue
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def take(self):
        deadline = time.monotonic() + RELAY_WAIT_S
        with self.cond:
            while True:
                while self.pool:
                    conn = self.pool.pop(0)
                    try:
                        # Still open? EOF means slirp or the host dropped it.
                        if conn.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b"":
                            conn.close()
                            continue
                    except BlockingIOError:
                        return conn
                    except OSError:
                        conn.close()
                        continue
                    conn.close()  # the host never speaks first
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.cond.wait(remaining)

    def serve(self, worker):
        try:
            host = self.take()
            if host is None:
                worker.close()
                return
            pipes = [
                threading.Thread(target=pipe, args=(worker, host), daemon=True),
                threading.Thread(target=pipe, args=(host, worker), daemon=True),
            ]
            for thread in pipes:
                thread.start()
            for thread in pipes:
                thread.join()
            host.close()
            worker.close()
        finally:
            self.workers.release()


def pipe(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    try:
        sink.shutdown(socket.SHUT_WR)
    except OSError:
        pass


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
        # O_NONBLOCK: a FIFO planted by worker code must not wedge the agent.
        # Truncate only after the target is known to be a regular file.
        fd = os.open(
            parts[-1],
            os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
            0o644,
            dir_fd=parent,
        )
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return {"ok": False, "error": "not_regular"}
            os.ftruncate(fd, 0)
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


def valid_env(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 32:
        return None
    for key, item in value.items():
        if (
            not isinstance(key, str)
            or not key
            or len(key) > 64
            or not (key[0].isalpha() or key[0] == "_")
            or not all(c.isalnum() or c == "_" for c in key)
            or not key.isascii()
            or key.startswith("LD_")
            or not isinstance(item, str)
            or any(c in item for c in "\0\n\r")
            or len(item.encode()) > 4096
        ):
            return None
    return value


def fresh_report_dir():
    shutil.rmtree(REPORT_DIR, ignore_errors=True)
    os.makedirs(REPORT_DIR, mode=0o700)
    os.chown(REPORT_DIR, WORKER_UID, WORKER_UID)


def read_report():
    """The report file, read without following links; None when absent or unusable."""
    try:
        parent = os.open(REPORT_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        fd = os.open(REPORT_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except OSError:
        os.close(parent)
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REPORT:
            return None
        raw = os.read(fd, MAX_REPORT + 1)
        return None if len(raw) > MAX_REPORT else raw
    finally:
        os.close(fd)
        os.close(parent)


def op_exec(request, scope, phase, exec_id):
    argv = request.get("argv")
    cwd = valid_path(request.get("cwd", ""), allow_empty=True)
    profile = request.get("profile")
    timeout_ms = request.get("timeoutMs")
    network = request.get("network", "none")
    extra_env = valid_env(request.get("env"))
    want_report = request.get("report") is True
    if (
        not isinstance(argv, list)
        or not argv
        or not all(isinstance(a, str) for a in argv)
        or cwd is None
        or profile not in IMAGES
        or not isinstance(timeout_ms, int)
        or network not in ("none", "package_proxy")
        or extra_env is None
    ):
        return {"ok": False, "error": "invalid_request"}
    # The host refuses this too; the guest does not rely on it.
    if network == "package_proxy" and (phase != "provisioning" or scope != "container"):
        return {"ok": False, "error": "network_not_allowed"}
    name = "zt-exec-%d" % exec_id
    if want_report:
        fresh_report_dir()
    if scope == "vm-root":
        command = list(argv)
        workdir = os.path.join(WORKSPACE, *cwd)
        env = dict(extra_env)
        env.update({"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"})
    else:
        memory_mib, cpus = container_limits()
        env_args = []
        for key in sorted(extra_env):
            env_args += ["--env", "%s=%s" % (key, extra_env[key])]
        report_args = []
        if want_report:
            report_args = ["--mount", "type=bind,src=%s,dst=%s" % (REPORT_DIR, REPORT_MOUNT)]
        command = [
            "docker", "run", "--rm", "--name", name,
            "--network", PROV_NETWORK if network == "package_proxy" else "none",
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
        ] + env_args + [
            "--mount", "type=bind,src=%s,dst=/workspace" % WORKSPACE,
            "--mount", "type=bind,src=%s,dst=%s" % (ENV_DIR, ENV_MOUNT),
        ] + report_args + [
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
    result = {}
    if want_report:
        report = read_report() if scope != "vm-root" else None
        result["report"] = None if report is None else base64.b64encode(report).decode()
    return dict(result, **{
        "ok": True,
        "exitCode": None if timed_out or proc.returncode < 0 else proc.returncode,
        "timedOut": timed_out,
        "truncated": state["truncated"],
        "stdout": base64.b64encode(bytes(out)).decode(),
        "stderr": base64.b64encode(bytes(err)).decode(),
    })


def prepare_env_dir():
    os.makedirs(ENV_DIR, mode=0o700, exist_ok=True)
    os.chown(ENV_DIR, WORKER_UID, WORKER_UID)


def main():
    scope, phase = read_flags()
    prepare_env_dir()
    if phase == "provisioning" and scope == "container":
        Relay().start()
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
                    reply({"id": rid, "hello": "zt-broker-v1", "scope": scope, "phase": phase})
                    continue
                if op == "shutdown":
                    reply({"id": rid, "ok": True})
                    os.sync()
                    subprocess.run(["systemctl", "poweroff"], check=False, capture_output=True)
                    continue
                if op == "exec":
                    exec_id += 1
                    result = op_exec(request, scope, phase, exec_id)
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
