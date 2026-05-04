#!/usr/bin/env python3
"""Set workspace Chrome profile display names for SHEIN stores."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORES = json.loads((ROOT / "config" / "stores.json").read_text(encoding="utf-8-sig"))["stores"]


def load_json(path: Path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8-sig"))
    return {}


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def set_profile_name(store):
    profile_name = store.get("profileName") or f"{store['storeKey']} - {store['shopName']}"
    user_data_dir = ROOT / "profiles" / f"persistent-{store['profileKey']}-profile"
    profile_dir = user_data_dir / "Profile 1"
    profile_dir.mkdir(parents=True, exist_ok=True)

    # Chrome stores the visible profile label in both Preferences and Local State.
    prefs_path = profile_dir / "Preferences"
    prefs = load_json(prefs_path)
    prefs.setdefault("profile", {})["name"] = profile_name
    prefs["profile"]["is_using_default_name"] = False
    save_json(prefs_path, prefs)

    local_state_path = user_data_dir / "Local State"
    local_state = load_json(local_state_path)
    info_cache = local_state.setdefault("profile", {}).setdefault("info_cache", {})
    entry = info_cache.setdefault("Profile 1", {})
    entry["name"] = profile_name
    entry["is_using_default_name"] = False
    entry.setdefault("avatar_icon", "chrome://theme/IDR_PROFILE_AVATAR_26")
    save_json(local_state_path, local_state)

    marker = user_data_dir / "PROFILE_NAME.txt"
    marker.write_text(profile_name + "\n", encoding="utf-8")
    return {"storeKey": store["storeKey"], "profileName": profile_name, "profileDir": str(user_data_dir)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--store", help="only set one store key")
    args = parser.parse_args()
    selected = STORES
    if args.store:
        selected = [s for s in STORES if s["storeKey"].upper() == args.store.upper()]
        if not selected:
            raise SystemExit(f"Unknown store: {args.store}")
    results = [set_profile_name(s) for s in selected]
    print(json.dumps({"updated": len(results), "profiles": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
