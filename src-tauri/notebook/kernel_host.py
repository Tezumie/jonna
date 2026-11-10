"""Runs a notebook's code for the IDE (D188).

One JSON object per line on stdin (requests) and stdout (events). Two ways to run code:

- "jupyter": a real Jupyter kernel through jupyter_client (any kernelspec: ipykernel, R, Julia...),
  when jupyter_client is installed for this Python (and ipykernel for Python kernels).
- "python": no packages needed. Cells run in one namespace in this process, with the last
  expression's value shown, display(), rich reprs (_repr_html_, _repr_png_...), matplotlib
  figures as images, input(), !shell commands and %pip / %cd / %time.

Requests: {"id", "op": "execute" | "input" | "interrupt" | "restart" | "shutdown" | "complete" |
"inspect" | "variables" | "comm_msg" | "comm_close", ...}. Events carry the request's id:
"stream", "display", "update_display", "clear", "result", "error", "input_request", then "done"
{status, count}; "complete", "inspect", "variables" answer those. {"type": "status", "state"} has
no id.

Widgets (D189, Jupyter mode): the kernel's comm messages come as {"type": "comm", "kind":
"comm_open" | "comm_msg" | "comm_close", "content", "metadata", "buffers" (base64), "parent"};
"comm_msg" / "comm_close" requests send the frontend's (a "done" follows once the kernel is idle
after it). Outputs carry "parent" (the kernel's message id) so an Output widget that captures
them can be found; outputs of no request of ours (a widget callback's) come with id null.

`python kernel_host.py --list` prints the kernelspecs and exits.
"""

import ast
import base64
import builtins
import io
import json
import os
import queue
import subprocess
import sys
import threading
import time
import traceback

PROTOCOL = 1
OUT = sys.stdout
# The requests' pipe: cells get an empty stdin of their own (input() asks the IDE).
IN = sys.stdin
OUT_LOCK = threading.Lock()


def _finite(value):
    """NaN and infinities aren't JSON: they go as strings (the IDE's parser would drop the line)."""
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return repr(value)
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def emit(event):
    try:
        line = json.dumps(event, default=str, allow_nan=False)
    except ValueError:
        line = json.dumps(_finite(event), default=str)
    with OUT_LOCK:
        OUT.write(line + "\n")
        OUT.flush()


def read_requests():
    """Lines from stdin as dicts (bad lines are skipped). Ends when the IDE closes the pipe."""
    for line in IN:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if isinstance(msg, dict):
            yield msg


def jupyter_available():
    try:
        import jupyter_client  # noqa: F401

        return True
    except Exception:
        return False


def list_specs():
    out = {
        "protocol": PROTOCOL,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "jupyter": jupyter_available(),
        "ipykernel": False,
        "specs": [],
    }
    try:
        import ipykernel  # noqa: F401

        out["ipykernel"] = True
    except Exception:
        pass
    if out["jupyter"]:
        try:
            from jupyter_client.kernelspec import KernelSpecManager

            for name, info in KernelSpecManager().get_all_specs().items():
                spec = info.get("spec", {})
                out["specs"].append(
                    {
                        "name": name,
                        "display": spec.get("display_name", name),
                        "language": spec.get("language", ""),
                    }
                )
        except Exception as e:  # a broken kernelspec folder
            out["error"] = str(e)
    return out


# ---- Jupyter mode ----------------------------------------------------------------------------


VARIABLES_CODE = r"""
def __ide_variables():
    import json as _j, types as _t
    out = []
    for _k, _v in list(globals().items()):
        if _k.startswith('_') or isinstance(_v, (_t.ModuleType, _t.FunctionType, type)):
            continue
        if _k in ('In', 'Out', 'exit', 'quit', 'get_ipython', 'display'):
            continue
        try:
            _r = repr(_v)
        except Exception:
            _r = '<unprintable>'
        _s = getattr(_v, 'shape', None)
        try:
            _n = len(_v) if _s is None and hasattr(_v, '__len__') else None
        except Exception:
            _n = None
        out.append({'name': _k, 'type': type(_v).__name__, 'value': _r[:300],
                    'size': str(tuple(_s)) if _s is not None else (str(_n) if _n is not None else '')})
    return _j.dumps(out[:500])
"""


class JupyterHost:
    def __init__(self, kernel_name):
        from jupyter_client.manager import KernelManager

        self.km = KernelManager(kernel_name=kernel_name or "python3")
        self.kernel_name = self.km.kernel_name
        self.shell_lock = threading.Lock()
        self.stdin_lock = threading.Lock()
        self.iopub_lock = threading.Lock()
        self.dead = False
        self.pending = {}  # msg_id -> {"id", "kind", "reply", "idle"}
        self.comm_pending = {}  # msg_id of a comm message we sent -> request id
        self.pending_lock = threading.Lock()
        self.stopping = False
        self.vars_ready = False
        self.start()

    def start(self):
        emit({"type": "status", "state": "starting"})
        # The kernel's own stdout/stderr (os.system, C extensions) go to the host's stderr (the
        # IDE's log), never into the protocol pipe; it reads nothing from ours.
        import subprocess as sp

        self.km.start_kernel(stdin=sp.DEVNULL, stdout=sys.stderr, stderr=sys.stderr)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        spec = self.km.kernel_spec
        self.language = (spec.language if spec else "") or "python"
        self.vars_ready = False
        for target in (self.iopub_loop, self.shell_loop, self.stdin_loop, self.watch_loop):
            threading.Thread(target=target, daemon=True).start()
        emit({"type": "status", "state": "idle"})

    def hello(self):
        spec = self.km.kernel_spec
        return {
            "mode": "jupyter",
            "kernel": self.kernel_name,
            "display": spec.display_name if spec else self.kernel_name,
            "language": self.language,
            "python": sys.version.split()[0],
            "executable": sys.executable,
        }

    def track(self, msg_id, req_id, kind):
        with self.pending_lock:
            self.pending[msg_id] = {"id": req_id, "kind": kind, "reply": None, "idle": False}

    def finish_if_done(self, msg_id):
        with self.pending_lock:
            p = self.pending.get(msg_id)
            if not p or p["kind"] != "execute" or p["reply"] is None or not p["idle"]:
                return
            del self.pending[msg_id]
        reply = p["reply"]
        status = reply.get("status", "ok")
        emit({"id": p["id"], "type": "done", "status": status, "count": reply.get("execution_count")})

    # Each zmq socket is used by one thread at a time (locks around the shared ones).
    def shell_loop(self):
        kc = self.kc
        while not self.stopping and kc is self.kc:
            try:
                with self.shell_lock:
                    msg = kc.get_shell_msg(timeout=0.05)
            except queue.Empty:
                time.sleep(0.02)
                continue
            except Exception:
                time.sleep(0.1)
                continue
            parent = msg.get("parent_header", {}).get("msg_id")
            with self.pending_lock:
                p = self.pending.get(parent)
            if not p:
                continue
            content = msg.get("content", {})
            kind = p["kind"]
            if kind == "execute":
                if content.get("status") == "error" and content.get("ename"):
                    pass  # the error itself came on iopub
                if kind == "execute" and p.get("vars"):
                    expr = content.get("user_expressions", {}).get("v", {})
                    text = expr.get("data", {}).get("text/plain", "[]")
                    try:
                        vars_ = json.loads(ast.literal_eval(text))
                    except Exception:
                        vars_ = []
                    emit({"id": p["id"], "type": "variables", "variables": vars_})
                    with self.pending_lock:
                        self.pending.pop(parent, None)
                    continue
                with self.pending_lock:
                    p["reply"] = content
                self.finish_if_done(parent)
            elif kind == "complete":
                emit(
                    {
                        "id": p["id"],
                        "type": "complete",
                        "matches": content.get("matches", [])[:200],
                        "start": content.get("cursor_start"),
                        "end": content.get("cursor_end"),
                    }
                )
                with self.pending_lock:
                    self.pending.pop(parent, None)
            elif kind == "inspect":
                data = content.get("data", {}) if content.get("found") else {}
                emit({"id": p["id"], "type": "inspect", "text": data.get("text/plain", "")})
                with self.pending_lock:
                    self.pending.pop(parent, None)

    def iopub_loop(self):
        kc = self.kc
        while not self.stopping and kc is self.kc:
            try:
                with self.iopub_lock:
                    msg = kc.get_iopub_msg(timeout=0.05)
            except queue.Empty:
                time.sleep(0.02)
                continue
            except Exception:
                time.sleep(0.1)
                continue
            mtype = msg.get("msg_type") or msg.get("header", {}).get("msg_type")
            content = msg.get("content", {})
            parent = msg.get("parent_header", {}).get("msg_id")
            if mtype == "status":
                state = content.get("execution_state")
                if state in ("busy", "idle"):
                    emit({"type": "status", "state": state})
                if state == "idle" and parent:
                    with self.pending_lock:
                        p = self.pending.get(parent)
                        if p:
                            p["idle"] = True
                        comm_rid = self.comm_pending.pop(parent, None)
                    if comm_rid is not None:
                        emit({"id": comm_rid, "type": "done", "status": "ok", "count": None})
                    self.finish_if_done(parent)
                continue
            if mtype in ("comm_open", "comm_msg", "comm_close"):
                emit(
                    {
                        "type": "comm",
                        "kind": mtype,
                        "content": content,
                        "metadata": msg.get("metadata", {}),
                        "buffers": [base64.b64encode(bytes(b)).decode("ascii") for b in msg.get("buffers", []) or []],
                        "parent": parent,
                    }
                )
                continue
            with self.pending_lock:
                p = self.pending.get(parent)
            if p and (p["kind"] != "execute" or p.get("vars")):
                continue
            # Outputs of no request of ours (a widget's callback) go out with id None: an Output
            # widget capturing them (its msg_id is `parent`) shows them.
            rid = p["id"] if p else None
            if mtype == "stream":
                emit({"id": rid, "type": "stream", "name": content.get("name", "stdout"), "text": content.get("text", ""), "parent": parent})
            elif mtype == "display_data":
                emit({"id": rid, "type": "display", "data": content.get("data", {}), "metadata": content.get("metadata", {}), "transient": content.get("transient", {}), "parent": parent})
            elif mtype == "update_display_data":
                emit({"id": rid, "type": "update_display", "data": content.get("data", {}), "metadata": content.get("metadata", {}), "transient": content.get("transient", {}), "parent": parent})
            elif mtype == "execute_result":
                emit({"id": rid, "type": "result", "data": content.get("data", {}), "metadata": content.get("metadata", {}), "count": content.get("execution_count"), "parent": parent})
            elif mtype == "error":
                emit({"id": rid, "type": "error", "ename": content.get("ename", ""), "evalue": content.get("evalue", ""), "traceback": content.get("traceback", []), "parent": parent})
            elif mtype == "clear_output":
                emit({"id": rid, "type": "clear", "wait": bool(content.get("wait")), "parent": parent})

    def stdin_loop(self):
        kc = self.kc
        while not self.stopping and kc is self.kc:
            try:
                with self.stdin_lock:
                    msg = kc.get_stdin_msg(timeout=0.05)
            except queue.Empty:
                time.sleep(0.05)
                continue
            except Exception:
                time.sleep(0.1)
                continue
            parent = msg.get("parent_header", {}).get("msg_id")
            with self.pending_lock:
                p = self.pending.get(parent)
            content = msg.get("content", {})
            emit({"id": p["id"] if p else None, "type": "input_request", "prompt": content.get("prompt", ""), "password": bool(content.get("password"))})

    def watch_loop(self):
        km = self.km
        while not self.stopping and km is self.km:
            time.sleep(1.0)
            try:
                alive = km.is_alive()
            except Exception:
                alive = True
            if not alive and not self.stopping and not self.dead:
                # Reported once; a restart brings it back (watching goes on).
                self.dead = True
                emit({"type": "status", "state": "dead"})
                self.fail_pending("The kernel died.")
            elif alive:
                self.dead = False

    def fail_pending(self, why):
        with self.pending_lock:
            items = list(self.pending.items())
            self.pending.clear()
        for _, p in items:
            if p["kind"] == "execute":
                emit({"id": p["id"], "type": "error", "ename": "KernelDied", "evalue": why, "traceback": []})
                emit({"id": p["id"], "type": "done", "status": "error", "count": None})

    def handle(self, req):
        op = req.get("op")
        rid = req.get("id")
        if op == "execute":
            if self.dead or not self.km.is_alive():
                emit({"id": rid, "type": "error", "ename": "KernelDied", "evalue": "The kernel isn't running: restart it.", "traceback": []})
                emit({"id": rid, "type": "done", "status": "error", "count": None})
                return
            with self.shell_lock:
                msg_id = self.kc.execute(req.get("code", ""), allow_stdin=True, stop_on_error=True)
            self.track(msg_id, rid, "execute")
        elif op == "input":
            with self.stdin_lock:
                self.kc.input(str(req.get("value", "")))
        elif op == "interrupt":
            self.km.interrupt_kernel()
        elif op == "restart":
            self.fail_pending("The kernel restarted.")
            emit({"type": "status", "state": "starting"})
            # No loop touches the sockets meanwhile (wait_for_ready reads shell and iopub).
            with self.shell_lock, self.iopub_lock, self.stdin_lock:
                alive = self.km.is_alive()
                self.km.restart_kernel(now=not alive)
                self.kc.wait_for_ready(timeout=60)
            self.dead = False
            self.vars_ready = False
            emit({"id": rid, "type": "restarted"})
            emit({"type": "status", "state": "idle"})
        elif op == "complete":
            with self.shell_lock:
                msg_id = self.kc.complete(req.get("code", ""), int(req.get("cursor", 0)))
            self.track(msg_id, rid, "complete")
        elif op == "inspect":
            with self.shell_lock:
                msg_id = self.kc.inspect(req.get("code", ""), int(req.get("cursor", 0)), detail_level=0)
            self.track(msg_id, rid, "inspect")
        elif op == "variables":
            if self.language != "python":
                emit({"id": rid, "type": "variables", "variables": [], "unsupported": True})
                return
            with self.shell_lock:
                msg_id = self.kc.execute(
                    VARIABLES_CODE, silent=True, store_history=False, user_expressions={"v": "__ide_variables()"}
                )
            self.track(msg_id, rid, "execute")
            with self.pending_lock:
                self.pending[msg_id]["vars"] = True
        elif op in ("comm_msg", "comm_close"):
            if self.dead:
                emit({"id": rid, "type": "done", "status": "error", "count": None})
                return
            content = {"comm_id": req.get("comm_id", ""), "data": req.get("data") or {}}
            msg = self.kc.session.msg(op, content, metadata=req.get("metadata") or {})
            buffers = [base64.b64decode(b) for b in req.get("buffers") or []]
            with self.pending_lock:
                self.comm_pending[msg["header"]["msg_id"]] = rid
            with self.shell_lock:
                self.kc.session.send(self.kc.shell_channel.socket, msg, buffers=buffers or None)
        elif op == "shutdown":
            self.shutdown()

    def shutdown(self):
        self.stopping = True
        try:
            self.kc.stop_channels()
        except Exception:
            pass
        try:
            self.km.shutdown_kernel(now=True)
        except Exception:
            pass


# ---- Plain Python mode -----------------------------------------------------------------------


class Interrupted(Exception):
    pass


class StreamWriter(io.TextIOBase):
    """sys.stdout / sys.stderr during a cell: text goes to the IDE a line at a time (and whatever
    is left before anything else the cell shows, and when it ends)."""

    def __init__(self, host, name):
        self.host = host
        self.name = name
        self.buffer_ = []
        self.size = 0
        self.lock = threading.Lock()

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        if text and self.host.current is not None:
            with self.lock:
                self.buffer_.append(text)
                self.size += len(text)
            # Flushed by the timer every 0.1 s, or now when a lot piled up.
            if self.size > 65536:
                self.flush()
        return len(text)

    def flush(self):
        with self.lock:
            chunk, self.buffer_, self.size = "".join(self.buffer_), [], 0
        if chunk and self.host.current is not None:
            emit({"id": self.host.current, "type": "stream", "name": self.name, "text": chunk})

    @property
    def encoding(self):
        return "utf-8"

    def isatty(self):
        return False


MIME_REPRS = [
    ("text/html", "_repr_html_"),
    ("text/markdown", "_repr_markdown_"),
    ("image/svg+xml", "_repr_svg_"),
    ("image/png", "_repr_png_"),
    ("image/jpeg", "_repr_jpeg_"),
    ("text/latex", "_repr_latex_"),
    ("application/json", "_repr_json_"),
]


def mime_bundle(value):
    data = {}
    metadata = {}
    fn = getattr(value, "_repr_mimebundle_", None)
    if callable(fn):
        try:
            res = fn()
            if isinstance(res, tuple):
                res, metadata = res[0], res[1] or {}
            if isinstance(res, dict):
                data.update(res)
        except Exception:
            pass
    for mime, attr in MIME_REPRS:
        if mime in data:
            continue
        fn = getattr(value, attr, None)
        if not callable(fn) or isinstance(value, type):
            continue
        try:
            res = fn()
        except Exception:
            continue
        if isinstance(res, tuple):
            res = res[0]
        if res is None:
            continue
        if isinstance(res, bytes):
            res = base64.b64encode(res).decode("ascii")
        data[mime] = res
    if "text/plain" not in data:
        try:
            data["text/plain"] = repr(value)
        except Exception as e:
            data["text/plain"] = "<repr failed: %s>" % e
    return data, metadata


def protect_protocol_pipes():
    """The protocol keeps the process's stdin/stdout; programs the cells start get nothing to
    read (fd 0: devnull) and what they print at the fd level (os.system, C code) is shown in
    the running cell (fd 1: a pipe read by a thread)."""
    global IN, OUT
    IN = os.fdopen(os.dup(0), "r", encoding="utf-8", errors="replace")
    OUT = os.fdopen(os.dup(1), "w", encoding="utf-8", errors="replace")
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    r, w = os.pipe()
    os.dup2(w, 1)
    os.close(w)
    return r


class PythonHost:
    def __init__(self):
        os.environ.setdefault("MPLBACKEND", "Agg")
        self.in_user_code = False
        self.waiting_input = False
        self.done_pending = None
        self.ns = {"__name__": "__main__", "__builtins__": builtins}
        self.count = 0
        self.current = None
        self.inputs = queue.Queue()
        self.busy = False
        self.ns["display"] = self.display
        sys.stdout = StreamWriter(self, "stdout")
        sys.stderr = StreamWriter(self, "stderr")
        builtins.input = self.input
        sys.stdin = io.StringIO("")
        threading.Thread(target=self.flusher, daemon=True).start()

    def flusher(self):
        while True:
            time.sleep(0.1)
            if self.current is not None:
                sys.stdout.flush()
                sys.stderr.flush()

    def fd_reader(self, fd):
        """Output written to fd 1 directly (os.system, C code): into the running cell."""
        with os.fdopen(fd, "r", encoding="utf-8", errors="replace") as pipe:
            while True:
                chunk = pipe.readline()
                if not chunk:
                    return
                if self.current is not None:
                    sys.stdout.write(chunk)

    def hello(self):
        return {
            "mode": "python",
            "kernel": "python",
            "display": "Python %s" % sys.version.split()[0],
            "language": "python",
            "python": sys.version.split()[0],
            "executable": sys.executable,
        }

    def flush_streams(self):
        sys.stdout.flush()
        sys.stderr.flush()

    def display(self, *objs, **kwargs):
        self.flush_streams()
        for obj in objs:
            data, metadata = mime_bundle(obj)
            transient = {}
            if kwargs.get("display_id"):
                transient["display_id"] = str(kwargs["display_id"])
            emit({"id": self.current, "type": "display", "data": data, "metadata": metadata, "transient": transient})

    def input(self, prompt=""):
        self.flush_streams()
        emit({"id": self.current, "type": "input_request", "prompt": str(prompt), "password": False})
        self.waiting_input = True
        try:
            value = self.inputs.get()
        finally:
            self.waiting_input = False
        if value is Interrupted:
            raise KeyboardInterrupt
        return value

    def show_figures(self):
        self.flush_streams()
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is None:
            return
        try:
            for num in plt.get_fignums():
                fig = plt.figure(num)
                buf = io.BytesIO()
                fig.savefig(buf, format="png", bbox_inches="tight")
                emit(
                    {
                        "id": self.current,
                        "type": "display",
                        "data": {"image/png": base64.b64encode(buf.getvalue()).decode("ascii"), "text/plain": repr(fig)},
                        "metadata": {},
                        "transient": {},
                    }
                )
            plt.close("all")
        except Exception as e:
            emit({"id": self.current, "type": "stream", "name": "stderr", "text": "Couldn't draw the figure: %s\n" % e})

    def shell(self, command):
        """`!command`: runs in a shell, its output streamed into the cell."""
        proc = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=os.getcwd(),
            text=True,
            errors="replace",
        )
        try:
            for line in proc.stdout:
                sys.stdout.write(line)
        except KeyboardInterrupt:
            proc.kill()
            raise
        proc.wait()
        return None

    def magic(self, line):
        """The few line magics people use without IPython."""
        name, _, rest = line[1:].partition(" ")
        rest = rest.strip()
        if name == "pip":
            self.shell('"%s" -m pip %s' % (sys.executable, rest))
            return None
        if name == "cd":
            os.chdir(os.path.expanduser(rest or "~"))
            print(os.getcwd())
            return None
        if name in ("matplotlib", "load_ext", "config", "autoreload"):
            return None
        if name == "time":
            start = time.perf_counter()
            self.run_source(rest)
            print("Wall time: %.3f s" % (time.perf_counter() - start))
            return None
        raise RuntimeError(
            "%%%s needs IPython: install ipykernel for this Python (pip install ipykernel), then choose its kernel." % name
        )

    @staticmethod
    def string_lines(code):
        """Lines inside multi-line strings (magics there are text, not magics)."""
        import tokenize

        lines = code.split("\n")
        # Magic lines aren't Python: tokenized as comments so the rest tokenizes.
        masked = "\n".join(
            ("#" + l) if l.lstrip().startswith(("!", "%")) else l for l in lines
        )
        inside = set()
        try:
            for tok in tokenize.generate_tokens(io.StringIO(masked).readline):
                if tok.type == tokenize.STRING and tok.end[0] > tok.start[0]:
                    inside.update(range(tok.start[0] + 1, tok.end[0] + 1))
        except (tokenize.TokenError, SyntaxError, IndentationError):
            pass
        return inside

    def transform(self, code):
        """`!cmd` and `%magic` lines become calls; everything else is left alone."""
        out = []
        in_strings = self.string_lines(code)
        for number, line in enumerate(code.split("\n"), 1):
            stripped = line.lstrip()
            if number in in_strings:
                out.append(line)
                continue
            indent = line[: len(line) - len(stripped)]
            if stripped.startswith("!"):
                out.append("%s__ide_host.shell(%r)" % (indent, stripped[1:]))
            elif stripped.startswith("%%"):
                raise RuntimeError("Cell magics (%s) need IPython: install ipykernel." % stripped.split()[0])
            elif stripped.startswith("%"):
                out.append("%s__ide_host.magic(%r)" % (indent, stripped))
            else:
                out.append(line)
        return "\n".join(out)

    def run_source(self, code):
        self.ns["__ide_host"] = self
        tree = ast.parse(self.transform(code), "<cell>", "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        self.in_user_code = True
        try:
            exec(compile(tree, "<cell>", "exec"), self.ns)
            if last is not None:
                return eval(compile(last, "<cell>", "eval"), self.ns)
            return None
        finally:
            self.in_user_code = False

    def execute(self, rid, code):
        self.count += 1
        self.done_pending = rid
        self.current = rid
        self.busy = True
        emit({"type": "status", "state": "busy"})
        status = "ok"
        try:
            value = self.run_source(code)
            self.show_figures()
            self.flush_streams()
            if value is not None and not code.rstrip().endswith(";"):
                self.ns["_"] = value
                data, metadata = mime_bundle(value)
                emit({"id": rid, "type": "result", "data": data, "metadata": metadata, "count": self.count})
        except KeyboardInterrupt:
            status = "error"
            self.flush_streams()
            emit({"id": rid, "type": "error", "ename": "KeyboardInterrupt", "evalue": "", "traceback": ["KeyboardInterrupt"]})
        except BaseException as e:  # SystemExit too: the cell failed, the host stays
            status = "error"
            self.flush_streams()
            self.show_figures()
            tb = traceback.format_exception(type(e), e, e.__traceback__)
            # Drop this file's frames: the user's code starts at <cell>.
            lines = [l for l in tb if __file__ not in l]
            emit({"id": rid, "type": "error", "ename": type(e).__name__, "evalue": str(e), "traceback": [ "".join(lines).rstrip() ]})
        finally:
            self.flush_streams()
            self.busy = False
            self.current = None
            self.done_pending = None
            emit({"id": rid, "type": "done", "status": status, "count": self.count})
            emit({"type": "status", "state": "idle"})

    def complete(self, rid, code, cursor):
        import re
        import rlcompleter

        before = code[:cursor]
        m = re.search(r"[A-Za-z_][\w.]*$", before)
        token = m.group(0) if m else ""
        completer = rlcompleter.Completer(self.ns)
        matches = []
        for i in range(500):
            try:
                c = completer.complete(token, i)
            except Exception:
                break
            if c is None:
                break
            matches.append(c.rstrip("("))
        emit({"id": rid, "type": "complete", "matches": matches[:200], "start": cursor - len(token), "end": cursor})

    def inspect_(self, rid, code, cursor):
        import inspect as insp
        import re

        m = re.search(r"[A-Za-z_][\w.]*$", code[:cursor])
        text = ""
        if m:
            try:
                obj = eval(m.group(0), self.ns)
                try:
                    sig = str(insp.signature(obj))
                except Exception:
                    sig = ""
                text = "%s%s\n\n%s" % (m.group(0), sig, insp.getdoc(obj) or "")
            except Exception:
                text = ""
        emit({"id": rid, "type": "inspect", "text": text.strip()})

    def variables(self, rid):
        import types

        out = []
        for k, v in list(self.ns.items()):
            if k.startswith("_") or k in ("display",) or isinstance(v, (types.ModuleType, types.FunctionType, type)):
                continue
            try:
                r = repr(v)
            except Exception:
                r = "<unprintable>"
            shape = getattr(v, "shape", None)
            size = ""
            if shape is not None:
                size = str(tuple(shape))
            else:
                try:
                    size = str(len(v)) if hasattr(v, "__len__") else ""
                except Exception:
                    size = ""
            out.append({"name": k, "type": type(v).__name__, "value": r[:300], "size": size})
        emit({"id": rid, "type": "variables", "variables": out[:500]})


def run_python():
    fd_out = protect_protocol_pipes()
    host = PythonHost()
    threading.Thread(target=host.fd_reader, args=(fd_out,), daemon=True).start()
    work = queue.Queue()

    def reader():
        import _thread

        for req in read_requests():
            op = req.get("op")
            if op == "interrupt":
                if host.busy and host.waiting_input:
                    host.inputs.put(Interrupted)
                elif host.busy and host.in_user_code:
                    # A real SIGINT wakes blocking calls (sleep, I/O) on POSIX; Windows gets
                    # the flag (a console Ctrl+C would hit the whole process group).
                    if os.name == "posix":
                        import signal

                        os.kill(os.getpid(), signal.SIGINT)
                    else:
                        _thread.interrupt_main()
            elif op == "input":
                host.inputs.put(str(req.get("value", "")))
            else:
                work.put(req)
        work.put({"op": "shutdown"})

    threading.Thread(target=reader, daemon=True).start()
    emit({"type": "hello", **host.hello(), "protocol": PROTOCOL})
    emit({"type": "status", "state": "idle"})
    while True:
        try:
            req = work.get()
        except KeyboardInterrupt:
            # An interrupt that landed after a cell: its end is still reported.
            if host.done_pending is not None:
                rid, host.done_pending = host.done_pending, None
                host.busy = False
                host.current = None
                emit({"id": rid, "type": "done", "status": "error", "count": host.count})
            continue
        op = req.get("op")
        rid = req.get("id")
        try:
            if op == "execute":
                # Drop a stale interrupt meant for a cell that already ended.
                while not host.inputs.empty():
                    host.inputs.get_nowait()
                host.execute(rid, req.get("code", ""))
            elif op == "complete":
                host.complete(rid, req.get("code", ""), int(req.get("cursor", 0)))
            elif op == "inspect":
                host.inspect_(rid, req.get("code", ""), int(req.get("cursor", 0)))
            elif op == "variables":
                host.variables(rid)
            elif op == "restart":
                # A fresh process is cleaner than a cleared namespace: the IDE starts one.
                emit({"id": rid, "type": "restart_by_respawn"})
            elif op in ("comm_msg", "comm_close"):
                # No comms without a Jupyter kernel (widgets need ipykernel).
                emit({"id": rid, "type": "done", "status": "error", "count": None})
            elif op == "shutdown":
                break
        except KeyboardInterrupt:
            # An interrupt that arrived as a cell ended: it still ends, once.
            if host.done_pending is not None:
                rid, host.done_pending = host.done_pending, None
                host.busy = False
                host.current = None
                emit({"id": rid, "type": "done", "status": "error", "count": host.count})
            continue


def run_jupyter(kernel):
    try:
        host = JupyterHost(kernel)
    except Exception as e:
        emit({"type": "fatal", "error": "Couldn't start the kernel %s: %s" % (kernel or "python3", e)})
        return 1
    emit({"type": "hello", **host.hello(), "protocol": PROTOCOL})
    try:
        for req in read_requests():
            try:
                host.handle(req)
            except Exception as e:
                emit({"id": req.get("id"), "type": "error", "ename": type(e).__name__, "evalue": str(e), "traceback": []})
                if req.get("op") == "execute":
                    emit({"id": req.get("id"), "type": "done", "status": "error", "count": None})
            if req.get("op") == "shutdown":
                return 0
    finally:
        host.shutdown()
    return 0


def main(argv):
    if "--list" in argv:
        emit(list_specs())
        return 0
    mode = "auto"
    kernel = None
    if "--mode" in argv:
        mode = argv[argv.index("--mode") + 1]
    if "--kernel" in argv:
        kernel = argv[argv.index("--kernel") + 1]
    if mode == "jupyter" or (mode == "auto" and jupyter_available() and (kernel or list_specs()["ipykernel"])):
        return run_jupyter(kernel)
    run_python()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
