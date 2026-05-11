#!/usr/bin/env python3
"""Local ET login helper.

This helper is intentionally small and local-only:
- `credentials` reads the ET Chrome profile's saved username/password.
- `ocr` recognizes ET's simple 4-character captcha image.

The password is only printed when ET_LOGIN_HELPER_ALLOW_SECRET=1 is set by the
caller. Normal manual runs only reveal username and password length.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from ctypes import wintypes
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCAL_PY_DEPS = ROOT / ".cache" / "python"
if LOCAL_PY_DEPS.exists():
    sys.path.insert(0, str(LOCAL_PY_DEPS))


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


def _json(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, ensure_ascii=False))
    raise SystemExit(code)


def _dpapi_decrypt(data: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("Chrome saved password decrypt currently requires Windows DPAPI")
    buf = ctypes.create_string_buffer(data)
    in_blob = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    out_blob = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(in_blob),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(out_blob),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def _chrome_key(profile_dir: Path) -> bytes:
    local_state = profile_dir / "Local State"
    data = json.loads(local_state.read_text(encoding="utf-8"))
    encrypted_key = base64.b64decode(data["os_crypt"]["encrypted_key"])
    if encrypted_key.startswith(b"DPAPI"):
        encrypted_key = encrypted_key[5:]
    return _dpapi_decrypt(encrypted_key)


def _decrypt_chrome_password(profile_dir: Path, blob: bytes) -> str:
    if blob.startswith((b"v10", b"v11")):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        key = _chrome_key(profile_dir)
        nonce = blob[3:15]
        ciphertext_and_tag = blob[15:]
        return AESGCM(key).decrypt(nonce, ciphertext_and_tag, None).decode("utf-8")
    return _dpapi_decrypt(blob).decode("utf-8")


def credentials(profile_dir: Path, base_url: str) -> None:
    login_db = profile_dir / "Default" / "Login Data"
    if not login_db.exists():
        _json({"ok": False, "error": "login_data_not_found"}, 2)

    tmp = Path(tempfile.mkstemp(prefix="et-login-data-", suffix=".db")[1])
    try:
        shutil.copy2(login_db, tmp)
        con = sqlite3.connect(str(tmp))
        rows = con.execute(
            """
            select origin_url, username_value, password_value
            from logins
            where origin_url like ?
            order by date_created desc
            """,
            (base_url.rstrip("/") + "%",),
        ).fetchall()
        if not rows:
            rows = con.execute(
                """
                select origin_url, username_value, password_value
                from logins
                where origin_url like '%et-global.cn%' or origin_url like '%47.90.12.162%'
                order by date_created desc
                """
            ).fetchall()
        con.close()
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass

    for origin, username, password_blob in rows:
        if not username or not password_blob:
            continue
        password = _decrypt_chrome_password(profile_dir, password_blob)
        allow_secret = os.environ.get("ET_LOGIN_HELPER_ALLOW_SECRET") == "1"
        payload = {
            "ok": True,
            "origin": origin,
            "username": username,
            "passwordLength": len(password),
        }
        if allow_secret:
            payload["password"] = password
        _json(payload)

    _json({"ok": False, "error": "saved_credentials_not_found"}, 3)


def ocr(image_path: Path) -> None:
    try:
        import ddddocr
    except Exception as exc:  # pragma: no cover - operational dependency guard
        _json({"ok": False, "error": f"ddddocr_not_available: {exc}"}, 4)

    recognizer = ddddocr.DdddOcr(show_ad=False)
    text = recognizer.classification(image_path.read_bytes())
    text = re.sub(r"[^0-9A-Za-z]", "", text or "")[:5]
    _json({"ok": bool(text), "text": text})


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_cred = sub.add_parser("credentials")
    p_cred.add_argument("--profile-dir", required=True)
    p_cred.add_argument("--base-url", required=True)

    p_ocr = sub.add_parser("ocr")
    p_ocr.add_argument("--image", required=True)

    args = parser.parse_args()
    try:
        if args.cmd == "credentials":
            credentials(Path(args.profile_dir), args.base_url)
        elif args.cmd == "ocr":
            ocr(Path(args.image))
    except Exception as exc:
        _json({"ok": False, "error": str(exc)}, 1)


if __name__ == "__main__":
    main()
