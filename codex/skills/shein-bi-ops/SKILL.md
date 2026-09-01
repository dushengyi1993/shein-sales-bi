---
name: shein-bi-ops
description: Use for SHEIN store operations through the installed SHEIN BI Ops CLI, including publishing products, copying links, changing images, titles, prices or inventory, preflight, confirmation and audit.
---

# SHEIN BI Ops

Use the managed launcher, not a copied old `scripts/bi_ops_cli.mjs`:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" <command> ...
```

The launcher checks for an authenticated, hash-verified CLI update before business commands and restarts the same command on the new version when needed.

## Direct investigations and read-only facts

When the current Codex agent is asked to investigate, verify, calculate, repair, or execute work, it must query the authoritative source directly:

- cloud PostgreSQL and canonical marts for BI facts;
- SHEIN OpenAPI for fresh platform state;
- Webhook receipts, systemd, logs, and repository code for runtime diagnosis.

**Do not call BI chat, the Feishu Q&A bot, or another LLM as an intermediary.** The current agent is already responsible for answering the user and must not delegate fact-finding to another AI.

For every read-only business request from the owner, a partner, or another operator, use the managed deterministic query command:

```powershell
$result = Join-Path $env:TEMP ("shein-bi-query-" + [guid]::NewGuid().ToString("N") + ".json")
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" query --text '<the user request verbatim>' --out $result
```

Then inspect `$result`, calculate/filter its structured `data` in the **current Codex task**, and answer the user. A valid response reports `mode=direct-bi-data` and `aiInvoked=false`.

- The legacy CLI command `ask` is now only an alias of `query`; it no longer invokes the cloud Q&A model. Use `query` in all new work.
- Do not use `chat` for read-only questions. `chat` is for controlled operational conversations, or for an explicit user-requested diagnosis of the web conversation product.
- When automatic section selection is not enough, rerun with `--sections`. Useful sections include:
  - sales/rankings: `rankings`, and `liveSalesToday` for current-day events;
  - links, traffic, prices and shelf state: `linksData,productState,productTrafficDaily`;
  - profit/cost/storage: `profit`;
  - inventory/depletion/replenishment: `inventoryTrend`;
  - order/unit-price details: `orders,priceScatter`;
  - returns/refunds: `afterSales`; reviews: `comments`; RTV: `rtvData`; logistics: `waybills`.
- Use `--stores` only to narrow the logged-in account's existing read scope; it never expands permissions.
- If the endpoint reports an incomplete or stale required section, report that exact data failure. Do not fall back to a question bot, browser scraping, Chrome remote debugging, or a local V3 export.
- If the CLI reports `BI_LOGIN_REQUIRED` or `BI_SESSION_EXPIRED`, the query has not started. Run the managed launcher's `login --username <BI账号>` command once in an interactive terminal, let the operator enter the password, then retry the original request. A 401 from the release check is a local BI-session problem, not proof that the cloud release endpoint is broken.
- Partner CLI login receives a 365-day session. The CLI writes the cookie atomically and keeps a permission-restricted backup for interrupted-write recovery; neither file contains the plaintext password.
- Link rows expose `c7_cart_uv` / `c30_cart_uv` for add-to-cart visitors. Use these fields for “近7天/近30天加车访客” filters; do not substitute product visitors (`c7_goods_uv`) or load the oversized daily traffic section unless a day-by-day breakdown is actually needed.

- Cloud BI is the source of truth. Do not claim that a local V3/export file is required for an ordinary BI query.
- Never replace a failed direct query with browser scraping, `web-access`, SHEIN login automation, Chrome remote debugging, or a request that the user enable CDP.
- If direct cloud access fails, report the exact access/query error. Do not hide the failure by calling `ask` or inventing a result.
- Use the managed CLI for controlled preflight and authorized business operations; verify final facts and write results directly from the underlying database/OpenAPI/readback.

## Structured write operations

For partner/operator write requests, the current local Codex must understand the request itself and call `operate` with an explicit operation, store, product and structured parameters. Do **not** send the request to `chat`, the cloud Codex intent planner, or a keyword classifier.

Examples:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" operate --operation update_inventory --store DX --product PA4-6L --inventory 30 --text '<the user request verbatim>'
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" operate --operation update_product_price --store DX --product sv123 --product-price 99 --text '<the user request verbatim>'
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" operate --operation retire_link --store DX --product sv123 --text '<the user request verbatim>'
```

Supported structured operations are `copy_product_draft`, `activate_link`, `retire_link`, `update_inventory`, `update_supply_price`, `update_product_price`, `update_title`, `update_images`, and `certificate_review`.

For `copy_product_draft`, pass one exact source pair whenever the SKC is known:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" operate --operation copy_product_draft --source-store DL --source-skc sb260205233136765657878 --target-store HL --product SK-15032 --text '<the user request verbatim>'
```

`--source-skc` is case-sensitive, accepts exactly one value, and requires exactly one `--source-store`. The server persists it as `targets.sourceSkc`; preflight uses only that pair and fails closed when live source detail does not match. `lock-source --task-id <id> --source-store <store> --source-skc <SKC>` may CAS-lock an existing draft only before any image, description, or publish payload has been bound; it invalidates the old preflight and reruns dry-run without publishing.

- `operate` creates the structured task and performs the first preflight. It returns `aiInvoked=false` and never performs the final SHEIN write.
- The server authorizes business writes from the logged-in BI account's `writeStores`. Store scope cannot be expanded by CLI arguments.
- `safeWriteOperations` remains the platform capability switch. Dry-run/preflight, payload lock, explicit user confirmation, Webhook gate, idempotency, audit and post-write readback remain mandatory.
- After the user explicitly confirms the displayed plan, call `execute --task-id <id> --confirm SHEIN_OPENAPI_SUBMIT`.
- If a required structured parameter is missing or ambiguous, ask only for that business value. Do not fall back to cloud chat or invent a value.
- Owner knowledge is a separate permission domain. Partner/operator accounts may consume the active owner rules but may not publish, modify, replace or sync them. Only an account/device with `knowledgePublisher=true` can publish owner rules; store write access, including all-store access, never grants that permission.

## Authority and evidence

Apply this precedence without improvising:

1. The user's current explicit instruction.
2. Material explicitly marked reviewed/approved, including folders named `已审可用`.
3. Approved product documents and the current owner rule bundle.
4. AI interpretation and suggestions.

AI is advisory at level 4. It must not override levels 1-3.

- “Not used in the final title/core selling points” does not mean “prohibited in approved images.”
- For new listings, read `config/store_style_profiles.json` and use its per-store `defaultTitleGroups` value unless the user explicitly overrides the title group for the current batch. Keep the chosen title group as a structured task fact through preflight and dry-run.
- Do not silently exclude approved images because of claims such as speed, noise, motor material or coating. Mention a concise warning only when useful; keep the image unless the user or SHEIN rejects it.
- Only objective corruption, unsupported format/size, demonstrably wrong product, platform role/capacity conflict, or an actual SHEIN validation response may block.
- Read real dimensions before saying a 1:1 image is absent.
- A folder named `备用` remains excluded unless the user explicitly asks to use it.

## Publishing with local images

Never upload images separately and then create a new shortened task. Keep one task and use the managed preparation command:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" prepare-publish --task-id <task-id> --store <target-store> --image-dir '<reviewed-image-folder>' --approved-assets --standard-goods-sn '<exact supplier code>' --supply-price <SAR> --inventory <quantity>
```

Pass `--title-ar` / `--title-en` and `--category-id` when those exact values are known. This command verifies local dimensions, uploads selected files, binds returned URLs and explicit fields to the **same task**, then reruns preflight. It does not perform final publish.

When a `copy_product_draft` task already has a valid server-side approved image
binding and only an explicit publish field must be corrected, reuse those exact
images without scanning or uploading local files again:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" prepare-publish --task-id <task-id> --store <target-store> --reuse-approved-binding --standard-goods-sn '<exact supplier code>' --supply-price <SAR> --inventory <quantity> [--input-current-ma <mA>]
```

`--reuse-approved-binding` is mutually exclusive with `--image-dir` and
`--source-task-id`. The server must find an existing approved binding on the
same task, rebind it with the new structured publish preparation, invalidate the
old preflight, and return a fresh dry-run hash; otherwise the command fails
closed. It never performs the final SHEIN write.

For a copy_product_draft task whose reviewed 审核资料 contains a 三语核心卖点
section (HTML with a unique new `section#s09`, or deterministic legacy
`section#s9`), bind the verbatim ar/en 5-line
descriptions to the **same task** instead of inventing or mapping text:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" prepare-descriptions --task-id <task-id> --store <target-store> --source-file '<reviewed-html-file>' [--section auto|s09|s9] [--material-json <optional-material.json>]
```

The command extracts EN/AR code lines and the Chinese displaybox lines from the
unique `section#s09` or deterministically labeled/directed legacy `section#s9`, computes the source-file SHA256 from the actual bytes,
uploads those actual HTML bytes to the controlled endpoint, and requires the
server to independently recompute the file SHA and re-extract every line
byte-for-byte. It binds fixed ar/en 5-line descriptions (zh-cn stays
audit-only), invalidates the old preflight and reruns preflight. The binding is
the final material mutation: complete reviewed image/publish preparation first.
The command fresh-reads and CAS-locks the task repository revision; a committed
binding whose audit/readback is pending is reported as that exact stage and is
not blindly rebound.
It never rewrites, translates or auto-maps descriptions. A copy_product_draft
final publish payload without bound ar/en 5-line descriptions is a blocker by
default. The only exception is a current, explicit user instruction to leave
the description empty. In that case, do not invent text and do not treat the
absence of an HTML/DOCX file as a blocker; bind the exception to the same task
and approved payload with the controlled preparation flags:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" prepare-publish --task-id <task-id> --store <target-store> --reuse-approved-binding --standard-goods-sn '<exact supplier code>' --supply-price <SAR> --inventory <quantity> --allow-empty-description --empty-description-confirm USER_EXPLICIT_EMPTY_DESCRIPTION
```

The server-side marker is default-off and must lock the exact task, target
store, source store/SKC, supplier code, approved image binding and payload
hash. A later payload, source or binding change invalidates it. Never infer
this exception merely because reviewed description material is missing or the
source link returns an empty description.

For a **historical** published product whose description must be backfilled
from the same reviewed 审核资料 (legacy unique `section#s9` with exactly three
code blocks, or new `section#s09`; `--section auto|s09|s9`), create an
independent maintenance task, never touching the old publish task:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" update-description --source-task-id <historical-publish-task-id> --store <target-store> --spu <SPU> [--skc <SKC>] --source-file '<reviewed-html-file>' [--section auto|s09|s9] [--material-json <optional-material.json>]
```

The command creates a standalone `update_description` task (single store, one
SPU), binds the server-verified material to it (the description body is never
persisted in the task record; only a controlled runtime material pointer plus
hashes), then dry-runs the minimal partialEdit body
(`spu_name` + `multi_language_desc_list` ar/en 5 lines). Real execute requires
the durable server write-claim, live spu-info identity/current-description-hash
gates, `query-document-state` (no audit in progress) and
`check-edit-permission` (editable=true); success requires `code=0` AND
`info.success=true` AND a non-empty `info.version`; readback must match the
spu-info description hashes byte-for-byte, otherwise the task stays
`submitted_readback_pending` / needs manual resolve and must not be retried.

Before asking for final confirmation, verify the returned evidence includes:

- the same task ID;
- `payloadSource=task`;
- bound image count and names;
- square/main image roles;
- exact supplier code, supply price and inventory when supplied;
- a new payload hash from the post-binding preflight.

Only after the user explicitly confirms should `execute --confirm SHEIN_OPENAPI_SUBMIT` be called. Always report the SHEIN result and readback; never present an upload or dry-run as a published product.
