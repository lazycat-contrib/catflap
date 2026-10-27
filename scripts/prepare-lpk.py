import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile

MAX_BYTES = 512 * 1024 * 1024
STABLE_VERSION = r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"


def verify_contents(filename, profile, version):
    required = {"package.yml", "manifest.yml", "icon.png", "content.tar"}
    allowed = required | {"deploy_params.yml", "compose.override.yml"} | set(profile["exports"])
    content_files = set(profile["contentFiles"])

    def directory_allowed(name, files):
        return any(name in [str(parent) for parent in PurePosixPath(item).parents] for item in files)

    with tarfile.open(filename) as package:
        seen = set()
        total = 0
        for member in package:
            name = str(PurePosixPath(member.name))
            if member.isdir() and directory_allowed(name, allowed):
                continue
            if not member.isfile() or name not in allowed or name in seen or not 0 < member.size <= MAX_BYTES:
                raise ValueError("Unexpected package entry; only declared runtime resources may be published")
            seen.add(name)
            total += member.size
            if total > MAX_BYTES:
                raise ValueError("LPK exceeds the uncompressed size limit")
        if not required <= seen:
            raise ValueError("LPK package metadata is incomplete")
        metadata_member = package.getmember("package.yml")
        if metadata_member.size > 65536:
            raise ValueError("Package metadata is too large")
        with package.extractfile(metadata_member) as metadata_file:
            metadata = metadata_file.read().decode("utf-8")
        for key, expected in {"package": profile["packageId"], "version": version}.items():
            values = re.findall(rf"^{key}:[ \t]*([^\n#]+)", metadata, re.MULTILINE)
            if len(values) != 1 or values[0].strip().strip("\"'") != expected:
                raise ValueError("Package identity or version differs from the selected artifact")
        seen_content = set()
        total = 0
        with package.extractfile("content.tar") as stream, tarfile.open(fileobj=stream, mode="r|*") as content:
            for member in content:
                name = str(PurePosixPath(member.name))
                if member.isdir() and directory_allowed(name, content_files):
                    continue
                if not member.isfile() or name not in content_files or name in seen_content or member.size <= 0:
                    raise ValueError("LPK runtime contains an unexpected file or link")
                seen_content.add(name)
                total += member.size
                if total > MAX_BYTES:
                    raise ValueError("LPK runtime exceeds the uncompressed size limit")
                if name == profile["binary"]:
                    with content.extractfile(member) as binary:
                        header = binary.read(20)
                    if not (header[:6] == b"\x7fELF\x02\x01" and header[18:20] == b"\x3e\x00" and member.mode & 0o111):
                        raise ValueError("Expected an executable Linux amd64 binary")
        if seen_content != content_files:
            raise ValueError("LPK runtime files are incomplete")


def prepare():
    profile = json.loads(Path(".github/lpk-profile.json").read_text())
    version = os.environ["LPK_VERSION"]
    if not re.fullmatch(STABLE_VERSION, version):
        raise ValueError("Invalid stable artifact version")
    name = f"{profile['packageId']}-v{version}.lpk"
    candidates = list(Path("dist/import").iterdir())
    if {candidate.name for candidate in candidates} != {name, "checksums.txt"}:
        raise ValueError("Expected only the generated LPK and its checksum")
    for candidate in candidates:
        if candidate.is_symlink() or not candidate.is_file() or not 0 < candidate.stat().st_size <= MAX_BYTES:
            raise ValueError("Expected bounded regular artifact files")
    source = Path("dist/import") / name
    checksum_file = source.with_name("checksums.txt")
    if checksum_file.stat().st_size > 1024:
        raise ValueError("Checksum metadata is too large")
    with source.open("rb") as package_file:
        digest = hashlib.file_digest(package_file, "sha256").hexdigest()
    if checksum_file.read_text() != f"{digest}  {name}\n":
        raise ValueError("LPK differs from its source build checksum")
    verify_contents(source, profile, version)
    destination = Path("dist/release") / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.with_name("checksums.txt").write_text(f"{digest}  {name}\n")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"lpk-path={destination}\nsha256={digest}\n")
    print(f"Verified {profile['packageId']} {version}; SHA256 {digest}")


if __name__ == "__main__":
    prepare()
