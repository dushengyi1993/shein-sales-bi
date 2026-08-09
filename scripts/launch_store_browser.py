#!/usr/bin/env python3
"""Launch Windows Chrome for one SHEIN store using a workspace-local profile."""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
ORDER_URL = "https://sso.geiwohuo.com/#/gsp/order-management/list"
STORES = json.loads((ROOT / "config" / "stores.json").read_text(encoding="utf-8-sig"))["stores"]


def get_store(key: str):
    key = key.upper()
    for store in STORES:
        if store["storeKey"].upper() == key:
            return store
    raise SystemExit(f"Unknown store key: {key}")

def ensure_profile_name(profile_dir: Path, store: dict):
    profile_name = store.get("profileName") or f"{store['storeKey']} - {store['shopName']}"
    chrome_profile_dir = profile_dir / "Profile 1"
    chrome_profile_dir.mkdir(parents=True, exist_ok=True)

    def load_json(path: Path):
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8-sig"))
        return {}

    def save_json(path: Path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    prefs_path = chrome_profile_dir / "Preferences"
    prefs = load_json(prefs_path)
    prefs.setdefault("profile", {})["name"] = profile_name
    prefs["profile"]["is_using_default_name"] = False
    save_json(prefs_path, prefs)

    local_state_path = profile_dir / "Local State"
    local_state = load_json(local_state_path)
    entry = local_state.setdefault("profile", {}).setdefault("info_cache", {}).setdefault("Profile 1", {})
    entry["name"] = profile_name
    entry["is_using_default_name"] = False
    entry.setdefault("avatar_icon", "chrome://theme/IDR_PROFILE_AVATAR_26")
    local_state.setdefault("optimization_guide", {})[
        "on_device_foundational_model_user_settings"
    ] = False
    save_json(local_state_path, local_state)
    (profile_dir / "PROFILE_NAME.txt").write_text(profile_name + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("store", help="store key, e.g. DL")
    parser.add_argument("--url", default=ORDER_URL)
    args = parser.parse_args()
    store = get_store(args.store)
    if not CHROME.exists():
        raise SystemExit(f"Chrome not found: {CHROME}")

    profile_dir = ROOT / "profiles" / f"persistent-{store['profileKey']}-profile"
    cache_dir = profile_dir / "cache"
    log_dir = ROOT / "logs"
    profile_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    ensure_profile_name(profile_dir, store)

    cmd = [
        str(CHROME),
        f"--user-data-dir={profile_dir}",
        f"--disk-cache-dir={cache_dir}",
        f"--remote-debugging-port={store['port']}",
        "--profile-directory=Profile 1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=OptimizationGuideOnDeviceModel,OptimizationGuideModelDownloading,OptimizationGuideModelExecution,PromptAPIForGeminiNano,SummarizationAPIForGeminiNano,WriterAPIForGeminiNano,RewriterAPIForGeminiNano",
        args.url,
    ]
    subprocess.Popen(cmd, cwd=ROOT)
    print(json.dumps({
        "storeKey": store["storeKey"],
        "shopName": store["shopName"],
        "port": store["port"],
        "profileDir": str(profile_dir),
        "url": args.url,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
