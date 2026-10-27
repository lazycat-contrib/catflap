import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare_lpk", Path(__file__).with_name("prepare-lpk.py"))
prepare_lpk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_lpk)


class PackageBoundaryTest(unittest.TestCase):
    profile = json.loads((Path(__file__).parent.parent / ".github/lpk-profile.json").read_text())
    version = "0.2.10"

    def package(self, root, extra=None, link=False, metadata=None, binary=None, missing=None):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as content:
            files = {"catflapd": binary or b"\x7fELF\x02\x01" + b"\0" * 12 + b"\x3e\x00", "THIRD_PARTY_NOTICES.md": b"licenses", "build-info.txt": b"build_target=x86_64-unknown-linux-musl\n"}
            if extra:
                files[extra] = b"private data"
            if missing:
                del files[missing]
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.mode = 0o755 if name == "catflapd" else 0o644
                info.size = len(data)
                if link and name == "build-info.txt":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/etc/passwd"
                    info.size = 0
                content.addfile(info, io.BytesIO(data))
        destination = Path(root) / "community.lazycat.app.catflap-v0.2.10.lpk"
        with tarfile.open(destination, mode="w") as package:
            files = {"package.yml": metadata or b"package: community.lazycat.app.catflap\nversion: 0.2.10\n", "manifest.yml": b"application: {}\n", "icon.png": b"icon", "content.tar": stream.getvalue()}
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                package.addfile(info, io.BytesIO(data))
        return destination

    def test_runtime_only_package(self):
        with tempfile.TemporaryDirectory() as root:
            prepare_lpk.verify_contents(self.package(root), self.profile, self.version)

    def test_rejects_source_git_and_secret_files(self):
        for extra in ["main.rs", ".git/config", ".env", "build.sh", "README.md", "../outside"]:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(ValueError):
                    prepare_lpk.verify_contents(self.package(root, extra=extra), self.profile, self.version)

    def test_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                prepare_lpk.verify_contents(self.package(root, link=True), self.profile, self.version)

    def test_rejects_missing_runtime(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                prepare_lpk.verify_contents(self.package(root, missing="THIRD_PARTY_NOTICES.md"), self.profile, self.version)

    def test_rejects_wrong_architecture(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                prepare_lpk.verify_contents(self.package(root, binary=b"\x7fELF\x02\x01" + b"\0" * 12 + b"\xb7\x00"), self.profile, self.version)

    def test_rejects_wrong_or_ambiguous_package_identity(self):
        for metadata in [b"package: other.app\nversion: 0.2.10\n", b"package: community.lazycat.app.catflap\nversion: 0.2.9\n", b"package: community.lazycat.app.catflap\nversion: 0.2.10\nversion: 0.2.9\n"]:
            with self.subTest(metadata=metadata), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(ValueError):
                    prepare_lpk.verify_contents(self.package(root, metadata=metadata), self.profile, self.version)

    def test_preparation_preserves_source_bytes_and_rejects_checksum_mismatch(self):
        with tempfile.TemporaryDirectory() as root, contextlib.chdir(root):
            Path(".github").mkdir()
            Path(".github/lpk-profile.json").write_text(json.dumps(self.profile))
            Path("dist/import").mkdir(parents=True)
            source = self.package("dist/import")
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            checksum = source.with_name("checksums.txt")
            checksum.write_text(f"{digest}  {source.name}\n")
            with patch.dict(os.environ, {"LPK_VERSION": self.version, "GITHUB_OUTPUT": "outputs"}):
                prepare_lpk.prepare()
                self.assertEqual(source.read_bytes(), (Path("dist/release") / source.name).read_bytes())
                checksum.write_text(f"{'0' * 64}  {source.name}\n")
                with self.assertRaisesRegex(ValueError, "source build checksum"):
                    prepare_lpk.prepare()


if __name__ == "__main__":
    unittest.main()
