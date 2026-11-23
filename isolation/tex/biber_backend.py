"""Run the installed Biber payload inside the verified isolated TeX worker."""
import ctypes
from ctypes import wintypes as W
import hashlib
import os
import pathlib
import re
import stat
import sys

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from environment_guard import verify_environment

ROOT = pathlib.Path(r"C:\ClaudeRelayRuntime\biber")
DLL_HASHES = {
    "libgcc_s_seh-1.dll": "5c67505c405f717d59ff2c583a11f54300dc9bf1577713b5dbbd00588c957325",
    "perl532.dll": "394596cf63d6175422ab2e34a5104be3d04a0b61c2fb77100fb058809387d2c4",
    "libwinpthread-1.dll": "0d9f9c09d4219d6c74930de38e35c454add54ba7117748f8b4f65f8eac624a96",
    "libstdc++-6.dll": "03ad55828067fad4d24932ebb7a5b45e40c96255238775a6e02b1478e3b31d87",
}


def staged_job():
    if len(sys.argv) != 2 or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,79}(?:\.bcf)?", sys.argv[1]):
        raise RuntimeError("Expected one staged Biber job name")
    job = sys.argv[1].removesuffix(".bcf")
    temp = pathlib.Path(os.environ["TEMP"])
    scratch = temp.parent
    if temp.name.casefold() != "temp" or not re.fullmatch(
        r"C:\\Users\\user\\ClaudeRelayIsolation\\s\\[0-9a-f]{20}", str(scratch), re.I
    ):
        raise RuntimeError("Expected the account's physical temporary directory")
    if scratch.resolve(strict=True) != scratch:
        raise RuntimeError("Temporary directory cannot be redirected")
    work = pathlib.Path.cwd()
    if work.resolve(strict=True) != work:
        raise RuntimeError("Bibliography directory cannot be redirected")
    relative = work.relative_to(scratch)
    if not relative.parts or not re.fullmatch(r"tex-[0-9a-f]{10,32}", relative.parts[0]):
        raise RuntimeError("Biber must run in the staged TeX project")
    current = scratch
    for part in relative.parts:
        current /= part
        if current.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise RuntimeError("Bibliography directories cannot be redirected")
    control = work / (job + ".bcf")
    info = control.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise RuntimeError("Expected a regular staged Biber control file")
    if control.resolve(strict=True).parent != work or info.st_size > 64 * 1024 * 1024:
        raise RuntimeError("Invalid staged Biber control file")
    return work, job


def main():
    verify_environment()
    work, job = staged_job()
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = W.HANDLE
    kernel.GetProcessMitigationPolicy.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t]
    kernel.GetProcessMitigationPolicy.restype = W.BOOL
    policy = W.DWORD()
    if not kernel.GetProcessMitigationPolicy(
        kernel.GetCurrentProcess(), 1, ctypes.byref(policy), ctypes.sizeof(policy)
    ) or policy.value & 15 != 15:
        raise RuntimeError("Biber requires the worker's complete ASLR policy")
    for name, digest in DLL_HASHES.items():
        if hashlib.sha256((ROOT / "bin" / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError("Biber runtime integrity check failed")
    binary = str(ROOT / "bin")
    libraries = str(ROOT / "package" / "shlib" / "MSWin32-x64-multi-thread")
    dll_directories = [os.add_dll_directory(binary), os.add_dll_directory(libraries)]
    os.environ["PATH"] = binary + ";" + libraries + ";" + os.environ["PATH"]
    for name in list(os.environ):
        if name.startswith(("PERL", "PAR_")):
            del os.environ[name]
    os.environ["PERL5LIB"] = str(ROOT / "package" / "lib")
    perl = ctypes.CDLL(str(ROOT / "bin" / "perl532.dll"))
    perl.RunPerl.argtypes = [
        ctypes.c_int, ctypes.POINTER(ctypes.c_char_p), ctypes.POINTER(ctypes.c_char_p)
    ]
    perl.RunPerl.restype = ctypes.c_int
    # Both directories are the verified physical cwd. Keeping the option value
    # ASCII avoids Biber 2.21 double-encoding a non-ASCII absolute option path.
    arguments = [
        str(ROOT / "bin" / "perl.exe"),
        "-I" + str(ROOT / "package" / "lib"),
        str(ROOT / "package" / "script" / "biber-MSWIN64"),
        "--noconf",
        "--input-directory=.",
        "--output-directory=.",
        job,
    ]
    # Original Biber decodes Windows argv using GetACP, independently of UTF-8
    # console output. Match that ABI; filenames inside .bcf/.bib remain Unicode.
    kernel.GetACP.argtypes = []
    kernel.GetACP.restype = W.UINT
    encoding = "cp" + str(kernel.GetACP())
    encoded_arguments = [value.encode(encoding, "strict") for value in arguments]
    encoded_environment = [(key + "=" + value).encode(encoding, "strict") for key, value in os.environ.items()]
    argv = (ctypes.c_char_p * (len(encoded_arguments) + 1))(*encoded_arguments, None)
    envp = (ctypes.c_char_p * (len(encoded_environment) + 1))(*encoded_environment, None)
    result = perl.RunPerl(len(encoded_arguments), argv, envp)
    # Keep AddDllDirectory handles alive throughout Perl and its XS modules.
    for handle in dll_directories:
        handle.close()
    return result


if __name__ == "__main__":
    sys.exit(main())
