"""BibTeX-compatible bibliography processing inside the verified task worker."""
import os
import pathlib
import re
import sys

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from environment_guard import verify_environment

RUNTIME = pathlib.Path(r"C:\ClaudeRelayRuntime")


def main():
    verify_environment()
    if len(sys.argv) != 2 or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}\.aux", sys.argv[1]):
        raise RuntimeError("Expected one staged bibliography job name")
    scratch = pathlib.Path(os.environ["TEMP"]).parent
    if not re.fullmatch(r"C:\\Users\\user\\ClaudeRelayIsolation\\s\\[0-9a-f]{20}", str(scratch), re.I):
        raise RuntimeError("Expected the account's physical temporary directory")
    if scratch.resolve() != scratch:
        raise RuntimeError("Temporary directory cannot be redirected")
    work = pathlib.Path.cwd()
    if work.resolve() != work:
        raise RuntimeError("Bibliography directory cannot be redirected")
    relative = work.relative_to(scratch)
    if not relative.parts or not re.fullmatch(r"tex-[0-9a-f]{10,32}", relative.parts[0]):
        raise RuntimeError("Bibliography must run in the staged TeX project")

    sys.path.insert(0, str(RUNTIME / "pybtex"))
    import pybtex.io
    from pybtex.__main__ import main as pybtex_main

    styles = None

    def find_style(name):
        nonlocal styles
        if isinstance(name, bytes):
            name = name.decode("utf8")
        if (not isinstance(name, str) or not name.lower().endswith(".bst")
                or len(name) > 180 or any(c in name for c in "/\\:\0")):
            return None
        if styles is None:
            styles = {}
            folder = RUNTIME / "texlive" / "texmf-dist" / "bibtex" / "bst"
            for file in sorted(folder.rglob("*.bst")):
                if not file.is_symlink():
                    styles.setdefault(file.name.casefold(), str(file))
        return styles.get(name.casefold())

    # Existing project .bib/.bst files are opened by Pybtex itself. The fallback
    # resolves only protected installed style names, without native kpsewhich.
    pybtex.io.kpsewhich = find_style
    sys.argv = ["pybtex", "--encoding=UTF-8", "--style-language=bibtex", sys.argv[1]]
    pybtex_main()


if __name__ == "__main__":
    main()
