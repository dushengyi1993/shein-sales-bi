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

- Cloud BI is the source of truth. Do not claim that a local V3/export file is required for an ordinary BI query.
- Never replace a failed direct query with browser scraping, `web-access`, SHEIN login automation, Chrome remote debugging, or a request that the user enable CDP.
- If direct cloud access fails, report the exact access/query error. Do not hide the failure by calling `ask` or inventing a result.
- Use the managed CLI for controlled preflight and authorized business operations; verify final facts and write results directly from the underlying database/OpenAPI/readback.

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

Before asking for final confirmation, verify the returned evidence includes:

- the same task ID;
- `payloadSource=task`;
- bound image count and names;
- square/main image roles;
- exact supplier code, supply price and inventory when supplied;
- a new payload hash from the post-binding preflight.

Only after the user explicitly confirms should `execute --confirm SHEIN_OPENAPI_SUBMIT` be called. Always report the SHEIN result and readback; never present an upload or dry-run as a published product.
