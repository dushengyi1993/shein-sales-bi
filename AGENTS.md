# SHEIN BI Ops repository instructions

When a request is an actual SHEIN listing, image, title, inventory, price, link, or marketing operation, use the repository's controlled BI/Ops tooling rather than inventing an alternative workflow.

## Direct investigation rule

When the user asks the current Codex agent to investigate, verify, calculate, repair, or execute work:

- Inspect the authoritative source directly: cloud PostgreSQL, SHEIN OpenAPI, Webhook receipts, systemd/services, logs, and repository code as applicable.
- **Do not call BI `ask`, BI chat, the Feishu Q&A bot, or another LLM as an intermediary.** The current agent is responsible for doing the work, not asking another AI to answer it.
- `ask`/chat may be used only when the user explicitly asks to test or diagnose that product surface, routing, permissions, or partner experience. Its response is test output, never authoritative business evidence.
- A failed direct query must be reported as a direct-access failure. Do not hide it by falling back to `ask`, browser scraping, or another model.
- Controlled CLI commands remain valid for preflight and authorized operations, but all factual conclusions and post-write readback must come from the underlying authoritative source.

This applies equally to every partner/operator using the managed CLI:

- For **any read-only business request**, call `shein-bi-ops query --text "<original request>" --out <json-file>`, then inspect and calculate from the returned structured `data` in the current Codex task.
- `query` selects and loads deterministic cloud BI sections under the logged-in account's read scope and returns `aiInvoked=false`; it does not call the BI Q&A bot, Feishu bot, Codex gateway, or another LLM.
- The legacy CLI command `ask` is only a compatibility alias for `query` and no longer calls `/api/ops-agent/ask`. New instructions must use `query`.
- Do not use `chat` for a read-only question. `chat` is reserved for controlled operations or an explicit test of the web conversation product.
- If automatic section selection is insufficient, rerun `query` with explicit `--sections`; do not fall back to a question bot or browser scraping.
- A `query --out <file>` run atomically replaces `<file>` and writes `<file>.manifest.json`. Inspect the compact manifest first; read the full data artifact only after its outcome, section coverage, provenance, and hash verify. The CLI performs one bounded readiness wait for incomplete sections. If it still reports `incomplete`, report the exact section issues instead of looping the same query or treating unavailable data as zero.
- For cloud runtime acceptance, run `capture_ops_runtime_snapshot.mjs` once before issuing individual `systemctl`, health, or source probes. Expand to targeted probes only for blockers named by that snapshot. This snapshot is read-only and never substitutes for business OpenAPI evidence.

For partner/operator image work:

- The current user's explicit instruction and a clearly named reviewed source such as `已审可用` are authoritative business approvals.
- A title or selling-point document omitting a claim does **not** prohibit an already reviewed image containing that claim. AI may surface a warning, but must not silently remove reviewed material or ask the user to re-approve it.
- Only objective failures may block an approved image: unreadable/corrupt file, unsupported platform format or size, demonstrably wrong product, duplicate role that violates the platform payload, or a real SHEIN validation error.
- Verify dimensions from the file before claiming that a square image is missing.
- Upload and bind images to the same task. Do not create a replacement task after upload, and do not report success when the task payload still comes from a source-link snapshot.
- Preserve explicit store, category, title source, supplier code, price, and inventory values as structured task facts. Do not replace them with a shorter free-text task.

For every new SHEIN listing, use the default store title group from `config/store_style_profiles.json` unless the user explicitly overrides it for the current batch:

- Title 1: JSH, DL, TZZ, CX, HL, TS, TZ.
- Title 2: DX, LQ, XC, MZ, NM, YJ.
- Title 3: JY, QY, XL, FY, QH, ZL.

Preserve the selected title group as a structured per-store task fact and verify it before dry-run.

Real SHEIN writes still require cloud permissions, dry-run/preflight, an exact payload hash, explicit user confirmation, audit, and readback.

## Operation risk tiers

- A read-only business query does not create a payload hash, worktree, release, or repository test run. Use the deterministic query/read source and report unavailable data as unavailable.
- A routine authorized business write uses exactly the business safety boundary: one fresh preflight, one exact payload hash, the existing authorization, narrow serial execution, and terminal live readback. It does not run `npm test`, create a Git release, or test unrelated product attributes merely because the business action is important.
- If a routine task discovers a code defect, stop that business item at the write boundary and hand the defect to the V4 integration task. The business task must not silently become a second development/release lane.
- A local code patch runs syntax/diff checks plus only the registered focused tests for the changed behavior. The full local suite is reserved for genuine cross-module integration or a formal release gate; GitHub CI is not a prerequisite for an already authorized business operation that changes no code.
- `docs/operation-risk-tiers.md` is the human-readable runbook for these tiers. Task prompts and automation instructions must not broaden them.

## Release and production source discipline

- Treat GitHub `main` plus the published release tag as the formal source baseline when the v3 release audit is valid, and treat `/opt/shein-bi/app` as a deployed checkout, not a second development workspace.
- Before any production-sensitive write, check the formal v3 marker, attestation, annotated tag, and exact CI provenance first. If formal release evidence is invalid, check the valid local emergency receipt at `/srv/shein-bi/runtime/emergency_local_release.json` (or the explicitly configured path) next. If neither establishes the exact production baseline, stop before writes. A valid emergency receipt is temporary, does not make `releaseAuditReady` true, and must bind the exact commit, baseline commit, bundle SHA-256, creation time, non-secret reason, and canonical receipt hash.
- While a local emergency receipt is active, never create a task worktree from `origin/main`; use the selected local exact commit and independently verified bundle. Do not treat a local receipt as a v3 GitHub release or CI attestation.
- Invalid formal marker/attestation/CI provenance is a release-audit advisory, not a business/infrastructure issue or recovery trigger. Dirty tracked files, hidden index entries, missing tracked files, source inspection errors, and production HEAD drift from the selected exact commit remain actionable and fail closed. Business commands that require no code release may proceed only when business health is green.
- Do not leave tracked source edits on the cloud host. Under the normal release path, emergency production fixes must be backed up, reproduced locally, committed, pushed, formally released, and redeployed in the same incident; the temporary local-emergency path must preserve its exact bundle and receipt until formal release is restored.
- Runtime-generated Portal files, caches, profiles, logs, sessions, backups, and mutable marketing registries stay outside tracked source. Do not add them merely to make a release look complete.
- A release is complete only after the target commit passes CI, the cloud checkout is exactly at that commit with no tracked source changes, required migrations/units are applied, and production health/readback succeeds.
- Cloud acceptance must run `node scripts/check_release_source_state.mjs --expected-commit <release tag> --record-deployment <release tag>`; watchdog continuously checks that marker. Plain `git status` is insufficient because `skip-worktree` or `assume-unchanged` can hide missing source.
- Temporary GitHub-ahead-of-cloud time during validation is acceptable; unexplained or long-lived source drift is not. Do not claim production parity from a tag alone.

## Local branch, worktree, and runtime hygiene

- Keep the primary checkout on a clean, current `main`. Create at most one task-specific `codex/*` worktree per active task; a merged/released/deployed task is not active.
- After the release and production readback complete, remove the clean task worktree with `git worktree remove`, delete its local branch, and prune remote refs. Never leave completed worktrees as historical backups; GitHub history and verified `.bundle` archives are the backup.
- Never delete a worktree folder directly in Explorer or with a blind recursive delete. Worktrees may contain `profiles` or `node_modules` junctions; detach only verified junctions and use Git's worktree command.
- GitHub is configured to delete merged head branches automatically. Do not disable that setting. This private repository currently lacks paid branch protection, so install `.githooks/pre-push` with `scripts/install_local_repo_hygiene.ps1`; direct pushes/deletions of `main` stay blocked locally and normal changes go through PR + CI.
- Task-local browser/runtime copies belong only under allowlisted `tmp/cloud-marketing-workers-*` or `tmp/cloud-marketing-local-runtime-*` paths. Copy terminal evidence into `outputs/`, then let the weekly hygiene task remove stale runtime directories; never duplicate persistent login profiles.
- All SHEIN Chrome launchers must set `optimization_guide.on_device_foundational_model_user_settings=false` and retain the model-download feature gates. Do not bypass the controlled launchers or re-enable Chrome's local foundational model; it is unused by operations and consumes multiple GB per user-data directory.
