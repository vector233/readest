"""Sign a personal Android APK with a local shelf or prepare a public update."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


def read_shelf(path, parser):
    manifest = path.read_bytes()
    shelf = json.loads(manifest)
    if shelf.get("version") != 1 or not isinstance(shelf.get("books"), list):
        parser.error("Expected a version 1 shelf with a books array")
    ids = set()
    for book in shelf["books"]:
        if not isinstance(book, dict) or not all(isinstance(book.get(k), str) for k in ("id", "title", "author")):
            parser.error("Each shelf entry needs a string id, title and author")
        if not book["title"].strip() or not book["id"] or book["id"] in ids:
            parser.error("Shelf entries need a title and a unique id")
        ids.add(book["id"])
    return manifest, len(ids)


def update_asset_name(apk, build_tools):
    badging = subprocess.check_output([build_tools / "aapt", "dump", "badging", apk], text=True)
    match = re.search(
        r"^package: name='com\.bilingify\.readest\.personal' versionCode='([1-9]\d{0,9})'"
        r" versionName='(\d+\.\d+\.\d+-personal\.\d+)'",
        badging,
        re.MULTILINE,
    )
    if not match or "native-code: 'arm64-v8a'" not in badging:
        raise ValueError("Expected a personal arm64 Android APK")
    code, version = match.groups()
    return f"Readest-{code}-{version}-arm64.apk"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("shelf", type=Path, nargs="?")
    parser.add_argument("output", type=Path, help="APK path, or output directory for --public-update")
    parser.add_argument("--build-tools", type=Path, required=True)
    parser.add_argument("--keystore", type=Path, required=True)
    parser.add_argument("--password-file", type=Path, required=True)
    parser.add_argument("--public-update", action="store_true", help="Sign a generic APK without a private shelf")
    args = parser.parse_args()
    if args.public_update == (args.shelf is not None):
        parser.error("Provide a shelf for a local install, or --public-update with an output directory")
    output = args.output
    if args.public_update:
        output /= update_asset_name(args.apk, args.build_tools)
    if args.apk.resolve() == output.resolve():
        parser.error("Use a separate output path for the personal APK")
    manifest, count = read_shelf(args.shelf, parser) if args.shelf else (None, 0)
    os.umask(0o077)
    output.parent.mkdir(parents=True, exist_ok=True)
    asset = "assets/personal-shelf.json"
    with tempfile.TemporaryDirectory(dir=output.parent) as scratch:
        temp = Path(scratch)
        unsigned = temp / "unsigned.apk"
        aligned = temp / "aligned.apk"
        signed = temp / "signed.apk"
        with zipfile.ZipFile(args.apk) as source, zipfile.ZipFile(unsigned, "w") as target:
            if args.public_update and asset in source.namelist():
                parser.error("Public updates require a generic build without a bundled shelf")
            for info in source.infolist():
                if info.filename == asset:
                    continue
                with source.open(info) as reader, target.open(info, "w") as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
            if manifest is not None:
                target.writestr(asset, manifest, compress_type=zipfile.ZIP_DEFLATED)
        aligner = args.build_tools / "zipalign"
        signer = args.build_tools / "apksigner"
        subprocess.run([aligner, "-P", "16", "-f", "4", unsigned, aligned], check=True)
        subprocess.run([signer, "sign", "--ks", args.keystore, "--ks-pass", "file:" + str(args.password_file),
                        "--v4-signing-enabled", "false", "--out", signed, aligned], check=True)
        subprocess.run([signer, "verify", signed], check=True)
        subprocess.run([aligner, "-c", "-P", "16", "4", signed], check=True)
        with zipfile.ZipFile(signed) as final:
            embedded = final.read(asset) if asset in final.namelist() else None
            if embedded != manifest or final.testzip() is not None:
                raise RuntimeError("Personal APK did not pass archive verification")
        signed.replace(output)
    with output.open("rb") as apk_file:
        digest = hashlib.file_digest(apk_file, "sha256").hexdigest()
    print(f"{output.name} ({count} bundled books)")
    print(f"SHA-256 {digest}")


if __name__ == "__main__":
    main()
