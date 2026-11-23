"""Real synthetic filesystem tests; all compiler subprocesses are replaced."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "isolation" / "tex" / "compile_latex.py"
spec = importlib.util.spec_from_file_location("relay_compile_test", SOURCE)
compiler = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = compiler
spec.loader.exec_module(compiler)


class CompileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-tex-test-")
        self.root = Path(self.temporary.name).resolve()
        self.workspace = self.root / "workspace"
        self.scratch = self.root / "scratch"
        self.workspace.mkdir()
        self.scratch.mkdir()
        self.bin = self.root / "runtime"
        self.bin.mkdir()
        for name in ["python.exe", "tex_engine.py", "bibtex_backend.py", "biber_backend.py"]:
            (self.bin / name).write_text("synthetic entry", encoding="utf8")
        self.context = compiler.Context(self.workspace, self.scratch, self.bin / "python.exe",
                                        self.bin / "tex_engine.py", self.bin / "bibtex_backend.py",
                                        self.bin / "biber_backend.py")
        self.calls = []
        self.mode = None
        self.inspect = None

    def tearDown(self):
        self.assertEqual(list(self.scratch.iterdir()), [], "Temporary TeX project leaked")
        self.temporary.cleanup()

    def put(self, name, content="Synthetic source"):
        file = self.workspace / name
        file.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            file.write_bytes(content)
        else:
            file.write_text(content, encoding="utf8")
        return file

    def fake(self, command, *, cwd, timeout, max_output):
        self.calls.append((command, cwd))
        self.assertTrue(cwd.is_relative_to(self.scratch))
        self.assertLessEqual(timeout, compiler.Limits().process_seconds)
        self.assertEqual(command[:6], [str(self.context.python), "-X", "utf8", "-I", "-S", command[5]])
        if self.inspect:
            self.inspect(cwd)
        if Path(command[5]).name == "tex_engine.py":
            request = json.loads(command[6])
            self.assertEqual(set(request), {"engine", "work", "input", "job"})
            self.assertEqual(request["work"], str(cwd))
            self.assertEqual(request["job"], "document")
            if request["engine"] == "xdvipdfmx":
                (cwd / "document.pdf").write_bytes(b"%PDF-1.7\nSYNTHETIC")
            else:
                self.assertEqual(request["input"], "relayinput.tex")
                self.assertTrue((cwd / "relayinput.tex").is_file())
                (cwd / "document.xdv").write_bytes(b"SYNTHETIC_XDV")
                (cwd / "document.log").write_text("Synthetic successful log", encoding="utf8")
                if request["engine"] == "pdflatex":
                    (cwd / "document.pdf").write_bytes(b"%PDF-1.7\nSYNTHETIC")
                if self.mode == "pybtex":
                    (cwd / "document.aux").write_text("\\bibdata{refs}\n\\bibstyle{plain}", encoding="utf8")
                if self.mode == "biber":
                    (cwd / "document.bcf").write_text("<bcf:datasource>参考.bib</bcf:datasource>", encoding="utf8")
        else:
            (cwd / "document.bbl").write_text("Synthetic bibliography", encoding="utf8")
        return subprocess.CompletedProcess(command, 0, b"synthetic output")

    def compile(self, source="main.tex", **options):
        return compiler.compile_project(self.context, source, runner=self.fake, **options)

    def test_default_project_staging_and_original_preservation(self):
        main = self.put("paper/main.tex", "\\input{section.tex}")
        section = self.put("paper/section.tex", "Original section")
        self.put("paper/main.aux", "old generated data")
        self.put("paper/.git/unread.txt", "not staged")
        self.put("paper/node_modules/unread.js", "not staged")
        self.put("unrelated.txt", "not staged")
        snapshot = {p: p.read_bytes() for p in [main, section]}
        def inspect(cwd):
            self.assertEqual((cwd / "section.tex").read_text(), "Original section")
            self.assertFalse((cwd / "main.aux").exists())
            self.assertFalse((cwd / ".git").exists())
            self.assertFalse((cwd / "node_modules").exists())
            self.assertFalse((cwd / "unrelated.txt").exists())
        self.inspect = inspect
        result = self.compile("paper/main.tex", output="new-outputs/final.pdf")
        self.assertTrue(result["ok"])
        self.assertEqual(result["steps"], ["xelatex", "xelatex", "xdvipdfmx"])
        self.assertEqual((self.workspace / "new-outputs/final.pdf").read_bytes()[:5], b"%PDF-")
        self.assertTrue((self.workspace / "new-outputs/final.compile.log").is_file())
        self.assertEqual(snapshot, {p: p.read_bytes() for p in snapshot})

    def test_chinese_nested_main_preserves_parent_resource_references(self):
        self.put("项目/正文/论文.tex", "\\input{章节.tex}\\includegraphics{../图片/图.png}")
        self.put("项目/正文/章节.tex", "中文正文")
        self.put("项目/图片/图.png", b"SYNTHETIC_PNG")
        def inspect(cwd):
            self.assertEqual(cwd.name, "正文")
            self.assertEqual((cwd / "../图片/图.png").read_bytes(), b"SYNTHETIC_PNG")
            self.assertEqual((cwd / "章节.tex").read_text(encoding="utf8"), "中文正文")
        self.inspect = inspect
        result = self.compile("项目/正文/论文.tex", project_root="项目", output="成果/论文.pdf")
        self.assertTrue(result["ok"])

    def test_bibliography_backend_and_fixed_multiround_schedule(self):
        self.put("main.tex")
        for mode, entry in [("pybtex", "bibtex_backend.py"), ("biber", "biber_backend.py")]:
            with self.subTest(mode=mode):
                self.calls.clear()
                self.mode = mode
                result = self.compile()
                self.assertEqual(result["bibliography"], mode)
                self.assertEqual(result["steps"], ["xelatex", mode, "xelatex", "xelatex", "xdvipdfmx"])
                backend = next(command for command, cwd in self.calls if Path(command[5]).name == entry)
                if mode == "pybtex":
                    self.assertEqual(backend[6:], ["document.aux"])
                else:
                    self.assertEqual(backend[6:], ["document"])

    def test_pdflatex_and_explicit_bibliography_none(self):
        self.put("main.tex")
        self.mode = "biber"
        result = self.compile(engine="pdflatex", bibliography="none", passes=3)
        self.assertEqual(result["steps"], ["pdflatex"] * 3)
        self.assertIsNone(result["bibliography"])

    def test_path_escape_bad_project_and_output_rejected_before_execution(self):
        self.put("main.tex")
        (self.workspace / "other").mkdir()
        for options in [{"source": "../outside.tex"}, {"source": "C:\\outside.tex"},
                        {"source": "\\\\server\\share\\x.tex"}, {"output": "../outside.pdf"},
                        {"project_root": "other"}, {"output": "bad.tex"}, {"passes": 9}]:
            with self.subTest(options=options), self.assertRaises((compiler.CompileError, FileNotFoundError)):
                self.compile(**options)
        self.assertEqual(self.calls, [])

    def test_links_in_project_and_output_are_rejected(self):
        self.put("main.tex")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("SYNTHETIC_OTHER_WORKSPACE")
        link = self.workspace / "linked"
        if os.name == "nt":
            result = subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True, creationflags=0x08000000)
            self.assertEqual(result.returncode, 0)
        else:
            link.symlink_to(outside, target_is_directory=True)
        try:
            with self.assertRaises(compiler.CompileError):
                self.compile()
            with self.assertRaises(compiler.CompileError):
                self.compile(output="linked/out.pdf")
        finally:
            if os.name == "nt":
                link.rmdir()
            else:
                link.unlink()
        self.assertEqual((outside / "secret.txt").read_text(), "SYNTHETIC_OTHER_WORKSPACE")
        self.assertFalse((outside / "out.pdf").exists())

    def test_byte_count_file_count_and_depth_overflow_cleanup(self):
        self.put("main.tex", "x" * 40)
        self.put("nested/a.txt", "y" * 40)
        for limits in [compiler.Limits(bytes=50), compiler.Limits(file_bytes=20),
                       compiler.Limits(files=1), compiler.Limits(depth=0)]:
            with self.subTest(limits=limits), self.assertRaises(compiler.CompileError):
                self.compile(limits=limits)
            self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertEqual(self.calls, [])

    def test_failed_backend_keeps_previous_pdf_and_cleans_stage(self):
        self.put("main.tex")
        previous = self.put("main.pdf", b"%PDF-1.7\nOLD")
        def fail(command, **kwargs):
            self.fake(command, **kwargs)
            return subprocess.CompletedProcess(command, 17, b"SYNTHETIC_FAILURE")
        with self.assertRaisesRegex(compiler.CompileError, "exit code 17"):
            compiler.compile_project(self.context, "main.tex", runner=fail)
        self.assertEqual(previous.read_bytes(), b"%PDF-1.7\nOLD")
        self.assertIn("SYNTHETIC_FAILURE", (self.workspace / "main.compile.log").read_text())

    def test_timeout_and_output_overflow_cleanup(self):
        self.put("main.tex")
        def timeout(*args, **kwargs):
            raise compiler.CompileError("Synthetic timeout")
        with self.assertRaisesRegex(compiler.CompileError, "timeout"):
            compiler.compile_project(self.context, "main.tex", runner=timeout)
        with self.assertRaisesRegex(compiler.CompileError, "transcript"):
            self.compile(limits=compiler.Limits(transcript_bytes=10))

    def test_reserved_name_and_invalid_pdf_are_rejected(self):
        self.put("main.tex")
        reserved = self.put("relayinput.tex", "user-owned dependency")
        with self.assertRaisesRegex(compiler.CompileError, "reserved"):
            self.compile()
        reserved.unlink()
        def bad_pdf(command, **kwargs):
            result = self.fake(command, **kwargs)
            if json.loads(command[6])["engine"] == "xdvipdfmx":
                (kwargs["cwd"] / "document.pdf").write_bytes(b"NOT_A_PDF")
            return result
        with self.assertRaisesRegex(compiler.CompileError, "did not produce a PDF"):
            compiler.compile_project(self.context, "main.tex", runner=bad_pdf)

    def test_real_process_timeout_is_bounded_without_running_tex(self):
        with self.assertRaisesRegex(compiler.CompileError, "time limit"):
            compiler._run_process([sys.executable, "-I", "-S", "-c", "import time;time.sleep(10)"],
                                  cwd=self.scratch, timeout=0.1, max_output=1024)

    def test_real_process_output_is_bounded_without_running_tex(self):
        with self.assertRaisesRegex(compiler.CompileError, "output limit"):
            compiler._run_process([sys.executable, "-I", "-S", "-c", "import sys;sys.stdout.write('x'*1000000)"],
                                  cwd=self.scratch, timeout=5, max_output=1024)

    def make_stage(self, number, lease=None):
        stage = self.scratch / ("tex-" + format(number, "020x"))
        stage.mkdir()
        (stage / "synthetic.txt").write_text("temporary data")
        if lease is not None:
            (stage / compiler.LEASE).write_text(json.dumps(lease))
        return stage

    def test_leases_reap_dead_and_reused_pids_but_preserve_active_or_uncertain(self):
        stages = [self.make_stage(number, {"pid": number, "created": "123"}) for number in range(1, 5)]
        state = {1: ("absent", None), 2: ("alive", 456), 3: ("alive", 123), 4: ("unknown", None)}
        with mock.patch.object(compiler, "_process_identity", side_effect=lambda pid: state[pid]):
            self.assertEqual(compiler._reap_stages(self.scratch), 2)
        self.assertEqual([stage.exists() for stage in stages], [False, False, True, True])
        for stage in stages[2:]:
            self.assertTrue(compiler._safe_remove_stage(stage, self.scratch))

    def test_invalid_lease_is_preserved_until_24_hours(self):
        fresh = self.make_stage(10)
        malformed = self.make_stage(11, {"pid": "invalid"})
        self.assertEqual(compiler._reap_stages(self.scratch), 0)
        future = max(fresh.stat().st_ctime, malformed.stat().st_ctime) + compiler.STALE_SECONDS + 10
        with mock.patch.object(compiler.time, "time", return_value=future):
            self.assertEqual(compiler._reap_stages(self.scratch), 2)

    def test_stage_removal_refuses_reparse_tree_and_preserves_target(self):
        stage = self.make_stage(20, {"pid": 1, "created": "123"})
        target = self.root / "preserved"
        target.mkdir()
        sentinel = target / "sentinel.txt"
        sentinel.write_text("DO_NOT_DELETE")
        link = stage / "redirected"
        if os.name == "nt":
            result = subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, creationflags=0x08000000)
            self.assertEqual(result.returncode, 0)
        else:
            link.symlink_to(target, target_is_directory=True)
        try:
            self.assertFalse(compiler._safe_remove_stage(stage, self.scratch))
            self.assertTrue((stage / "synthetic.txt").exists())
            self.assertEqual(sentinel.read_text(), "DO_NOT_DELETE")
        finally:
            link.rmdir() if os.name == "nt" else link.unlink()
        self.assertTrue(compiler._safe_remove_stage(stage, self.scratch))


if __name__ == "__main__":
    unittest.main(verbosity=2)
