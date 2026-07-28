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
