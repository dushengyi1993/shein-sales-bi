# Local emergency release receipt

This is a temporary source-baseline bridge for the period when the formal GitHub v3 release audit cannot complete. It is not a GitHub release, CI attestation, or replacement for the v3 marker. The watchdog therefore keeps `releaseAuditReady=false` while reporting a valid receipt separately.

Before any production-sensitive write, check in this order:

1. Formal v3 marker, attestation, annotated tag, and exact CI provenance.
2. A valid `/srv/shein-bi/runtime/emergency_local_release.json` receipt (or the configured `SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE`).
3. If neither establishes the exact production baseline, stop before writes. Business commands that do not require a code release may proceed only when business health is green.

Create a receipt from the exact local bundle; the CLI reads and hashes the bundle itself:

```text
node scripts/manage_emergency_local_release_receipt.mjs create --bundle <bundle> --commit <40-hex> --baseline-commit <40-hex> --reason "<non-secret reason>"
```

Verify the receipt, bundle (when supplied), and current checkout HEAD/clean tracked source:

```text
node scripts/manage_emergency_local_release_receipt.mjs verify --receipt-file /srv/shein-bi/runtime/emergency_local_release.json --bundle <bundle> --cwd /opt/shein-bi/app
```

The schema-v1 receipt binds the exact commit, baseline commit, bundle SHA-256, `createdAt`, a bounded non-secret reason, and a canonical receipt hash. It is stored outside tracked source. While it is active, do not create worktrees from `origin/main`; retain the exact local commit and bundle until a formal v3 release replaces this bridge. A dirty/hidden/missing tracked-source state or HEAD mismatch remains a watchdog issue even when the receipt is valid.
