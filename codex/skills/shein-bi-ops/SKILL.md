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

## Run inventory maintenance now

For an explicit request such as “现在跑一轮库存”, use the managed cloud job:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" maintain-inventory --out <receipt.json>
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" job --job-id <returned-job-id>
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" wait-job --job-id <returned-job-id> --wait-seconds 120
```

The command creates a fresh command ID and a cloud plan under the existing automatic inventory policy. It requires permission for the complete configured store set. Bare `maintain-inventory` (including aliases `maintain_inventory`, `replenish-inventory`, `replenish_inventory`) runs formally; `--dry-run` or explicit `--mode dry-run` previews without inventory submission, and `--mode execute` runs formally. `--dry-run` takes precedence over a valid explicit mode when both flags are supplied. An invalid explicit mode (such as `dry_run`) is rejected before receipt creation or dispatch, even alongside `--dry-run`. Other commands retain their existing defaults and mode parsing behavior.

The CLI saves and displays its command ID and local receipt before dispatch. If the connection breaks, retry with `maintain-inventory --command-id <same-id>` and unchanged parameters; a distinct user request gets a new ID. For an older CLI receipt containing `dryRun:true`, preserve that value explicitly with `--dry-run` or `--mode dry-run` when resuming. Never reinterpret an already dispatched preview as execution under the corrected default, delete its receipt to bypass the parameter check, or reuse its ID for execution. An authorized formal run requires a new command ID and a fresh cloud plan. A queued job is not a completed inventory run.

Report success only after the job returns an exact, hash-verified plan/result/journal/marker version for that command. Preserve individual pending, manual-fence and proven pre-submit exclusions in the report. Pending requests are read back without resubmission; a new command never erases an old key's tombstone or treats an old unknown effect as confirmed. Do not run a Windows inventory POST, copy an old same-day result into the new command, or replay another business queue to test this feature.

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

`--source-skc` is case-sensitive, accepts exactly one value, and requires exactly one `--source-store`. The server persists it as `targets.sourceSkc`; preflight uses only that pair and fails closed when live source detail does not match. Use the existing `lock-source --task-id <id> --source-store <store> --source-skc <SKC>` on the original task to recover an unavailable source before any image, description, attribute, or publish payload binding. The CLI reads the live task and supplies its exact old source and revision automatically; no new approval parameter or approval window is required. Replacement requires a unique old store/SKC, authoritative exact new-source detail under the existing loader contract, strict same-product alias/model checks, and complete historical audit proving no write or unknown submission. Terminal tasks, write claims, historical submissions (including platform pre-validation rejections), aborted/unknown write attempts, and existing bindings fail closed. Pure dry-run/check failures and planned_not_run readback are not submission evidence; a compact DTO omitting history/bindings does not prove their absence. Reviewed raw uploads, target stores, product and structured business facts are retained; bindings are never migrated. Old/new sources and identity evidence are audited, current and historical preflight execution locks are invalidated, and the CLI automatically runs fresh dry-run and reads back the same task. Missing/conflicting identity evidence remains a blocker; do not delete, archive, or recreate the task. Already authorized unattended business execution continues with the original owner after fresh preflight; source recovery itself does not publish.

- `operate` creates the structured task and performs the first preflight. It returns `aiInvoked=false` and never performs the final SHEIN write.
- The server authorizes business writes from the logged-in BI account's `writeStores`. Store scope cannot be expanded by CLI arguments.
- `safeWriteOperations` remains the platform capability switch. Dry-run/preflight, payload lock, authorized business instruction, Webhook gate, idempotency, audit and post-write readback remain mandatory.
- When authorized by the user's business instruction, proceed through dry-run/preflight and execute (`execute --task-id <id> --confirm SHEIN_OPENAPI_SUBMIT`) within existing authorization without demanding redundant confirmation or manual hash copying.
- Only genuine code bugs or formal release tasks are handed over to V6 integration; routine business operations execute independently within their scope without seeking permissions or approval from V6.
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
audit-only), invalidates the old preflight and reruns preflight.
Under the C1 contract, description binding is not a strict terminal mutation that blocks subsequent parameter completion: for the same product, missing parameters (including attribute completion or cross-link Donor attribute borrowing) may be supplemented either before or after description binding, while strictly preserving reviewed image and text assets. Both the description binding lock (`descriptionBinding`) and attribute binding lock (`productAttributeBinding`) bidirectionally synchronize with the latest exact payload hash; run a fresh preflight after dual-lock synchronization.
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

## Duplicate publishing authorization (A2: 新上与再上业务意图)

When a `copy_product_draft` task preflight is blocked by same-code duplicate listing checks (同货号重复上品 / 同款在售/已存在链接), confirm the explicit business intent:
- **明确新增链接意图 (New / Additional link intent)**: Regardless of whether existing or historical links already exist on the platform for the same product code, whenever the current business intent explicitly requires creating an additional or new link (新上或再上), proceed via duplicate publish authorization.
- **保持已审资料实际事实**: Preserve verified material facts (reviewed images, specifications, attributes) across different sources for the same product without inventing or dropping reviewed facts.

To explicitly authorize duplicate publishing, call the real CLI path with an explicit, stable request ID:

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" authorize-duplicate-publish --task-id <id> --store <target-store> --request-id <stable-request-id> [--skc <existing-skc>] [--note "<再上/新上业务意图>"]
```

- **Explicit Request ID**: `--request-id <stable-request-id>` is mandatory in the call contract and must be explicitly provided by the caller to guarantee strict idempotency (do not omit or substitute with auto-generated magic strings). Replaying with the same `request-id` is strictly idempotent, returns the existing authorization, and never creates duplicate overrides.
- **Confirmation**: The CLI implementation defaults `--confirm` to `YES`, so there is no need to prompt the user for an extra confirmation loop.
- **New Intent Isolation**: A genuine new business intent, distinct batch, or modified store requires a fresh task and new `request-id`.
- **Terminal & Pending States**: Tasks already in `submitted` or terminal readback state, or in `submitted_but_readback_pending` / `unknown`, cannot be blindly reused, retried, or overwritten.
- **Authority Boundary (`owner_actor_required`)**: Authorizing duplicate publishing is strictly owner-only. In addition to the target store being in the account's `writeStores`, the server enforces `owner_actor_required`; standard operator/collaborator accounts without owner authority are refused. CLI arguments cannot bypass or expand these account permission boundaries.

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

Before executing, verify the returned evidence includes:

- the same task ID;
- `payloadSource=task`;
- bound image count and names;
- square/main image roles;
- exact supplier code, supply price and inventory when supplied;
- a new payload hash from the post-binding preflight.

Call `execute --confirm SHEIN_OPENAPI_SUBMIT` within existing user authorization once preflight verifies. Do not ask for redundant approval when clear business intent is already given, and never ask the user to copy hashes manually. Always report the SHEIN result and readback; never present an upload or dry-run as a published product.
