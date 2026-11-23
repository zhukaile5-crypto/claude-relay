"""Fail-closed Win32 checks for the isolated TeX runtime; no GUI operations."""
import ctypes
from ctypes import wintypes as W
import ntpath
import os
import re

_EXPECTED_NODE = r"C:\Program Files\nodejs\node.exe"
_EXPECTED_PYTHON = r"C:\ClaudeRelayRuntime\py314\python.exe"
_EXPECTED_POWERSHELL = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"


def verify_environment():
    """Return non-secret kernel identities, or raise RuntimeError.

    Only a live same-AppContainer ancestry through the pinned Python/PowerShell runtimes to
    the pinned worker Node is accepted. Names/environment variables alone never
    establish the token boundary.
    """
    if os.name != "nt":
        raise RuntimeError("TeX runtime requires the verified Windows worker")
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    a = ctypes.WinDLL("advapi32", use_last_error=True)
    u = ctypes.WinDLL("user32", use_last_error=True)
    n = ctypes.WinDLL("ntdll", use_last_error=True)
    HANDLE, DWORD, BOOL = W.HANDLE, W.DWORD, W.BOOL
    PDWORD = ctypes.POINTER(DWORD)

    def bind(lib, name, args, result):
        fn = getattr(lib, name)
        fn.argtypes, fn.restype = args, result
        return fn

    current = bind(k, "GetCurrentProcess", [], HANDLE)
    current_tid = bind(k, "GetCurrentThreadId", [], DWORD)
    close = bind(k, "CloseHandle", [HANDLE], BOOL)
    local_free = bind(k, "LocalFree", [ctypes.c_void_p], ctypes.c_void_p)
    open_process = bind(k, "OpenProcess", [DWORD, BOOL, DWORD], HANDLE)
    open_token = bind(a, "OpenProcessToken", [HANDLE, DWORD, ctypes.POINTER(HANDLE)], BOOL)
    token_info = bind(a, "GetTokenInformation", [HANDLE, ctypes.c_int, ctypes.c_void_p, DWORD, PDWORD], BOOL)
    sid_string = bind(a, "ConvertSidToStringSidW", [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)], BOOL)
    in_job = bind(k, "IsProcessInJob", [HANDLE, HANDLE, ctypes.POINTER(BOOL)], BOOL)
    exit_code = bind(k, "GetExitCodeProcess", [HANDLE, PDWORD], BOOL)
    image_name = bind(k, "QueryFullProcessImageNameW", [HANDLE, DWORD, W.LPWSTR, PDWORD], BOOL)
    process_times = bind(k, "GetProcessTimes", [HANDLE, ctypes.POINTER(W.FILETIME), ctypes.POINTER(W.FILETIME), ctypes.POINTER(W.FILETIME), ctypes.POINTER(W.FILETIME)], BOOL)
    window_station = bind(u, "GetProcessWindowStation", [], HANDLE)
    thread_desktop = bind(u, "GetThreadDesktop", [DWORD], HANDLE)
    object_info = bind(u, "GetUserObjectInformationW", [HANDLE, ctypes.c_int, ctypes.c_void_p, DWORD, PDWORD], BOOL)

    class PBI(ctypes.Structure):
        _fields_ = [("reserved1", ctypes.c_void_p), ("peb", ctypes.c_void_p),
                    ("reserved2", ctypes.c_void_p * 2), ("pid", ctypes.c_size_t),
                    ("parent_pid", ctypes.c_size_t)]
    query_process = bind(n, "NtQueryInformationProcess",
                         [HANDLE, ctypes.c_int, ctypes.POINTER(PBI), DWORD, PDWORD],
                         W.LONG)

    def checked(ok, operation):
        if not ok:
            raise RuntimeError(operation + " failed (Win32 " + str(ctypes.get_last_error()) + ")")

    def container_sid(process):
        token = HANDLE()
        checked(open_token(process, 8, ctypes.byref(token)), "Open process token")
        try:
            flag, needed = DWORD(), DWORD()
            checked(token_info(token, 29, ctypes.byref(flag), ctypes.sizeof(flag), ctypes.byref(needed)), "AppContainer flag")
            if flag.value != 1:
                raise RuntimeError("TeX runtime refuses a non-AppContainer process")
            token_info(token, 31, None, 0, ctypes.byref(needed))
            if not ctypes.sizeof(ctypes.c_void_p) <= needed.value <= 4096:
                raise RuntimeError("Invalid AppContainer identity length")
            data = ctypes.create_string_buffer(needed.value)
            checked(token_info(token, 31, data, len(data), ctypes.byref(needed)), "AppContainer SID")
            sid = ctypes.c_void_p.from_buffer(data).value
            if not sid:
                raise RuntimeError("Missing AppContainer SID")
            text = ctypes.c_void_p()
            checked(sid_string(sid, ctypes.byref(text)), "Convert AppContainer SID")
            try:
                value = ctypes.wstring_at(text)
            finally:
                local_free(text)
            if not re.fullmatch(r"S-1-15-2-(?:\d+-){6}\d+", value):
                raise RuntimeError("Unexpected AppContainer SID")
            return value
        finally:
            close(token)

    def require_job(process):
        inside = BOOL()
        checked(in_job(process, None, ctypes.byref(inside)), "Query worker Job")
        if not inside.value:
            raise RuntimeError("TeX process is outside its worker Job")

    def created(process):
        values = [W.FILETIME() for _ in range(4)]
        checked(process_times(process, *(ctypes.byref(v) for v in values)), "Query process creation")
        return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime

    def parent_pid(process):
        info, length = PBI(), DWORD()
        status = query_process(process, 0, ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(length))
        if status < 0 or not info.parent_pid or info.parent_pid == info.pid:
            raise RuntimeError("Cannot establish the worker ancestry")
        return info.parent_pid

    def object_name(handle):
        checked(handle, "Open current desktop identity")
        needed = DWORD()
        object_info(handle, 2, None, 0, ctypes.byref(needed))
        if not 2 <= needed.value <= 4096:
            raise RuntimeError("Invalid desktop identity length")
        value = ctypes.create_unicode_buffer((needed.value + 1) // 2)
        checked(object_info(handle, 2, value, ctypes.sizeof(value), ctypes.byref(needed)), "Read desktop identity")
        return value.value

    self_handle = current()
    sid = container_sid(self_handle)
    require_job(self_handle)
    station_handle = window_station()
    station = object_name(station_handle)
    desktop = object_name(thread_desktop(current_tid()))
    if not re.fullmatch(r"Service-[A-Za-z0-9$-]+", station):
        raise RuntimeError("TeX runtime requires a noninteractive Service station")
    if not re.fullmatch(r"RelayExec_[0-9a-f]{32}", desktop):
        raise RuntimeError("TeX runtime requires the verified private execution desktop")

    class ObjectFlags(ctypes.Structure):
        _fields_ = [("inherit", BOOL), ("reserved", BOOL), ("flags", DWORD)]
    flags, needed = ObjectFlags(), DWORD()
    checked(object_info(station_handle, 1, ctypes.byref(flags), ctypes.sizeof(flags), ctypes.byref(needed)), "Read station flags")
    if flags.flags & 1:
        raise RuntimeError("TeX runtime refuses a visible window station")

    opened, ancestry, seen = [], [], {os.getpid()}
    child, child_created = self_handle, created(self_handle)
    try:
        for _ in range(4):
            pid = parent_pid(child)
            if pid in seen:
                raise RuntimeError("Repeated ancestor identity")
            seen.add(pid)
            parent = open_process(0x1000, False, pid)
            checked(parent, "Open worker ancestor")
            opened.append(parent)
            parent_created = created(parent)
            if parent_created >= child_created:
                raise RuntimeError("Worker ancestor was replaced")
            code = DWORD()
            checked(exit_code(parent, ctypes.byref(code)), "Read worker ancestor state")
            if code.value != 259:
                raise RuntimeError("Worker ancestor already exited")
            if container_sid(parent) != sid:
                raise RuntimeError("Worker ancestor AppContainer differs")
            require_job(parent)
            length, name = DWORD(32768), ctypes.create_unicode_buffer(32768)
            checked(image_name(parent, 0, name, ctypes.byref(length)), "Read worker ancestor image")
            image = ntpath.normcase(ntpath.normpath(name.value))
            ancestry.append({"pid": pid, "image": image, "created": parent_created})
            if image == ntpath.normcase(_EXPECTED_NODE):
                return {"appContainerSid": sid, "station": station, "desktop": desktop,
                        "inJob": True, "pid": os.getpid(), "ancestors": ancestry}
            if image not in {ntpath.normcase(_EXPECTED_PYTHON), ntpath.normcase(_EXPECTED_POWERSHELL)}:
                raise RuntimeError("Unexpected worker ancestor executable")
            child, child_created = parent, parent_created
        raise RuntimeError("Pinned worker Node ancestor not found")
    finally:
        for handle in reversed(opened):
            close(handle)
