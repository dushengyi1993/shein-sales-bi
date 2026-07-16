# SHEIN BI Ops repository instructions

When a request is an actual SHEIN listing, image, title, inventory, price, link, or marketing operation, use the repository's controlled BI/Ops tooling rather than inventing an alternative workflow.

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
