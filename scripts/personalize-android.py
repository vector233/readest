"""Add a local WeRead shelf to the fork's unsigned APK and sign it on the owner's device."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("shelf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--build-tools", type=Path, required=True)
    parser.add_argument("--keystore", type=Path, required=True)
    parser.add_argument("--password-file", type=Path, required=True)
    args = parser.parse_args()
    if args.apk.resolve() == args.output.resolve():
        parser.error("Use a separate output path for the personal APK")
    manifest = args.shelf.read_bytes()
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
    os.umask(0o077)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    asset = "assets/personal-shelf.json"
    with tempfile.TemporaryDirectory(dir=args.output.parent) as scratch:
        temp = Path(scratch)
        unsigned = temp / "unsigned.apk"
        aligned = temp / "aligned.apk"
        signed = temp / "signed.apk"
        with zipfile.ZipFile(args.apk) as source, zipfile.ZipFile(unsigned, "w") as target:
            for info in source.infolist():
                if info.filename == asset:
                    continue
                with source.open(info) as reader, target.open(info, "w") as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
            target.writestr(asset, manifest, compress_type=zipfile.ZIP_DEFLATED)
        aligner = args.build_tools / "zipalign"
        signer = args.build_tools / "apksigner"
        subprocess.run([aligner, "-P", "16", "-f", "4", unsigned, aligned], check=True)
        subprocess.run([signer, "sign", "--ks", args.keystore, "--ks-pass", "file:" + str(args.password_file),
                        "--v4-signing-enabled", "false", "--out", signed, aligned], check=True)
        subprocess.run([signer, "verify", signed], check=True)
        subprocess.run([aligner, "-c", "-P", "16", "4", signed], check=True)
        with zipfile.ZipFile(signed) as final:
            if final.read(asset) != manifest or final.testzip() is not None:
                raise RuntimeError("Personal APK did not pass archive verification")
        signed.replace(args.output)
    with args.output.open("rb") as apk_file:
        digest = hashlib.file_digest(apk_file, "sha256").hexdigest()
    print(f"{len(ids)} books; SHA-256 {digest}")


if __name__ == "__main__":
    main()
