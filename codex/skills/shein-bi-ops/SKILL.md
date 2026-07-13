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

## Authority and evidence

Apply this precedence without improvising:

1. The user's current explicit instruction.
2. Material explicitly marked reviewed/approved, including folders named `已审可用`.
3. Approved product documents and the current owner rule bundle.
4. AI interpretation and suggestions.

AI is advisory at level 4. It must not override levels 1-3.

- “Not used in the final title/core selling points” does not mean “prohibited in approved images.”
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
