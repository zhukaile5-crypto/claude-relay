"""Bounded project staging and fixed LaTeX toolchain orchestration inside MXC."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import ctypes
import importlib.util
import json
import ntpath
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid

sys.dont_write_bytecode = True

RUNTIME = Path(r"C:\ClaudeRelayRuntime")
TOOLS = RUNTIME / "tools" / "tex"
PYTHON = RUNTIME / "py314" / "python.exe"
ENGINE = TOOLS / "tex_engine.py"
BIBTEX = TOOLS / "bibtex_backend.py"
BIBER = TOOLS / "biber_backend.py"
JOB = "document"
INPUT = "relayinput.tex"
LEASE = ".relay-tex-lease.json"
STALE_SECONDS = 24 * 60 * 60
EXCLUDED_DIRS = {"node_modules", "__pycache__", "venv", "env", "build", "dist"}
GENERATED_SUFFIXES = (".aux", ".bcf", ".blg", ".fdb_latexmk", ".fls", ".log", ".out",
                      ".run.xml", ".toc", ".nav", ".snm", ".vrb", ".xdv", ".dvi", ".synctex.gz")


class CompileError(RuntimeError):
    pass


@dataclass(frozen=True)
class Limits:
    files: int = 4096
    bytes: int = 256 * 1024 * 1024
    file_bytes: int = 64 * 1024 * 1024
    depth: int = 16
    transcript_bytes: int = 2 * 1024 * 1024
    pdf_bytes: int = 128 * 1024 * 1024
    process_seconds: int = 120
    total_seconds: int = 480


@dataclass(frozen=True)
class Context:
    workspace: Path
    scratch: Path
    python: Path = PYTHON
    engine: Path = ENGINE
    bibtex: Path = BIBTEX
    biber: Path = BIBER


def _plain(path: Path, directory: bool | None = None):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise CompileError("Project and output paths cannot contain links or reparse points")
    if directory is True and not stat.S_ISDIR(info.st_mode):
        raise CompileError("Expected a physical directory")
    if directory is False and not stat.S_ISREG(info.st_mode):
        raise CompileError("Expected a regular source file")
    return info


def _relative(value: str) -> Path:
    # Apply Windows path rules even in the portable, synthetic unit tests.
    if not isinstance(value, str) or not value or "\x00" in value or ":" in value:
        raise CompileError("Use a workspace-relative path")
    windows = PureWindowsPath(value)
    if windows.is_absolute() or windows.drive or windows.root or ".." in windows.parts:
        raise CompileError("Path escapes the workspace")
    return Path(*windows.parts)


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _process_identity(pid: int):
    """Return (alive/exited/absent/unknown, kernel creation identity)."""
    if os.name != "nt":
        # Portable tests use the kernel's process start tick in the same role.
        try:
            text = Path("/proc", str(pid), "stat").read_text()
            fields = text[text.rfind(")") + 2:].split()
            return ("exited" if fields[0] == "Z" else "alive", int(fields[19]))
        except FileNotFoundError:
            return "absent", None
        except Exception:
            return "unknown", None
    from ctypes import wintypes as W
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    kernel.OpenProcess.restype = W.HANDLE
    kernel.GetProcessTimes.argtypes = [W.HANDLE, *([ctypes.POINTER(W.FILETIME)] * 4)]
    kernel.GetProcessTimes.restype = W.BOOL
    kernel.GetExitCodeProcess.argtypes = [W.HANDLE, ctypes.POINTER(W.DWORD)]
    kernel.GetExitCodeProcess.restype = W.BOOL
    kernel.CloseHandle.argtypes = [W.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ("absent", None) if ctypes.get_last_error() == 87 else ("unknown", None)
    try:
        values, code = [W.FILETIME() for _ in range(4)], W.DWORD()
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)) or not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            return "unknown", None
        created = (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime
        return ("alive" if code.value == 259 else "exited", created)
    finally:
        kernel.CloseHandle(handle)


def _write_lease(stage: Path):
    state, created = _process_identity(os.getpid())
    if state != "alive" or created is None:
        raise CompileError("Cannot bind the temporary project to its process identity")
    temporary = stage / (LEASE + ".tmp")
    with temporary.open("x", encoding="ascii") as stream:
        json.dump({"pid": os.getpid(), "created": str(created)}, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, stage / LEASE)


def _safe_remove_stage(stage: Path, scratch: Path) -> bool:
    """Hold every Windows directory against rename while deleting by handle."""
    if stage.parent != scratch or not re.fullmatch(r"tex-[0-9a-f]{10,32}", stage.name):
        return False
    try:
        _plain(scratch, True)
        _plain(stage, True)
        if scratch.resolve(strict=True) != scratch or stage.resolve(strict=True) != stage:
            return False
        # First refuse an abnormal tree without partially clearing its ordinary files.
        count = 0
        pending = [(stage, 0)]
        while pending:
            directory, depth = pending.pop()
            if depth > 32:
                return False
            with os.scandir(directory) as entries:
                for entry in entries:
                    count += 1
                    if count > 20000:
                        return False
                    child = directory / entry.name
                    info = _plain(child)
                    if stat.S_ISDIR(info.st_mode):
                        pending.append((child, depth + 1))
                    elif not stat.S_ISREG(info.st_mode):
                        return False
        if os.name != "nt":
            if not shutil.rmtree.avoids_symlink_attacks:
                return False
            shutil.rmtree(stage)
            return True
        from ctypes import wintypes as W
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p, W.DWORD, W.DWORD, W.HANDLE]
        kernel.CreateFileW.restype = W.HANDLE
        kernel.GetFinalPathNameByHandleW.argtypes = [W.HANDLE, W.LPWSTR, W.DWORD, W.DWORD]
        kernel.GetFinalPathNameByHandleW.restype = W.DWORD
        kernel.SetFileInformationByHandle.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
        kernel.SetFileInformationByHandle.restype = W.BOOL
        kernel.CloseHandle.argtypes = [W.HANDLE]

        class FileInfo(ctypes.Structure):
            _fields_ = [("attributes", W.DWORD), ("created", W.FILETIME), ("accessed", W.FILETIME),
                        ("written", W.FILETIME), ("volume", W.DWORD), ("size_high", W.DWORD),
                        ("size_low", W.DWORD), ("links", W.DWORD), ("index_high", W.DWORD), ("index_low", W.DWORD)]
        kernel.GetFileInformationByHandle.argtypes = [W.HANDLE, ctypes.POINTER(FileInfo)]
        kernel.GetFileInformationByHandle.restype = W.BOOL
        invalid = ctypes.c_void_p(-1).value

        def open_entry(file: Path, delete: bool):
            # Share read/write, never delete: a held ancestor cannot be renamed or
            # replaced by a junction while its children are being inspected/deleted.
            handle = kernel.CreateFileW(str(file), 0x80 | (0x10000 if delete else 0), 3, None, 3, 0x00200000 | 0x02000000, None)
            if handle == invalid:
                raise OSError("Cannot lock temporary path for removal")
            try:
                info, name = FileInfo(), ctypes.create_unicode_buffer(32768)
                if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)) or info.attributes & 0x400:
                    raise OSError("Temporary path became a reparse point")
                length = kernel.GetFinalPathNameByHandleW(handle, name, len(name), 0)
                if not 0 < length < len(name):
                    raise OSError("Cannot verify temporary path")
                actual = name.value[4:] if name.value.startswith("\\\\?\\") else name.value
                if ntpath.normcase(ntpath.normpath(actual)) != ntpath.normcase(str(file)):
                    raise OSError("Temporary path was redirected")
                return handle, bool(info.attributes & 0x10)
            except BaseException:
                kernel.CloseHandle(handle)
                raise

        removed_entries = 0
        def remove(file: Path, depth: int = 0):
            nonlocal removed_entries
            removed_entries += 1
            if depth > 32 or removed_entries > 20001:
                raise OSError("Temporary tree depth changed")
            handle, directory = open_entry(file, True)
            try:
                if directory:
                    with os.scandir(file) as entries:
                        for entry in entries:
                            remove(file / entry.name, depth + 1)
                disposition = W.BOOL(True)
                if not kernel.SetFileInformationByHandle(handle, 4, ctypes.byref(disposition), ctypes.sizeof(disposition)):
                    raise OSError("Temporary entry cannot be removed")
            finally:
                kernel.CloseHandle(handle)
        root_handle, directory = open_entry(scratch, False)
        try:
            if not directory:
                return False
            remove(stage)
        finally:
            kernel.CloseHandle(root_handle)
        return not stage.exists()
    except (OSError, CompileError, ValueError):
        return False


def _reap_stages(scratch: Path):
    """Best effort, account-local reclamation; uncertain/live leases stay intact."""
    reaped = 0
    now = time.time()
    with os.scandir(scratch) as entries:
        for index, entry in enumerate(entries):
            if index >= 256:
                break
            if not re.fullmatch(r"tex-[0-9a-f]{10,32}", entry.name):
                continue
            stage = scratch / entry.name
            try:
                info = _plain(stage, True)
                if stage.resolve(strict=True) != stage:
                    continue
                try:
                    lease = json.loads(_read_bounded(stage / LEASE, 512))
                    if set(lease) != {"pid", "created"} or type(lease["pid"]) is not int or not 0 < lease["pid"] <= 0xffffffff or not isinstance(lease["created"], str) or not re.fullmatch(r"[0-9]{1,24}", lease["created"]):
                        raise ValueError("Invalid lease")
                except (OSError, CompileError, ValueError, TypeError):
                    # Invalid/missing leases have no process identity to trust.
                    if now - max(info.st_mtime, info.st_ctime) < STALE_SECONDS:
                        continue
                else:
                    state, created = _process_identity(lease["pid"])
                    if state == "unknown" or (state == "alive" and str(created) == lease["created"]):
                        continue
                    if state not in {"absent", "exited", "alive"}:
                        continue
                if _safe_remove_stage(stage, scratch):
                    reaped += 1
            except (OSError, CompileError, ValueError):
                continue
    return reaped


def _workspace_path(root: Path, relative: str, *, create_parent: bool = False, allow_missing: bool = False) -> Path:
    target = root / _relative(relative)
    current = root
    _plain(current, True)
    for index, component in enumerate(target.relative_to(root).parts):
        current /= component
        last = index == len(target.relative_to(root).parts) - 1
        if current.exists() or current.is_symlink():
            _plain(current, None if last else True)
        elif create_parent and not last:
            current.mkdir()
            _plain(current, True)
        elif not last and not allow_missing:
            raise CompileError("Project directory does not exist")
    return target


def _open_source(path: Path, workspace: Path):
    """Reject a swapped final link and verify the opened file's physical path."""
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            actual = Path(os.path.realpath("/proc/self/fd/" + str(fd))) if Path("/proc/self/fd").exists() else path.resolve(strict=True)
            if actual != path or not _inside(actual, workspace):
                raise CompileError("Source was redirected while staging")
            return os.fdopen(fd, "rb")
        except BaseException:
            os.close(fd)
            raise
    from ctypes import wintypes as W
    import msvcrt
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p, W.DWORD, W.DWORD, W.HANDLE]
    kernel.CreateFileW.restype = W.HANDLE
    kernel.GetFinalPathNameByHandleW.argtypes = [W.HANDLE, W.LPWSTR, W.DWORD, W.DWORD]
    kernel.GetFinalPathNameByHandleW.restype = W.DWORD
    kernel.CloseHandle.argtypes = [W.HANDLE]
    handle = kernel.CreateFileW(str(path), 0x80000000, 7, None, 3, 0x00200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise CompileError("Cannot open source file (Win32 %s)" % ctypes.get_last_error())
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        count = kernel.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
        if not 0 < count < len(buffer):
            raise CompileError("Cannot verify opened source path")
        actual = buffer.value
        if actual.startswith("\\\\?\\UNC\\"):
            actual = "\\\\" + actual[8:]
        elif actual.startswith("\\\\?\\"):
            actual = actual[4:]
        if ntpath.normcase(ntpath.normpath(actual)) != ntpath.normcase(str(path)):
            raise CompileError("Source was redirected while staging")
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None  # fd now owns the handle.
        stream = os.fdopen(fd, "rb")
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            stream.close()
            raise CompileError("Opened source is a link or non-regular file")
        return stream
    finally:
        if handle is not None:
            kernel.CloseHandle(handle)


def _copy_project(project: Path, stage: Path, workspace: Path, excluded: set[Path], limits: Limits):
    totals = {"files": 0, "bytes": 0, "excludedDirectories": 0}

    def walk(directory: Path, target: Path, depth: int):
        _plain(directory, True)
        if depth > limits.depth:
            raise CompileError("Project exceeds the directory depth limit")
        # Do not build an unbounded list before the file-count guard runs.
        with os.scandir(directory) as entries:
            for entry in entries:
                totals["files"] += 1
                if totals["files"] > limits.files:
                    raise CompileError("Project exceeds the file-count limit")
                source = directory / entry.name
                info = _plain(source)
                destination = target / entry.name
                if stat.S_ISDIR(info.st_mode):
                    if entry.name.startswith(".") or entry.name.lower() in EXCLUDED_DIRS:
                        totals["excludedDirectories"] += 1
                        continue
                    destination.mkdir()
                    walk(source, destination, depth + 1)
                elif stat.S_ISREG(info.st_mode):
                    if source in excluded or entry.name.lower().endswith(GENERATED_SUFFIXES):
                        continue
                    if info.st_size > limits.file_bytes:
                        raise CompileError("Project exceeds its file-count or single-file byte limit")
                    copied = 0
                    with _open_source(source, workspace) as src, destination.open("xb") as dst:
                        while chunk := src.read(1024 * 1024):
                            copied += len(chunk)
                            totals["bytes"] += len(chunk)
                            if copied > limits.file_bytes or totals["bytes"] > limits.bytes:
                                raise CompileError("Project exceeds the staging byte limit")
                            dst.write(chunk)
                else:
                    raise CompileError("Project contains a non-regular file")
    walk(project, stage, 0)
    return totals


def _run_process(command, *, cwd: Path, timeout: float, max_output: int):
    options = {"cwd": str(cwd), "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
               "stderr": subprocess.STDOUT, "creationflags": 0x08000000 if os.name == "nt" else 0}
    process = subprocess.Popen(command, **options)
    output, overflow = bytearray(), threading.Event()

    def read():
        try:
            while chunk := process.stdout.read(65536):
                room = max_output - len(output)
                output.extend(chunk[:max(0, room)])
                if len(chunk) > room:
                    overflow.set()
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    break
        finally:
            process.stdout.close()
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.wait(timeout=5)
        raise CompileError("LaTeX subprocess exceeded its time limit") from error
    finally:
        reader.join(timeout=5)
    if reader.is_alive():
        raise CompileError("LaTeX output pipe did not close")
    if overflow.is_set():
        raise CompileError("LaTeX subprocess exceeded its output limit")
    return subprocess.CompletedProcess(command, process.returncode, bytes(output))


def _read_bounded(path: Path, maximum: int) -> bytes:
    _plain(path, False)
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise CompileError("Generated artifact exceeds the byte limit")
    return data


def _publish(workspace: Path, relative: str, data: bytes):
    target = _workspace_path(workspace, relative, create_parent=True)
    if target.exists():
        _plain(target, False)
    temp = target.parent / (".relay-tex-" + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("xb") as stream:
            stream.write(data)
            stream.flush()
        # Recheck destination components immediately before replacing the file.
        _workspace_path(workspace, relative, create_parent=True)
        os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()


def compile_project(context: Context, source: str, *, project_root: str | None = None,
                    output: str | None = None, engine: str = "xelatex",
                    bibliography: str = "auto", passes: int = 2,
                    limits: Limits = Limits(), runner=None):
    """Library entry used by the fixed CLI and synthetic filesystem tests."""
    if engine not in {"xelatex", "pdflatex"} or bibliography not in {"auto", "none", "biber", "pybtex"}:
        raise CompileError("Unsupported fixed LaTeX toolchain selection")
    if not isinstance(passes, int) or isinstance(passes, bool) or not 2 <= passes <= 4:
        raise CompileError("LaTeX requires between two and four passes")
    workspace, scratch = context.workspace.absolute(), context.scratch.absolute()
    for directory in [workspace, scratch]:
        _plain(directory, True)
        if directory.resolve(strict=True) != directory:
            raise CompileError("Workspace and scratch must be physical directories")
    if _inside(scratch, workspace) or _inside(workspace, scratch):
        raise CompileError("Scratch and project workspace must be separate")
    main = _workspace_path(workspace, source)
    _plain(main, False)
    if main.suffix.lower() != ".tex":
        raise CompileError("Source must be a .tex file")
    project = _workspace_path(workspace, project_root) if project_root is not None else main.parent
    _plain(project, True)
    if not _inside(main, project):
        raise CompileError("Project root must contain the main .tex source")
    output = output or str(_relative(source).with_suffix(".pdf"))
    destination = _workspace_path(workspace, output, allow_missing=True)
    if destination.suffix.lower() != ".pdf":
        raise CompileError("Output must be a workspace-relative .pdf path")
    log_relative = str(_relative(output).with_suffix(".compile.log"))
    log_destination = _workspace_path(workspace, log_relative, allow_missing=True)
    for entry in [context.python, context.engine]:
        _plain(entry, False)
    recovered = _reap_stages(scratch)
    stage = scratch / ("tex-" + uuid.uuid4().hex[:20])
    stage.mkdir()
    transcript = bytearray()
    started, steps, backend, totals = time.monotonic(), [], None, {}
    execute = runner or _run_process

    def run(script: Path, args: list[str], label: str):
        _plain(script, False)
        remaining = limits.total_seconds - (time.monotonic() - started)
        if remaining <= 0:
            raise CompileError("LaTeX compilation exceeded its total time limit")
        result = execute([str(context.python), "-X", "utf8", "-I", "-S", str(script), *args],
                         cwd=work, timeout=min(limits.process_seconds, remaining), max_output=limits.transcript_bytes)
        text = result.stdout if isinstance(result.stdout, bytes) else str(result.stdout or "").encode("utf-8", "replace")
        transcript.extend(("\n--- " + label + " ---\n").encode() + text)
        if len(transcript) > limits.transcript_bytes:
            raise CompileError("LaTeX transcript exceeds the byte limit")
        steps.append(label)
        if result.returncode != 0:
            raise CompileError(label + " failed with exit code " + str(result.returncode))

    def tex():
        run(context.engine, [json.dumps({"engine": engine, "work": str(work), "input": INPUT, "job": JOB}, ensure_ascii=True)], engine)

    try:
        _write_lease(stage)
        totals = _copy_project(project, stage, workspace, {destination, log_destination}, limits)
        copied_main = stage / main.relative_to(project)
        work = copied_main.parent
        alias = work / INPUT
        if alias != copied_main:
            if alias.exists():
                raise CompileError("Project contains the reserved staging filename relayinput.tex")
            totals["files"] += 1
            totals["bytes"] += copied_main.stat().st_size
            if totals["files"] > limits.files or totals["bytes"] > limits.bytes:
                raise CompileError("ASCII entry copy exceeds the staging limit")
            # The original copied filename remains available for relative includes.
            shutil.copyfile(copied_main, alias)
        tex()
        bcf, aux = work / (JOB + ".bcf"), work / (JOB + ".aux")
        has_biber = bcf.exists() and b"datasource" in _read_bounded(bcf, 8 * 1024 * 1024)
        has_bibtex = aux.exists() and b"\\bibdata" in _read_bounded(aux, 1024 * 1024)
        backend = ("biber" if has_biber else "pybtex" if has_bibtex else None) if bibliography == "auto" else None if bibliography == "none" else bibliography
        if backend == "biber":
            if not has_biber:
                raise CompileError("Biber requires the generated bibliography control file")
            run(context.biber, [JOB], "biber")
        elif backend == "pybtex":
            if not has_bibtex:
                raise CompileError("Pybtex requires bibliography data in the generated auxiliary file")
            run(context.bibtex, [JOB + ".aux"], "pybtex")
        if backend:
            _read_bounded(work / (JOB + ".bbl"), 16 * 1024 * 1024)
        for _ in range(max(passes - 1, 2 if backend else 1)):
            tex()
        if engine == "xelatex":
            run(context.engine, [json.dumps({"engine": "xdvipdfmx", "work": str(work), "input": JOB + ".xdv", "job": JOB})], "xdvipdfmx")
        pdf = _read_bounded(work / (JOB + ".pdf"), limits.pdf_bytes)
        if not pdf.startswith(b"%PDF-"):
            raise CompileError("Compiler did not produce a PDF")
        log = work / (JOB + ".log")
        engine_log = _read_bounded(log, limits.transcript_bytes) if log.exists() else b""
        # Keep the final engine log and the bounded subprocess transcript together.
        report = bytes(transcript[-limits.transcript_bytes // 2:]) + b"\n--- final TeX log ---\n" + engine_log[-limits.transcript_bytes // 2:]
        warnings = []
        if re.search(rb"undefined (?:references|citations)|(?:Citation|Reference) .+ undefined", engine_log, re.I):
            warnings.append("The final TeX log contains unresolved citations or references")
        _publish(workspace, log_relative, report)
        _publish(workspace, output, pdf)
        return {"ok": True, "pdf": output, "log": log_relative, "engine": engine,
                "bibliography": backend, "steps": steps, "staged": totals, "recoveredStages": recovered, "warnings": warnings}
    except BaseException as error:
        failure = (bytes(transcript) + ("\nCompilation failed: " + str(error)).encode("utf-8", "replace"))[-limits.transcript_bytes:]
        try:
            _publish(workspace, log_relative, failure)
        except Exception:
            pass  # Preserve the original failure; never fall back outside the worker.
        raise
    finally:
        # This exact random directory was created above, outside the original project.
        if not _safe_remove_stage(stage, scratch):
            raise CompileError("Temporary project cleanup was deferred; its process lease will be checked on the next compile")


def _production_context():
    spec = importlib.util.spec_from_file_location("relay_tex_environment", TOOLS / "environment_guard.py")
    if spec is None or spec.loader is None:
        raise CompileError("Verified TeX environment guard is unavailable")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    guard.verify_environment()
    workspace = Path(os.environ.get("RELAY_WORKSPACE", ""))
    temporary = Path(os.environ.get("TEMP", ""))
    if not workspace.is_absolute() or not temporary.is_absolute() or temporary.name.lower() != "temp":
        raise CompileError("Missing verified worker directory binding")
    scratch = temporary.parent
    expected = re.compile(r"C:\\Users\\user\\ClaudeRelayIsolation\\s\\[0-9a-f]{20}", re.I)
    if not expected.fullmatch(str(scratch)):
        raise CompileError("Expected the account's physical C scratch directory")
    return Context(workspace, scratch)


def main():
    parser = argparse.ArgumentParser(description="Compile a workspace LaTeX project through the fixed isolated runtime")
    parser.add_argument("--source", required=True, help="Workspace-relative main .tex file")
    parser.add_argument("--project-root", help="Common workspace-relative root, including any ../ resources")
    parser.add_argument("--output", help="Workspace-relative output PDF")
    parser.add_argument("--engine", choices=["xelatex", "pdflatex"], default="xelatex")
    parser.add_argument("--bibliography", choices=["auto", "none", "biber", "pybtex"], default="auto")
    parser.add_argument("--passes", type=int, choices=[2, 3, 4], default=2)
    args = parser.parse_args()
    try:
        result = compile_project(_production_context(), **vars(args))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
