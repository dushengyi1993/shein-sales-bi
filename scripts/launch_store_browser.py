#!/usr/bin/env python3
"""Compatibility entry: use the managed Node launcher and its Profile guard."""
import argparse
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("store")
    parser.add_argument("--url", default="https://sso.geiwohuo.com/#/gsp/order-management/list")
    args = parser.parse_args()
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required by the managed SHEIN browser launcher")
    result = subprocess.run([node, str(ROOT / "scripts" / "launch_store_browser.mjs"),
                             args.store, "--visible", "--url", args.url], cwd=ROOT)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
