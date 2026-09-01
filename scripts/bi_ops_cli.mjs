#!/usr/bin/env node
/**
 * SHEIN BI Ops CLI.
 *
 * A small client for Codex Desktop / local operators to drive the cloud BI
 * automation workbench through the same account, permission, and audit boundary
 * as the web UI. It never stores plaintext passwords; `login` stores only the
 * server session cookie in the user's profile or in `--session-file`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {
  BI_OPS_CLI_VERSION,
  DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR,
  ensurePartnerKnowledgeCurrent,
} from '../lib/partner_knowledge_cache.mjs';
import {validateOwnerKnowledgeDistribution} from '../lib/owner_knowledge_distribution.mjs';
import {
  checkAndInstallPartnerCliUpdate,
  findManagedPartnerCliInstallRoot,
  relaunchPartnerCli,
} from '../lib/partner_cli_updater.mjs';
import {planLinkOpsImageRoles} from '../lib/link_ops_image_role_planner.mjs';
import {ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT} from '../lib/link_ops_duplicate_publish_override.mjs';
import {isSheinSkc} from '../lib/shein_product_identifiers.mjs';
import {
  buildPrepareDescriptionsCliOutput,
  describeDescriptionMaterial,
  descriptionBindingRequestKey,
  DESCRIPTION_SOURCE_PROOF,
  DESCRIPTION_SOURCE_PROOF_S9,
  DESCRIPTION_SOURCE_PROOF_DOCX,
  EMPTY_DESCRIPTION_CONFIRM_TEXT,
  validateDescriptionMaterialJson,
  verifyDescriptionMaterialAgainstDocx,
} from '../lib/link_ops_product_descriptions.mjs';
import {verifyDescriptionMaterialAgainstHtml} from '../lib/link_ops_description_material_extract.mjs';
import {
  PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT,
  PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
  PRODUCT_ATTRIBUTE_REQUEST_MODE_REFRESH,
  PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
  PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1,
  normalizeProductAttributeId,
  productAttributeBindingRequestKey,
  productAttributeBindingRequestKeyV2,
} from '../lib/link_ops_product_attribute_binding.mjs';
import {RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT} from '../lib/link_ops_uploaded_asset_binding_recovery.mjs';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {
  OPS_EXIT_CODES,
  buildOpsRun,
  compactOpsRun,
  invalidateOpsRunManifest,
  writeOpsJsonArtifactAtomic,
  writeOpsRunManifest,
} from '../lib/ops_run_bundle.mjs';
import {
  biQueryRequestTimeoutMs,
  fetchWithIdempotentNetworkRetry,
  isIncompleteBiQueryError,
  runBiQueryWithWait,
} from '../lib/bi_ops_query_retry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.SHEIN_BI_BASE_URL || 'https://sa.dushengyi.cc';
const DEFAULT_SESSION_FILE = process.env.SHEIN_BI_OPS_SESSION_FILE
  || path.join(os.homedir(), '.shein-bi', 'ops-session.json');
const SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const LOCAL_OPENAPI_TEST_OVERRIDE = process.env.SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR === '1';
const PARTNER_CHECK_TTL_MS = Math.max(0, Number(process.env.SHEIN_BI_PARTNER_CHECK_TTL_MS || 5 * 60_000));
let activeOwnerKnowledge = null;

function parseUploadedImageArgument(value) {
  const raw = String(value ?? '').trim();
  const parts = raw.split('|');
  if (parts.length !== 3) {
    throw new Error('--uploaded-image 必须使用精确格式 name|url|sha256');
  }
  const [name, imageUrl, rawSha256] = parts.map(part => part.trim());
  const sha256 = rawSha256.toLowerCase();
  let parsedUrl;
  try { parsedUrl = new URL(imageUrl); } catch { throw new Error(`--uploaded-image URL 无效：${imageUrl || '(missing)'}`); }
  if (!name || !['http:', 'https:'].includes(parsedUrl.protocol) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('--uploaded-image 必须包含非空 name、HTTP(S) URL 和 64 位十六进制 sha256');
  }
  return {name, imageUrl, sha256};
}

function parseArgs(argv) {
  const args = {
    command: '',
    baseUrl: DEFAULT_BASE_URL,
    sessionFile: DEFAULT_SESSION_FILE,
    username: process.env.SHEIN_BI_USERNAME || '',
    password: process.env.SHEIN_BI_PASSWORD || '',
    taskId: '',
    sourceTaskId: '',
    reuseApprovedBinding: false,
    allowEmptyDescription: false,
    emptyDescriptionConfirm: '',
    jobId: '',
    chatSessionId: '',
    text: '',
    profile: '',
    askAgent: true,
    stores: [],
    sourceStores: [],
    sourceSkcs: [],
    writeStores: [],
    products: [],
    spuList: [],
    skcList: [],
    skuCodeList: [],
    supplierSkuList: [],
    operation: '',
    mode: 'dry-run',
    confirm: '',
    status: '',
    globalView: false,
    waitSeconds: 0,
    waitSecondsProvided: false,
    note: '',
    docEvidenceFile: '',
    storeProbeFile: '',
    readbackEvidenceFile: '',
    expect: '',
    limit: 40,
    json: true,
    passwordStdin: false,
    requireRealSubmit: false,
    imageFile: '',
    imageUrl: '',
    imageType: 0,
    imageDir: '',
    uploadedImages: [],
    assetFiles: [],
    approvedAssets: false,
    standardGoodsSn: '',
    supplyPrice: null,
    productPrice: null,
    inventory: null,
    inputCurrentMa: null,
    inputCurrentA: null,
    inputCurrentValueId: '',
    titleGroup: '',
    titleAr: '',
    titleEn: '',
    outputFile: '',
    materialJsonFile: '',
    sourceFile: '',
    section: '',
    expectedRevision: null,
    donorStore: '',
    donorSkc: '',
    attributeId: null,
    adoptExisting: false,
    refreshBinding: false,
    expectedBindingRequestKey: '',
    expectedPrepareBatchId: '',
    openapiConfigFile: '',
    openapiStoreTruthFile: '',
    format: '',
    queryJson: '',
    queryFile: '',
    sections: [],
    categoryId: '',
    pageNum: 1,
    pageSize: 10,
    languageList: [],
    version: '',
    payloadHash: '',
    orderNo: '',
    handleType: 1,
    expressCode: '',
    expressIdCode: '',
    expressChannelCode: '',
    goodsId: '',
    goodsIds: [],
    preRequestId: '',
    packageNo: [],
    deliveryNo: '',
    docId: '',
    endpoint: '',
    bodyJson: '',
    bodyFile: '',
    performanceDate: '',
    knowledgeCacheDir: process.env.SHEIN_BI_KNOWLEDGE_CACHE_DIR || DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || '').trim();
    else if (a === '--session-file') args.sessionFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--username' || a === '-u') args.username = String(argv[++i] || '').trim();
    else if (a === '--password' || a === '-p') args.password = String(argv[++i] || '');
    else if (a === '--password-stdin') args.passwordStdin = true;
    else if (a === '--task-id' || a === '--id') args.taskId = String(argv[++i] || '').trim();
    else if (a === '--source-task-id' || a === '--source-publish-task-id') args.sourceTaskId = String(argv[++i] || '').trim();
    else if (a === '--reuse-approved-binding' || a === '--reuse-binding') args.reuseApprovedBinding = true;
    else if (a === '--allow-empty-description') args.allowEmptyDescription = true;
    else if (a === '--empty-description-confirm') args.emptyDescriptionConfirm = String(argv[++i] || '').trim();
    else if (a === '--job-id') args.jobId = String(argv[++i] || '').trim();
    else if (a === '--chat-session' || a === '--chat-session-id') args.chatSessionId = String(argv[++i] || '').trim();
    else if (a === '--text' || a === '--command') args.text = String(argv[++i] || '').trim();
    else if (a === '--profile' || a === '--model-profile') args.profile = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--no-agent') args.askAgent = false;
    else if (a === '--store' || a === '--stores') args.stores.push(...splitList(argv[++i]));
    else if (a === '--source-store' || a === '--source-stores' || a === '--read-store' || a === '--read-stores') args.sourceStores.push(...splitList(argv[++i]));
    else if (a === '--source-skc') args.sourceSkcs.push(...splitListPreserveCase(argv[++i]));
    else if (a === '--target-store' || a === '--target-stores' || a === '--write-store' || a === '--write-stores') args.writeStores.push(...splitList(argv[++i]));
    else if (a === '--product' || a === '--products' || a === '--ref') args.products.push(...splitList(argv[++i]));
    // SHEIN-generated SPU/SKC codes are case-sensitive in partialEdit. Keep
    // the exact platform spelling; stores and ordinary product refs may still
    // use the normalized splitList path.
    else if (a === '--spu' || a === '--spu-name') args.spuList.push(...splitListPreserveCase(argv[++i]));
    else if (a === '--skc' || a === '--skc-name') args.skcList.push(...splitListPreserveCase(argv[++i]));
    else if (a === '--sku-code') args.skuCodeList.push(...splitListPreserveCase(argv[++i]));
    else if (a === '--supplier-sku') args.supplierSkuList.push(...splitListPreserveCase(argv[++i]));
    else if (a === '--operation' || a === '--action' || a === '--intent') args.operation = normalizeOperationName(argv[++i]);
    else if (a === '--mode') args.mode = String(argv[++i] || 'dry-run').trim();
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--status') args.status = String(argv[++i] || '').trim();
    else if (a === '--all' || a === '--scope-all') args.globalView = true;
    else if (a === '--wait-seconds') {
      args.waitSeconds = Number(argv[++i] || 0);
      args.waitSecondsProvided = true;
    }
    else if (a === '--note') args.note = String(argv[++i] || '').trim();
    else if (a === '--doc-evidence') args.docEvidenceFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--store-probe') args.storeProbeFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--readback-evidence') args.readbackEvidenceFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--expect') args.expect = String(argv[++i] || '').trim();
    else if (a === '--limit') args.limit = Number(argv[++i] || 40);
    else if (a === '--pretty') args.json = false;
    else if (a === '--require-real-submit' || a === '--require-execute') args.requireRealSubmit = true;
    else if (a === '--file' || a === '--image-file') {
      args.imageFile = path.resolve(String(argv[++i] || ''));
      args.assetFiles.push(args.imageFile);
    }
    else if (a === '--url' || a === '--image-url') args.imageUrl = String(argv[++i] || '').trim();
    else if (a === '--image-type' || a === '--type') args.imageType = Number(argv[++i] || 0);
    else if (a === '--image-dir' || a === '--dir') args.imageDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--uploaded-image') args.uploadedImages.push(parseUploadedImageArgument(argv[++i]));
    else if (a === '--approved-assets' || a === '--source-approved') args.approvedAssets = true;
    else if (a === '--standard-goods-sn' || a === '--supplier-code') args.standardGoodsSn = String(argv[++i] || '').trim();
    else if (a === '--supply-price') args.supplyPrice = Number(argv[++i]);
    else if (a === '--product-price' || a === '--sale-price' || a === '--shop-price') args.productPrice = Number(argv[++i]);
    else if (a === '--inventory' || a === '--stock-qty') args.inventory = Number(argv[++i]);
    else if (a === '--input-current-ma') args.inputCurrentMa = Number(argv[++i]);
    else if (a === '--input-current-a') args.inputCurrentA = Number(argv[++i]);
    else if (a === '--input-current-value-id') args.inputCurrentValueId = String(argv[++i] || '').trim();
    else if (a === '--title-group') args.titleGroup = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--title-ar') args.titleAr = String(argv[++i] || '').trim();
    else if (a === '--title-en') args.titleEn = String(argv[++i] || '').trim();
    else if (a === '--out' || a === '--output') args.outputFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--material-json') args.materialJsonFile = path.resolve(String(argv[++i] || '').trim());
    else if (a === '--source-file') args.sourceFile = path.resolve(String(argv[++i] || '').trim());
    else if (a === '--expected-revision') args.expectedRevision = Number(argv[++i]);
    else if (a === '--donor-store') args.donorStore = String(argv[++i] || '').trim();
    else if (a === '--donor-skc') args.donorSkc = String(argv[++i] || '').trim();
    else if (a === '--attribute-id') args.attributeId = Number(argv[++i]);
    else if (a === '--adopt-existing') args.adoptExisting = true;
    else if (a === '--refresh-binding') args.refreshBinding = true;
    else if (a === '--expected-binding-request-key') args.expectedBindingRequestKey = String(argv[++i] || '').trim();
    else if (a === '--expected-prepare-batch-id' || a === '--prepare-batch-id') args.expectedPrepareBatchId = String(argv[++i] || '').trim();
    else if (a === '--format') args.format = String(argv[++i] || '').trim();
    else if (a === '--openapi-config') args.openapiConfigFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--store-truth' || a === '--openapi-store-truth') args.openapiStoreTruthFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--category' || a === '--category-id') args.categoryId = String(argv[++i] || '').trim();
    else if (a === '--page' || a === '--page-num') args.pageNum = Number(argv[++i] || 1);
    else if (a === '--page-size') args.pageSize = Number(argv[++i] || 10);
    else if (a === '--language' || a === '--languages') args.languageList.push(...splitList(argv[++i]).map(x => x.toLowerCase()));
    else if (a === '--version') args.version = String(argv[++i] || '').trim();
    else if (a === '--payload-hash') args.payloadHash = String(argv[++i] || '').trim();
    else if (a === '--order-no' || a === '--order') args.orderNo = String(argv[++i] || '').trim();
    else if (a === '--handle-type') args.handleType = Number(argv[++i] || 1);
    else if (a === '--express-code') args.expressCode = String(argv[++i] || '').trim();
    else if (a === '--express-id-code') args.expressIdCode = String(argv[++i] || '').trim();
    else if (a === '--express-channel-code') args.expressChannelCode = String(argv[++i] || '').trim();
    else if (a === '--goods-id') args.goodsId = String(argv[++i] || '').trim();
    else if (a === '--goods-ids') args.goodsIds.push(...splitList(argv[++i]));
    else if (a === '--pre-request-id') args.preRequestId = String(argv[++i] || '').trim();
    else if (a === '--package-no' || a === '--package-nos') args.packageNo.push(...splitList(argv[++i]));
    else if (a === '--delivery-no') args.deliveryNo = String(argv[++i] || '').trim();
    else if (a === '--doc-id' || a === '--docId') args.docId = String(argv[++i] || '').trim();
    else if (a === '--endpoint') args.endpoint = String(argv[++i] || '').trim();
    else if (a === '--body-json') args.bodyJson = String(argv[++i] || '');
    else if (a === '--body-file') args.bodyFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--performance-date' || a === '--perf-date') args.performanceDate = String(argv[++i] || '').trim();
    else if (a === '--knowledge-cache-dir') args.knowledgeCacheDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--query-json') args.queryJson = String(argv[++i] || '');
    else if (a === '--query-file') args.queryFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--section' || a === '--sections') {
      const rawValue = String(argv[++i] || '');
      const values = rawValue
        .split(/[,\s，、]+/)
        .map(x => x.trim())
        .filter(Boolean);
      for (const value of values) {
        if (!args.sections.includes(value)) args.sections.push(value);
      }
      // --section is also used by description preparation. Keep the
      // singular compatibility value while treating both spellings as the
      // same repeatable query-section input.
      if (a === '--section') args.section = rawValue.trim().toLowerCase();
      else if (!args.section && values.length === 1) args.section = values[0].toLowerCase();
    }
    else if (a === '--help' || a === '-h') {
      args.command = 'help';
    } else if (!args.command) {
      args.command = a;
    } else {
      rest.push(a);
    }
  }
  if (!args.text && rest.length) args.text = rest.join(' ').trim();
  args.baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  args.command ||= 'help';
  return args;
}

function normalizeOperationName(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = new Map([
    ['copy', 'copy_product_draft'],
    ['copy_product', 'copy_product_draft'],
    ['copy_draft', 'copy_product_draft'],
    ['create_link', 'copy_product_draft'],
    ['publish', 'copy_product_draft'],
    ['retire', 'retire_link'],
    ['retire_product', 'retire_link'],
    ['down', 'retire_link'],
    ['off_shelf', 'retire_link'],
    ['offline', 'retire_link'],
    ['activate', 'activate_link'],
    ['activate_product', 'activate_link'],
    ['up', 'activate_link'],
    ['on_shelf', 'activate_link'],
    ['online', 'activate_link'],
    ['relist', 'activate_link'],
    ['restore_listing', 'activate_link'],
    ['title', 'update_title'],
    ['image', 'update_images'],
    ['images', 'update_images'],
    ['photo', 'update_images'],
    ['photos', 'update_images'],
  ]);
  return aliases.get(lower) || lower;
}

function splitListPreserveCase(value) {
  return String(value || '')
    .split(/[,\s/]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

function splitList(value) {
  return splitListPreserveCase(value).map(x => x.toUpperCase());
}

function help() {
  return `SHEIN BI Ops CLI

Usage:
  node scripts/bi_ops_cli.mjs login --username <账号> --password <密码>
  node scripts/bi_ops_cli.mjs doctor
  node scripts/bi_ops_cli.mjs knowledge-status
  node scripts/bi_ops_cli.mjs version
  node scripts/bi_ops_cli.mjs update
  node scripts/bi_ops_cli.mjs update-status
  node scripts/bi_ops_cli.mjs guide
  node scripts/bi_ops_cli.mjs doctor --operation copy_product_draft --target-stores HL
  node scripts/bi_ops_cli.mjs doctor --operation activate_link --stores DL --require-real-submit
  node scripts/bi_ops_cli.mjs doctor --operation retire_link --stores DL --require-real-submit
  node scripts/bi_ops_cli.mjs me
  node scripts/bi_ops_cli.mjs capabilities
  node scripts/bi_ops_cli.mjs maintenance-readiness --operation retire_link --expect blocked
  node scripts/bi_ops_cli.mjs maintenance-readiness --operation retire_link --doc-evidence <schema.json> --store-probe <probe.json> --readback-evidence <readback.json> --expect pilot_ready
  node scripts/bi_ops_cli.mjs plan-images --image-dir <图片文件夹> [--store JSH] [--out roles.json]
  node scripts/bi_ops_cli.mjs prepare-publish --task-id <id> --store JSH --image-dir <已审可用图片目录> --approved-assets --standard-goods-sn "(全)SK-999食品料理机" --supply-price 210 --inventory 100
  node scripts/bi_ops_cli.mjs prepare-publish --task-id <update_images任务id> --store HL --image-dir <已审可用图片目录> --approved-assets --spu <SPU> --skc <SB/SV/SH-SKC> [--sku-code <SKU>]
  node scripts/bi_ops_cli.mjs prepare-publish --task-id <update_images任务id> --store HL --image-dir <已审可用图片目录> --approved-assets --source-task-id <刚发布任务id>
  node scripts/bi_ops_cli.mjs prepare-publish --task-id <copy_product_draft任务id> --store JSH --reuse-approved-binding --supply-price 210 --inventory 100 --input-current-ma 700
  node scripts/bi_ops_cli.mjs prepare-publish --task-id <copy_product_draft任务id> --store FY --reuse-approved-binding --supply-price 172.22 --inventory 100 --input-current-a 0.18 --input-current-value-id 304301999
  node scripts/bi_ops_cli.mjs prepare-publish --task-id <copy_product_draft任务id> --store JSH --reuse-approved-binding --standard-goods-sn SK-999 --supply-price 210 --inventory 100 --allow-empty-description --empty-description-confirm ${EMPTY_DESCRIPTION_CONFIRM_TEXT}
  node scripts/bi_ops_cli.mjs prepare-descriptions --task-id <copy_product_draft任务id> --store HL --source-file <实际审核资料HTML或普通OOXML DOCX> [--section auto|s09|s9] [--material-json <可选：待核验material.json>] [--expected-revision <n>]
  node scripts/bi_ops_cli.mjs prepare-product-attribute --task-id <copy_product_draft任务id> --store FY --donor-store YJ --donor-skc <同货号donor SKC> --attribute-id 1002328 [--expected-revision <n>]
  node scripts/bi_ops_cli.mjs prepare-product-attribute --adopt-existing --task-id <copy_product_draft任务id> --store FY --donor-store YJ --donor-skc <同货号donor SKC> --attribute-id 1002328 [--expected-revision <n>]
  node scripts/bi_ops_cli.mjs prepare-product-attribute --refresh-binding --task-id <copy_product_draft任务id> --store FY [--expected-revision <n>] [--expected-binding-request-key <64位sha256>]
  node scripts/bi_ops_cli.mjs recover-uploaded-asset-binding --task-id <copy_product_draft任务id> --prepare-batch-id <64位sha256> --uploaded-image "main.jpg|https://...|<sha256>" <重复共6次> --confirm ${RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT} [--expected-revision <n>]
  node scripts/bi_ops_cli.mjs update-description --source-task-id <历史发布任务id> --store HL --spu <SPU> [--skc <SKC>] --source-file <实际审核资料HTML> [--section auto|s09|s9] [--material-json <可选>]
  node scripts/bi_ops_cli.mjs prepare-pending-image-correction --task-id <update_images任务id> --store HL --source-task-id <刚发布任务id>
  node scripts/bi_ops_cli.mjs retire-candidates --file <query.json|enriched.csv> --performance-date 2026-07-04 [--out <dir>]
  node scripts/bi_ops_cli.mjs upload-pic --store FY --image-type 2 --file <image.jpg> [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs transform-pic --store FY --image-type 2 --url <https://...> [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs audit-status --store FY --spu <SPU> [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs search-product --store FY [--spu <SPU>|--product <货号>] [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs publish-standard --store FY [--category <id>] [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs shelf-quota --store FY [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs order-fulfillment --operation export-address --store FY --order-no <order>
  node scripts/bi_ops_cli.mjs openapi-call --doc-id <docId> --store FY --body-json '{}'
  node scripts/bi_ops_cli.mjs openapi-call --doc-id <GET docId> --store FY --query-json '{"id":"..."}'
  node scripts/bi_ops_cli.mjs openapi-catalog-plan --format summary [--out plan.json]
  node scripts/bi_ops_cli.mjs query --text "今天全部店铺销售额是多少" --out <结果.json>
  node scripts/bi_ops_cli.mjs query --text "找出近7天曝光3000以上、点击率4%以上、销量0的链接" --sections linksData --out <结果.json>
  node scripts/bi_ops_cli.mjs operate --operation update_inventory --store DX --product PA4-6L --inventory 30 --text "把库存改成30"
  node scripts/bi_ops_cli.mjs operate --operation retire_link --store DX --product sv123 --text "下架这条链接"
  node scripts/bi_ops_cli.mjs operate --operation update_product_price --store DX --product sv123 --product-price 99 --text "售价改成99 SAR"
  node scripts/bi_ops_cli.mjs ask --text "今天全部店铺销售额是多少" --out <结果.json>  # 旧兼容别名，同样不调用模型
  node scripts/bi_ops_cli.mjs chats
  node scripts/bi_ops_cli.mjs chat --text "把 DX 的 PA4-6L 库存改成 30"
  node scripts/bi_ops_cli.mjs chat --chat-session <id> --text "先做系统检查，不要提交"
  node scripts/bi_ops_cli.mjs chat --text "把 DX 的 PA4-6L 库存改成 30" --wait-seconds 120
  node scripts/bi_ops_cli.mjs jobs [--status queued|running|succeeded|failed|uncertain_write]
  node scripts/bi_ops_cli.mjs job --job-id <id>
  node scripts/bi_ops_cli.mjs wait-job --job-id <id> [--wait-seconds 120]
  node scripts/bi_ops_cli.mjs tasks
  node scripts/bi_ops_cli.mjs create --text "把 520a 在 DL 生成下架预检" --stores DL --products 520a
  node scripts/bi_ops_cli.mjs create --text "复制 CX 的 SM-961 到 HL" --source-stores CX --target-stores HL --products SM-961
  node scripts/bi_ops_cli.mjs create --text "复制 CX 的 SM-961 到 HL" --source-store CX --source-skc sb12345678 --target-store HL --product SM-961
  node scripts/bi_ops_cli.mjs lock-source --task-id <id> --source-store CX --source-skc sb12345678
  node scripts/bi_ops_cli.mjs authorize-duplicate-publish --task-id <id> --store NM --skc sv123 --note "保留旧链接并额外新增" --confirm ${ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT}
  node scripts/bi_ops_cli.mjs preflight --task-id <id>
  node scripts/bi_ops_cli.mjs execute --task-id <id> --confirm ${SUBMIT_CONFIRM_TEXT}
  node scripts/bi_ops_cli.mjs resolve --task-id <id> --status done --note "人工确认已闭环"
  node scripts/bi_ops_cli.mjs audit --task-id <id>
  node scripts/bi_ops_cli.mjs logout

Codex App example:
  请调用 node scripts/bi_ops_cli.mjs create --stores DL --products 520a --text "把 DL 的 520a 做下架预检"

Options:
  --base-url       默认 ${DEFAULT_BASE_URL}
  --session-file   默认 ${DEFAULT_SESSION_FILE}
  --knowledge-cache-dir  默认 ${DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR}
  --source-stores  跨店复制时只读来源店铺
  --source-skc     跨店复制时精确锁定一个区分大小写的源 SKC；必须同时且只提供一个 --source-store
  --target-stores  跨店复制时真实写入目标店铺；不填则沿用 --stores
  --chat-session   chat/tasks 用；继续指定的自动运营会话
  --profile        Owner 可选 fast / balanced / deep / owner；服务端仍会按风险升级且不会因此绕过权限
  --no-agent       chat 用；只走确定性意图/任务规则，不调用模型
  --wait-seconds   chat/wait-job 用；等待后台结构化规划完成的最长秒数
  --scope-all      Owner 的 jobs 全局只读视图；不会扩大写权限
  --operation      doctor 用；可填 copy_product_draft / activate_link / retire_link / update_title / update_images / update_inventory / update_supply_price / update_product_price / certificate_review
  --require-real-submit  doctor 用；要求所选店铺+动作已可真实提交，否则退出非 0
  --doc-evidence / --store-probe / --readback-evidence
                   maintenance-readiness 用；维护真实写的脱敏证据文件
  --expect         maintenance-readiness 用；blocked / schema_ready / pilot_ready
  --image-dir      plan-images 用；只扫描本地图包并输出角色规划，不上传、不提交
  --approved-assets  prepare-publish 用；确认图片目录已经过人工审核，AI 不得按语义擅自剔图
  --allow-empty-description prepare-publish 用；仅在用户当前明确要求描述留空时使用，默认关闭
  --empty-description-confirm prepare-publish 空描述授权精确确认词：${EMPTY_DESCRIPTION_CONFIRM_TEXT}
  --reuse-approved-binding
                   prepare-publish 用；同一 copy_product_draft 任务已有服务端已审图片绑定时，仅复用该绑定并更新
                   publishPreparation（如 --input-current-ma），不扫描/读取/上传本地图片；与 --image-dir 互斥，
                   不能与 update_images 维护模式的 --source-task-id 组合
  --source-file     prepare-descriptions 必填；审核资料 HTML（唯一 section#s09/s9）或普通 OOXML DOCX 固定标题/卖点结构；工具从文件字节计算 SHA 并逐字提取三语各5行
  --material-json   prepare-descriptions 可选；提供时逐字核验其 ar/en/zh-cn 行与实际 section#s09 一致，任一字节不同即拒绝
  --expected-revision prepare-descriptions 用；任务当前 repository revision，可选项，绑定前做 CAS 校验
  --donor-store / --donor-skc / --attribute-id
                   prepare-product-attribute 用；同标准货号 donor 链接的店铺、区分大小写的唯一 SKC，
                   与要修复的白名单属性 ID（仅 1002328 Hazardous materials classification）
  --adopt-existing  prepare-product-attribute 用；显式 adopt 既有 1002328 行（值必须与 live donor 完全一致），
                   payload 不做任何修改；不加本开关时默认 append_missing（只修缺失属性）
  --refresh-binding prepare-product-attribute 用；对既有绑定重签来源证据（现场重新核验同一 donor），
                    payload/描述/图片/模式/哈希全部保持不变；禁止与 donor/attribute/adopt 参数组合
  --source-task-id    prepare-publish 的 update_images 模式；从指定已提交发布任务的 publishResult/readbackFingerprint 精确继承 SPU/SKC/SKU
                      prepare-pending-image-correction 会复用任务中现有已审图片绑定，不重复上传图片
  --standard-goods-sn / --supply-price / --inventory
                   prepare-publish 用；把货号、供货价和库存锁到同一任务
  --supplier-sku / --input-current-ma / --input-current-a / --input-current-value-id
                   prepare-publish 用；同店重复链接时锁定唯一 Seller SKU，并按平台官方单位和值ID补输入电流属性
  --title-ar / --title-en / --category-id
                   prepare-publish 用；可选的精确标题与末级分类覆盖
  --performance-date retire-candidates 用；按该表现日期计算首次上架 15 天保护窗
  --file / --url   图片工具用；本地文件或外链图片地址
  --image-type     图片工具用；1主图 / 2细节图 / 5方块图 / 6色块图 / 7详情图
  --openapi-config 底层 OpenAPI executor 测试用；日常 bi_ops_cli 不允许用它从本机直连真实 SHEIN
  --store-truth    底层 OpenAPI executor 测试用；默认 config/store_account_truth.json
  --category       publish-standard/search-product 用；末级分类 ID
  --page-size      search-product 用；最大 10
  --sections       query 用；显式指定 rankings / linksData / productState / profit / inventoryTrend / orders / priceScatter / afterSales / comments / rtvData / waybills 等数据分区
  --out            query 用；把完整结构化数据原子写入文件，并生成相邻 manifest；终端只返回紧凑证据索引

Safety:
  - 密码只用于 login 请求，不写入 session 文件。
  - doctor 只做本机/云端连通性和权限自检，不创建任务、不触发预检、不执行 SHEIN 写。
  - maintenance-readiness 只读检查脱敏证据，不连接 SHEIN，不打开真实写。
  - 用户当轮明确指令和“已审可用”素材高于 AI 语义推断；标题未采用某参数不等于图片禁用。
  - plan-images 只做本地图包角色规划，备用目录和明确“产品封面/AB测试”图不提交；会读取真实尺寸再判断方形图。
  - prepare-publish 上传后把图片 URL 和显式字段绑定回同一 task，再重新预演；不会新建替代任务，也不会静默复制源图。
  - prepare-publish --reuse-approved-binding 只复用该任务服务端已存的已审图片绑定（body=sourceApproved:true、
    reuseApprovedBinding:true、bindings:[]），不调用图片角色规划或 upload-pic；仍按新 publishPreparation 绑定并 dry-run，
    输出 realPublishOccurred=false。
  - prepare-descriptions 用确定性 extractor 从实际 HTML 唯一 section#s09 逐字提取“三语核心卖点”（英文/阿文 code、中文 displaybox，
    各恰好5行），以文件字节计算 sourceFileSha256 并逐字核验；绑定为固定 ar/en 各5行（zh-cn 仅材料审计SHA），
    绑定后旧预演锁作废并重新预演；不会生成/翻译/改写描述，不会自动映射源 OpenAPI 商品描述，也不会重传图片。
  - prepare-product-attribute 只修复缺失的白名单商品属性（仅 1002328）；值只能来自同货号官方 live donor 链接（严格别名/canonical），
    服务端独立核验 donor 店铺身份、区分大小写 SKC 唯一 searchProduct、live spu-info 同 supplierCode/商品身份、
    属性恰好一次后绑定到同一任务；图片/描述/标题/价格/库存保持字节不变，旧预演锁作废且描述锁按设计保持失效；
    成功后返回 committed-needs-rebind，必须用原始审核 HTML 在同一任务 prepare-descriptions 重绑描述并重新预演，
    不新建任务、不重传图片、绝不发布。
  - prepare-product-attribute --adopt-existing 为既有一行 1002328 现场核验并绑定来源证据：payload 完全不变
    （old=new hash），描述/图片绑定保持有效无需重绑；若描述/图片绑定缺失或失效、值不一致、重复/缺失行，一律拒绝且零写入。
  - prepare-product-attribute --refresh-binding 仅在执行门唯一阻断为 PRODUCT_ATTRIBUTE_ALIAS_REGISTRY_DRIFT 时重签
    同一 donor 证据；刷新不修改 payload/描述/图片，不预演、不发布，返回 needs-dry-run；未漂移时返回 already_current。
  - retire-candidates 只生成下架候选明细，不执行下架；固定排除有新品标签、首次上架 15 天内或缺首次上架时间的链接，并要求人工确认。
  - 本机不处于受控云端执行边界，不能直连真实 SHEIN OpenAPI；bi_ops_cli 的真实 OpenAPI 调用必须走云端 BI 服务。
  - upload-pic / transform-pic 的 execute 委托云端 /api/openapi-image-asset/*；本地只做文件封装和权限会话传递。
  - audit-status / search-product / publish-standard / openapi-call 不允许通过 bi_ops_cli 从本机 execute；需要真实回读时到 shein-bi-tencent 云端执行或走云端任务审计。
  - order-fulfillment 是高风险订单履约工具；execute 必须额外提供确认文本和 dry-run payload hash。
  - openapi-call 是目录驱动 JSON 兜底工具；GET 用 --query-json/--query-file，POST 用 --body-json/--body-file；文件上传/WebHook 会被阻断，真实 execute 只能在云端边界内使用。
  - openapi-catalog-plan 只读取本地官方目录/schema，输出全量接口归位矩阵，不联网、不启用 WebHook receiver。
  - 所有任务创建/预检/执行/审计都走云端账号权限和审计。
  - query 通过同一 BI 账号直接读取确定性的 BI 数据分区，返回 aiInvoked=false；当前 Codex 自己筛选、计算和说明，不调用云端问数模型。
  - operate 由当前本机 Codex 显式传入 operation/store/product/参数；服务器不会再用关键词或云端模型重新猜动作。它只创建任务并运行系统检查，不会直接提交。
  - ask 是 query 的旧兼容别名，同样不会调用模型；只读需求不得使用 chat。chat 只用于受控运营动作会话或用户明确要求测试网页会话能力。
  - 每个云端业务命令开始前会用 ETag 检查负责人规则 manifest；有更新才原子下载，普通账号没有反向发布权限。
  - 受管安装还会在业务命令前检查 CLI release；有新版本时校验逐文件和 bundle SHA256，原子安装后重启同一命令。
  - execute 仍需服务端确认任务已预检通过，并且确认文本精确匹配。
  - resolve 只用于已提交待回读/需人工处理任务的人工核销；服务端只允许全店管理账号执行。`;
}

async function readSession(file) {
  const primary = await readSessionCandidate(file);
  if (primary) return primary;
  const backup = await readSessionCandidate(sessionBackupFile(file));
  if (!backup) return {};
  await writeSessionFileAtomic(file, backup).catch(() => {});
  return backup;
}

function sessionBackupFile(file) {
  return `${file}.backup`;
}

async function readSessionCandidate(file) {
  try {
    const data = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' && String(data.cookie || '').trim() ? data : null;
  } catch {
    return null;
  }
}

async function writeSessionFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
    try {
      await fs.rename(temp, file);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await fs.rm(file, {force: true});
      await fs.rename(temp, file);
    }
    try { await fs.chmod(file, 0o600); } catch {}
  } finally {
    await fs.rm(temp, {force: true}).catch(() => {});
  }
}

async function writeSession(file, data) {
  await writeSessionFileAtomic(sessionBackupFile(file), data);
  await writeSessionFileAtomic(file, data);
}

async function readStdinText() {
  let out = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

async function promptLine(prompt) {
  process.stdout.write(prompt);
  const text = await readStdinText();
  return text.split(/\r?\n/)[0] || '';
}

async function promptHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return promptLine(prompt);
  }
  return await new Promise(resolve => {
    let value = '';
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = ch => {
      if (ch === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        if (value.length) value = value.slice(0, -1);
        return;
      }
      value += ch;
    };
    process.stdin.on('data', onData);
  });
}

function cookieFromSetCookie(headers) {
  const raw = headers.get('set-cookie') || '';
  return raw.split(';')[0].trim();
}

function biLoginRequiredError({expired = false} = {}) {
  const err = new Error(
    expired
      ? 'BI 登录已失效，CLI 尚未执行当前请求。请先运行“$HOME\\.shein-bi\\cli\\shein-bi-ops.cmd login --username <你的BI账号>”重新登录一次，再重试原命令。'
      : '尚未登录 BI，CLI 尚未执行当前请求。请先运行“$HOME\\.shein-bi\\cli\\shein-bi-ops.cmd login --username <你的BI账号>”完成登录，再重试原命令。',
  );
  err.code = expired ? 'BI_SESSION_EXPIRED' : 'BI_LOGIN_REQUIRED';
  if (expired) err.status = 401;
  return err;
}

async function request(args, pathname, {method = 'GET', body, auth = true, allowJsonFailure = false, signal} = {}) {
  const headers = {'accept': 'application/json', 'user-agent': `shein-bi-ops-cli/${BI_OPS_CLI_VERSION}`};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const session = await readSession(args.sessionFile);
    if (session.cookie) headers.cookie = session.cookie;
  }
  const res = await fetchWithIdempotentNetworkRetry(fetch, `${args.baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {raw: text};
  }
  if (!res.ok || (json.ok === false && !allowJsonFailure)) {
    if (auth && res.status === 401) {
      const err = biLoginRequiredError({expired: true});
      err.response = json;
      throw err;
    }
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.response = json;
    const retryAfterSeconds = Number(res.headers.get('retry-after') || 0);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      err.retryAfterMs = Math.min(30_000, Math.ceil(retryAfterSeconds * 1_000));
    }
    throw err;
  }
  return {json, res};
}

const LINK_OPS_DEFERRED_OUTCOMES = new Set(['blocked', 'incomplete', 'unconfirmed']);

function linkOpsExecutionResponse(json, {fallbackTask = null} = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    const error = new Error('Link Ops execution returned an invalid JSON response');
    error.code = 'LINK_OPS_EXECUTION_PROTOCOL_INVALID';
    throw error;
  }
  const task = json.task && typeof json.task === 'object' && !Array.isArray(json.task)
    ? json.task
    : fallbackTask;
  const execution = json.execution && typeof json.execution === 'object' && !Array.isArray(json.execution)
    ? json.execution
    : null;
  if (!task || !execution) {
    const error = new Error('Link Ops execution response is missing the persisted task or execution evidence');
    error.code = 'LINK_OPS_EXECUTION_PROTOCOL_INVALID';
    throw error;
  }
  const declaredOk = json.ok === true;
  const partial = json.partial === true;
  const rawOutcome = String(json.outcome || '').trim().toLowerCase();
  const deferredOutcome = LINK_OPS_DEFERRED_OUTCOMES.has(rawOutcome);
  // A contradictory service response must fail closed. In particular, an
  // HTTP-200 body cannot claim top-level success while also declaring that
  // the durable execution is partial or its business outcome is unconfirmed.
  const ok = declaredOk && !partial && !deferredOutcome;
  const outcome = rawOutcome || (partial ? 'incomplete' : (ok ? '' : 'failed'));
  if (!ok && (partial || LINK_OPS_DEFERRED_OUTCOMES.has(outcome)) && json.committed !== true) {
    const error = new Error(`Link Ops ${outcome} response did not prove that its execution evidence was persisted`);
    error.code = 'LINK_OPS_EXECUTION_COMMIT_UNPROVEN';
    throw error;
  }
  return {
    ok,
    committed: json.committed === true,
    ...(outcome ? {outcome} : {}),
    ...(ok ? {} : {
      partial: partial || deferredOutcome,
      error: String(json.error || 'Link Ops execution did not reach a confirmed business outcome'),
    }),
    commitRecovered: json.commitRecovered === true,
    auditPending: json.auditPending === true,
    stage: String(json.stage || ''),
    warning: String(json.warning || ''),
    task,
    execution,
  };
}

function linkOpsExecutionSummary(response) {
  return {
    ok: response.ok,
    committed: response.committed,
    ...(response.outcome ? {outcome: response.outcome} : {}),
    ...(response.ok ? {} : {
      partial: response.partial,
      error: response.error,
    }),
    commitRecovered: response.commitRecovered,
    auditPending: response.auditPending,
    stage: response.stage,
    warning: response.warning,
  };
}

function applyLinkOpsExecutionExitCode(output) {
  if (output?.ok === true) return;
  process.exitCode = LINK_OPS_DEFERRED_OUTCOMES.has(String(output?.outcome || '').toLowerCase())
    ? OPS_EXIT_CODES.blocked
    : OPS_EXIT_CODES.failed;
}

const KNOWLEDGE_CHECK_COMMANDS = new Set([
  'doctor', 'me', 'capabilities', 'query', 'ask', 'chats', 'jobs', 'job', 'wait-job', 'wait_job',
  'chat', 'tasks', 'create', 'operate', 'preflight', 'execute', 'resolve', 'audit',
  'lock-source', 'lock_source',
  'upload-pic', 'upload_pic', 'transform-pic', 'transform_pic',
  'prepare-publish', 'prepare_publish',
  'prepare-descriptions', 'prepare_descriptions',
  'prepare-product-attribute', 'prepare_product_attribute',
  'recover-uploaded-asset-binding', 'recover_uploaded_asset_binding',
  'update-description', 'update_description',
  'prepare-pending-image-correction', 'prepare_pending_image_correction',
]);

const AUTO_UPDATE_COMMANDS = new Set([
  ...KNOWLEDGE_CHECK_COMMANDS,
  'plan-images', 'plan_images',
]);

async function refreshPartnerCli(args, {force = false, checkOnly = false} = {}) {
  const installRoot = await findManagedPartnerCliInstallRoot({entryRoot: ROOT});
  if (!installRoot) return {ok: true, managed: false, updated: false, currentVersion: BI_OPS_CLI_VERSION};
  const session = await readSession(args.sessionFile);
  if (!session.cookie) throw biLoginRequiredError();
  const result = await checkAndInstallPartnerCliUpdate({
    baseUrl: args.baseUrl,
    cookie: session.cookie,
    currentVersion: BI_OPS_CLI_VERSION,
    entryRoot: ROOT,
    installRoot,
    force,
    checkOnly,
    maxAgeMs: force ? 0 : PARTNER_CHECK_TTL_MS,
  });
  if (result.updated && !args.json) process.stderr.write(`CLI 已安全更新：${result.currentVersion} -> ${result.latestVersion}\n`);
  return result;
}

async function refreshPartnerCliAndRelaunchIfNeeded(args, {force = false} = {}) {
  const result = await refreshPartnerCli(args, {force});
  if (!result.updated) return {relaunched: false, result};
  const relaunched = await relaunchPartnerCli({entrypoint: result.entrypoint, argv: process.argv.slice(2)});
  process.exitCode = relaunched.code;
  return {relaunched: true, result, relaunched};
}

async function refreshPartnerKnowledge(args, {
  strict = false,
  force = false,
  allowTransientCacheFallback = !strict,
} = {}) {
  const session = await readSession(args.sessionFile);
  if (!session.cookie) {
    if (strict) throw new Error('尚未登录 BI，无法检查负责人规则版本');
    activeOwnerKnowledge = null;
    return {ok: false, skipped: true, warning: '尚未登录 BI'};
  }
  const result = await ensurePartnerKnowledgeCurrent({
    baseUrl: args.baseUrl,
    cookie: session.cookie,
    cacheDir: args.knowledgeCacheDir,
    cliVersion: BI_OPS_CLI_VERSION,
    strict,
    maxAgeMs: force ? 0 : PARTNER_CHECK_TTL_MS,
    allowTransientCacheFallback,
  });
  activeOwnerKnowledge = result;
  if (result.updated && !args.json) {
    process.stderr.write(`负责人规则已更新并校验：${String(result.manifest?.sourceCommit || result.manifest?.fingerprint || '').slice(0, 12)}\n`);
  }
  if (result.warning && !args.json) {
    const source = result.source === 'stale-verified-cache' ? `source=${result.source}；` : '';
    process.stderr.write(`负责人规则检查提示：${source}${result.warning}\n`);
  }
  if (result.cliUpdateRecommended && !args.json) {
    process.stderr.write(`CLI 有推荐更新：当前 ${BI_OPS_CLI_VERSION}，推荐 ${result.recommendedCliVersion}\n`);
  }
  return result;
}

async function readJsonForQueryDiagnostic(file) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

async function readVerifiedOwnerKnowledgeCacheDiagnostic(args) {
  const cacheDir = path.resolve(args.knowledgeCacheDir || DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR);
  const pointer = await readJsonForQueryDiagnostic(path.join(cacheDir, 'manifest.json'));
  const data = pointer?.data && typeof pointer.data === 'object' ? pointer.data : null;
  if (!data) {
    return {
      ok: false,
      verified: false,
      source: 'none',
      errorCode: 'OWNER_KNOWLEDGE_CACHE_MISSING',
    };
  }
  const generation = String(pointer.generation || data.bundleSha256 || '').trim().toLowerCase();
  const bundleFiles = /^[a-f0-9]{64}$/u.test(generation)
    ? [path.join(cacheDir, 'generations', generation, 'bundle.json'), path.join(cacheDir, 'bundle.json')]
    : [path.join(cacheDir, 'bundle.json')];
  let bundle = null;
  for (const bundleFile of bundleFiles) {
    bundle = await readJsonForQueryDiagnostic(bundleFile);
    if (bundle) break;
  }
  if (!bundle) {
    return {
      ok: false,
      verified: false,
      source: 'invalid-cache',
      errorCode: 'OWNER_KNOWLEDGE_CACHE_BUNDLE_MISSING',
    };
  }
  try {
    validateOwnerKnowledgeDistribution({
      manifest: {
        schemaVersion: Number(data.schemaVersion || 0),
        authorityId: String(data.authorityId || ''),
        fingerprint: String(data.fingerprint || ''),
        publishedAt: data.publishedAt ? String(data.publishedAt) : null,
        ruleCount: Number(data.ruleCount || 0),
        bundlePath: String(data.bundlePath || ''),
        bundleSha256: String(data.bundleSha256 || ''),
      },
      bundle,
    });
  } catch {
    return {
      ok: false,
      verified: false,
      source: 'invalid-cache',
      errorCode: 'OWNER_KNOWLEDGE_CACHE_VALIDATION_FAILED',
    };
  }
  return {
    ok: true,
    verified: true,
    source: 'verified-cache',
    current: data.current !== false,
    fingerprint: String(data.fingerprint || ''),
    sourceCommit: String(data.sourceCommit || ''),
    checkedAt: String(pointer.checkedAt || ''),
  };
}

async function readLocalPartnerCliDiagnostic() {
  try {
    const installRoot = await findManagedPartnerCliInstallRoot({entryRoot: ROOT});
    if (!installRoot) {
      return {managed: false, available: false, source: 'none', refreshAttempted: false};
    }
    const pointer = await readJsonForQueryDiagnostic(path.join(installRoot, 'current.json'));
    const version = String(pointer?.version || '').trim();
    return {
      managed: true,
      available: Boolean(version),
      source: version ? 'managed-pointer' : 'invalid-pointer',
      version,
      refreshAttempted: false,
    };
  } catch (error) {
    return {
      managed: false,
      available: false,
      source: 'diagnostic-error',
      refreshAttempted: false,
      errorCode: String(error?.code || 'PARTNER_CLI_LOCAL_DIAGNOSTIC_FAILED'),
    };
  }
}

async function readReadOnlyPartnerDiagnostics(args, refreshedKnowledge = null) {
  const [cachedOwnerKnowledge, partnerCli] = await Promise.all([
    readVerifiedOwnerKnowledgeCacheDiagnostic(args).catch(error => ({
      ok: false,
      verified: false,
      source: 'diagnostic-error',
      errorCode: String(error?.code || 'OWNER_KNOWLEDGE_CACHE_DIAGNOSTIC_FAILED'),
    })),
    readLocalPartnerCliDiagnostic(),
  ]);
  const ownerKnowledge = refreshedKnowledge?.source === 'stale-verified-cache'
    ? {
        ...cachedOwnerKnowledge,
        source: refreshedKnowledge.source,
        stale: true,
        checkedAt: refreshedKnowledge.checkedAt || cachedOwnerKnowledge.checkedAt,
      }
    : cachedOwnerKnowledge;
  return {
    refreshAttempted: Boolean(refreshedKnowledge),
    refreshPolicy: refreshedKnowledge ? 'live-then-verified-cache' : 'read-only-verified-cache',
    ownerKnowledge,
    partnerCli,
  };
}

function print(data, pretty = false) {
  if (activeOwnerKnowledge?.source === 'stale-verified-cache'
    && data && typeof data === 'object' && !Array.isArray(data)) {
    data = {
      ...data,
      ownerKnowledge: {
        source: activeOwnerKnowledge.source,
        stale: true,
        checkedAt: activeOwnerKnowledge.checkedAt || null,
      },
    };
  }
  if (!pretty) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data?.tasks)) {
    for (const task of data.tasks) {
      console.log(`${task.id}\t${task.status}\t${(task.targets?.stores || []).join('/')}\t${task.preview?.summary || task.command || ''}`);
    }
    return;
  }
  if (Array.isArray(data?.rows) && data?.counts) {
    const safe = data?.safety?.safeWriteOperations || {};
    const whitelist = data?.safety?.realSubmitWhitelist || {};
    console.log(`OpenAPI 总账：${data.counts.apiConnected ?? data.counts.authorized ?? 0}/${data.counts.total || data.rows.length} API 已接通，${data.counts.writePrecheckReady || 0} 店可系统检查，${data.counts.actorControlledSubmitReady ?? 0} 店当前账号可受控提交`);
    console.log(`真实写总闸门：${safe.enabled ? '开启' : '关闭'}；人员权限：按当前 BI 账号 writeStores 校验；权限模式=${whitelist.mode || 'account_write_scope'}`);
    for (const row of data.rows) {
      const actions = (Array.isArray(row.actionCapabilities) ? row.actionCapabilities : [])
        .map(action => {
          const state = action.realSubmitSupported ? '可真提交' : (action.precheckSupported ? '仅预检' : '任务池');
          const blockers = Array.isArray(action.realSubmitBlockers) && action.realSubmitBlockers.length
            ? `；缺口=${action.realSubmitBlockers.join('/')}`
            : '';
          return `${action.label}:${state}${blockers}`;
        })
        .join(' | ');
      const wl = row.realSubmitWhitelist || {};
      const wlText = wl.configured ? '账号可写' : '账号不可写';
      console.log(`${row.storeKey}\t${row.status || '-'}\t${wlText}\t${actions}`);
    }
    return;
  }
  if (Array.isArray(data?.checks) && data?.generatedAt) {
    console.log(`BI Ops Doctor：${data.ok ? '通过' : '未通过'}  ${data.baseUrl || ''}`);
    if (data.user) {
      console.log(`当前账号：${data.user.username || '-'} · ${data.user.displayName || '-'} · ${data.user.role || '-'}`);
      console.log(`写权限：${Array.isArray(data.user.writeStores) ? data.user.writeStores.join(',') : '-'}`);
    }
    if (data.counts) {
      console.log(`OpenAPI：${data.counts.apiConnected ?? data.counts.authorized ?? 0}/${data.counts.total || 0} API 已接通，${data.counts.writePrecheckReady || 0} 可系统检查，${data.counts.actorControlledSubmitReady ?? 0} 当前账号可受控提交`);
    }
    const safe = data.safety?.safeWriteOperations || {};
    const whitelist = data.safety?.realSubmitWhitelist || {};
    console.log(`真实写：总闸门=${safe.enabled ? '开启' : '关闭'}，账号店铺权限=${whitelist.mode || 'account_write_scope'}，静默写=${data.safety?.canSilentWrite ? '是' : '否'}`);
    if (data.requestedActionReadiness) {
      const readiness = data.requestedActionReadiness;
      console.log(`动作诊断：${readiness.operation} · ${readiness.requireRealSubmit ? '要求真实提交' : '要求可 dry-run'} · dry-run=${readiness.allCanDryRun ? '是' : '否'} · 真实提交=${readiness.allCanRealSubmitAfterPreflight ? '是' : '否'}`);
      for (const item of readiness.items || []) {
        const blockerText = Array.isArray(item.blockers) && item.blockers.length ? `；阻断=${item.blockers.join('/')}` : '';
        console.log(`  - ${item.storeKey}: 建任务=${item.canCreateTask ? '是' : '否'}，dry-run=${item.canDryRun ? '是' : '否'}，真实提交=${item.canRealSubmitAfterPreflight ? '是' : '否'}${blockerText}`);
      }
    }
    for (const check of data.checks) {
      console.log(`${check.ok ? '✓' : '✗'} ${check.label}${check.error ? `：${check.error}` : ''}`);
    }
    console.log(data.nextStep || '');
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function mimeForImageFile(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

async function fileToCloudUploadBody(file) {
  const abs = path.resolve(String(file || ''));
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  const bytes = await fs.readFile(abs);
  return {
    name: path.basename(abs),
    type: mimeForImageFile(abs),
    size: bytes.length,
    dataBase64: bytes.toString('base64'),
  };
}

function taskTargets(args) {
  const targets = {};
  if (args.stores.length) targets.stores = [...new Set(args.stores)];
  if (args.sourceStores.length) targets.sourceStores = [...new Set(args.sourceStores)];
  if (args.sourceSkcs.length) {
    const sourceSkcs = [...new Set(args.sourceSkcs)];
    if (sourceSkcs.length !== 1) throw new Error('--source-skc requires exactly one case-sensitive SKC');
    if ([...new Set(args.sourceStores)].length !== 1) throw new Error('--source-skc requires exactly one --source-store');
    targets.sourceSkc = sourceSkcs[0];
  }
  if (args.writeStores.length) targets.writeStores = [...new Set(args.writeStores)];
  if (args.products.length) targets.productRefs = [...new Set(args.products)];
  return targets;
}

async function runLockSource(args) {
  if (!args.taskId) throw new Error('lock-source requires --task-id <id>');
  const sourceStores = [...new Set((args.sourceStores || []).map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
  const sourceSkcs = [...new Set((args.sourceSkcs || []).map(x => String(x || '').trim()).filter(Boolean))];
  if (sourceStores.length !== 1) throw new Error('lock-source requires exactly one --source-store');
  if (sourceSkcs.length !== 1) throw new Error('lock-source requires exactly one case-sensitive --source-skc');
  const {json: taskListJson} = await request(args, '/api/link-ops-tasks?limit=500');
  const currentTask = (taskListJson?.data?.tasks || []).find(task => String(task?.id || '') === args.taskId) || null;
  if (!currentTask) throw new Error('当前账号无法精确读取目标 task，源链接未锁定');
  const liveRevision = Number(currentTask.repositoryRevision || 0);
  if (!Number.isSafeInteger(liveRevision) || liveRevision <= 0) throw new Error('目标 task 未返回可用于 CAS 的正整数 repositoryRevision，源链接未锁定');
  const {json} = await request(args, '/api/link-ops-tasks', {
    method: 'PATCH',
    body: {
      id: args.taskId,
      event: 'lock_source_skc_cli',
      sourceStore: sourceStores[0],
      sourceSkc: sourceSkcs[0],
      expectedRevision: liveRevision,
    },
  });
  const locked = json?.task?.targets || {};
  if (locked.sourceSkc !== sourceSkcs[0] || (locked.sourceStores || []).length !== 1 || locked.sourceStores[0] !== sourceStores[0]) {
    throw new Error('云端未精确回读 sourceStore/sourceSkc 锁，已停止');
  }
  const {json: preflightJson} = await request(args, '/api/link-ops-execute', {
    method: 'POST',
    body: {id: args.taskId, mode: 'dry-run', source: 'codex_desktop_cli_lock_source'},
    allowJsonFailure: true,
  });
  const preflightResponse = linkOpsExecutionResponse(preflightJson, {fallbackTask: json.task});
  print({
    ok: true,
    aiInvoked: false,
    taskId: args.taskId,
    lockedSource: {sourceStore: sourceStores[0], sourceSkc: sourceSkcs[0]},
    preflightReady: preflightResponse.ok,
    preflightResult: linkOpsExecutionSummary(preflightResponse),
    task: preflightResponse.task,
    execution: preflightResponse.execution,
    safety: {realPublishOccurred: false, nextStep: '核对精确源链接证据与新 payloadHash；用户确认前不得 execute。'},
  });
}

function taskParameters(args) {
  const parameters = {};
  if (Number.isFinite(args.inventory)) parameters.inventory = args.inventory;
  if (Number.isFinite(args.supplyPrice)) parameters.supplyPrice = args.supplyPrice;
  if (Number.isFinite(args.productPrice)) parameters.productPrice = args.productPrice;
  if (args.titleEn) parameters.title = args.titleEn;
  if (args.titleAr) parameters.titleAr = args.titleAr;
  if (args.standardGoodsSn) parameters.standardGoodsSn = args.standardGoodsSn;
  if (args.note) parameters.actionNote = args.note;
  return parameters;
}

function hasStoreAccess(user, field, storeKey) {
  const list = Array.isArray(user?.[field]) ? user[field].map(x => String(x || '').trim().toUpperCase()).filter(Boolean) : [];
  return list.includes('*') || list.includes(String(storeKey || '').trim().toUpperCase());
}

function requestedDoctorStores(args, capabilitiesJson) {
  const explicit = [...new Set([
    ...(args.writeStores || []),
    ...(args.stores || []),
  ].map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
  if (explicit.length) return explicit;
  if (!args.operation) return [];
  return (Array.isArray(capabilitiesJson?.rows) ? capabilitiesJson.rows : [])
    .map(row => String(row.storeKey || '').trim().toUpperCase())
    .filter(Boolean);
}

function buildActionReadiness(args, meJson, capabilitiesJson) {
  if (!args.operation) return null;
  const rows = Array.isArray(capabilitiesJson?.rows) ? capabilitiesJson.rows : [];
  const rowsByStore = new Map(rows.map(row => [String(row.storeKey || '').trim().toUpperCase(), row]));
  const user = meJson?.user || {};
  const sourceStores = [...new Set((args.sourceStores || []).map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
  const stores = requestedDoctorStores(args, capabilitiesJson);
  const items = stores.map(storeKey => {
    const row = rowsByStore.get(storeKey) || null;
    const actions = Array.isArray(row?.actionCapabilities) ? row.actionCapabilities : [];
    const action = actions.find(x => String(x.key || x.intent || '').trim() === args.operation) || null;
    const accountCanWrite = hasStoreAccess(user, 'writeStores', storeKey);
    const accountCanReadTargets = hasStoreAccess(user, 'readStores', storeKey);
    const unreadableSources = sourceStores.filter(src => !hasStoreAccess(user, 'readStores', src));
    const sourceReadable = unreadableSources.length === 0;
    const precheckSupported = Boolean(action?.precheckSupported);
    const realSubmitSupported = Boolean(action?.realSubmitSupported);
    const blockers = [];
    if (!row) blockers.push('能力总账里没有这个店铺');
    if (row && !action) blockers.push(`能力总账里没有动作 ${args.operation}`);
    if (!accountCanReadTargets) blockers.push('当前账号没有目标店铺读权限');
    if (!accountCanWrite) blockers.push('当前账号没有目标店铺写权限');
    if (!sourceReadable) blockers.push(`当前账号没有来源店铺读权限：${unreadableSources.join(',')}`);
    if (action && !precheckSupported) blockers.push('该动作当前不支持自动预检');
    if (action && precheckSupported && !realSubmitSupported) blockers.push(...(Array.isArray(action.realSubmitBlockers) && action.realSubmitBlockers.length
      ? action.realSubmitBlockers
      : ['该动作当前只支持 dry-run/预检，不支持真实提交']));
    const canCreateTask = accountCanWrite && accountCanReadTargets && sourceReadable;
    const canDryRun = canCreateTask && precheckSupported;
    const canRealSubmitAfterPreflight = canDryRun && realSubmitSupported;
    return {
      storeKey,
      operation: args.operation,
      accountCanWrite,
      accountCanReadTargets,
      sourceStores,
      sourceReadable,
      precheckSupported,
      realSubmitSupported,
      canCreateTask,
      canDryRun,
      canRealSubmitAfterPreflight,
      state: action?.state || '',
      reason: action?.reason || row?.note || '',
      nextStep: action?.nextStep || '',
      blockers: [...new Set(blockers)],
    };
  });
  const allCanRealSubmit = items.length > 0 && items.every(x => x.canRealSubmitAfterPreflight);
  const allCanDryRun = items.length > 0 && items.every(x => x.canDryRun);
  return {
    operation: args.operation,
    requestedStores: stores,
    requireRealSubmit: args.requireRealSubmit,
    allCanDryRun,
    allCanRealSubmitAfterPreflight: allCanRealSubmit,
    okForRequestedLevel: args.requireRealSubmit ? allCanRealSubmit : allCanDryRun,
    items,
  };
}

async function doctorCheck(label, fn, {critical = true} = {}) {
  try {
    const value = await fn();
    return {label, ok: true, critical, ...value};
  } catch (err) {
    return {
      label,
      ok: false,
      critical,
      error: err?.message || String(err),
      status: err?.status || null,
      response: err?.response ? {
        ok: err.response.ok,
        error: err.response.error || '',
        status: err.response.status || null,
      } : null,
    };
  }
}

async function runDoctor(args) {
  const checks = [];
  const nodeMajor = Number(String(process.versions.node || '').split('.')[0] || 0);
  const session = await readSession(args.sessionFile);
  let sessionText = '';
  try {
    sessionText = await fs.readFile(args.sessionFile, 'utf8');
  } catch {}

  checks.push({
    label: 'local-node',
    ok: nodeMajor >= 20,
    critical: true,
    node: process.version,
    message: nodeMajor >= 20 ? 'Node.js 版本符合建议要求。' : '建议安装 Node.js 20 或更高版本。',
  });
  checks.push({
    label: 'session-file',
    ok: Boolean(session.cookie),
    critical: true,
    sessionFile: args.sessionFile,
    exists: Boolean(sessionText),
    baseUrl: session.baseUrl || '',
    savedAt: session.savedAt || '',
    storesPlaintextPassword: /"password"\s*:|password=|owner-cli-pass|operator-cli-pass/i.test(sessionText),
  });
  if (checks.at(-1).storesPlaintextPassword) checks.at(-1).ok = false;

  let meJson = null;
  let capabilitiesJson = null;
  checks.push(await doctorCheck('auth-me', async () => {
    const {json} = await request(args, '/api/auth/me');
    meJson = json;
    const user = json.user || {};
    return {
      username: user.username || '',
      displayName: user.displayName || '',
      role: user.role || '',
      readStores: user.readStores || [],
      writeStores: user.writeStores || [],
    };
  }));
  checks.push(await doctorCheck('openapi-capabilities', async () => {
    const {json} = await request(args, '/api/openapi-capabilities');
    capabilitiesJson = json;
    return {
      totalStores: json.counts?.total || json.rows?.length || 0,
      authorizedStores: json.counts?.authorized || 0,
      readReadyStores: json.counts?.readReady || 0,
      writeConfirmableStores: json.counts?.writeConfirmable || 0,
      safeWriteEnabled: Boolean(json.safety?.safeWriteOperations?.enabled),
      realSubmitWhitelistEnabled: Boolean(json.safety?.realSubmitWhitelist?.enabled),
      canSilentWrite: Boolean(json.safety?.canSilentWrite),
    };
  }));
  checks.push(await doctorCheck('task-pool', async () => {
    const {json} = await request(args, '/api/link-ops-tasks?limit=1');
    return {
      reachable: true,
      taskCountVisible: Array.isArray(json.data?.tasks) ? json.data.tasks.length : 0,
    };
  }));

  const actionReadiness = buildActionReadiness(args, meJson, capabilitiesJson);
  if (actionReadiness) {
    checks.push({
      label: args.requireRealSubmit ? 'action-real-submit-readiness' : 'action-dry-run-readiness',
      ok: actionReadiness.okForRequestedLevel,
      critical: Boolean(args.requireRealSubmit),
      operation: actionReadiness.operation,
      requestedStores: actionReadiness.requestedStores,
      allCanDryRun: actionReadiness.allCanDryRun,
      allCanRealSubmitAfterPreflight: actionReadiness.allCanRealSubmitAfterPreflight,
    });
  }

  const ok = checks.every(check => check.ok || !check.critical);
  return {
    ok,
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    sessionFile: args.sessionFile,
    user: meJson?.user || null,
    safety: capabilitiesJson?.safety ? {
      safeWriteOperations: capabilitiesJson.safety.safeWriteOperations,
      realSubmitWhitelist: capabilitiesJson.safety.realSubmitWhitelist,
      canSilentWrite: Boolean(capabilitiesJson.safety.canSilentWrite),
    } : null,
    counts: capabilitiesJson?.counts || null,
    requestedActionReadiness: actionReadiness,
    checks,
    nextStep: ok
      ? (actionReadiness
        ? (actionReadiness.okForRequestedLevel
          ? '所选账号/店铺/动作达到请求的可用级别；真实提交仍必须先 dry-run、进入待复核、输入确认文本并通过服务端回读。'
          : '本机 CLI 连通正常，但所选账号/店铺/动作没有达到请求的可用级别；查看 requestedActionReadiness.items[].blockers。')
        : '本机 CLI 到云端 BI 的账号、权限和只读接口自检通过。创建/预检/执行仍按服务端权限、确认文本和审计边界执行。')
      : '按 failed checks 处理：通常是未登录、session 过期、Node 版本过低或云端接口不可达。',
  };
}

function runLocalNodeScript(scriptRel, scriptArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptRel, ...scriptArgs], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

function assertLocalOpenApiExecutorAllowed(args, action, {allowDryRunForTests = true} = {}) {
  const mode = args.mode || 'dry-run';
  if (LOCAL_OPENAPI_TEST_OVERRIDE && (allowDryRunForTests || mode === 'dry-run')) return;
  if (mode === 'dry-run' && allowDryRunForTests && (args.openapiConfigFile || args.openapiStoreTruthFile)) {
    throw new Error(`${action} dry-run with --openapi-config is a bottom-level adapter smoke-test path. Set SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR=1 only for fake OpenAPI tests; do not use bi_ops_cli to prepare real SHEIN calls locally.`);
  }
  throw new Error(`${action} cannot run local SHEIN OpenAPI through bi_ops_cli. This machine is outside the SHEIN OpenAPI whitelist boundary; use the shein-bi-tencent cloud BI executor for real upload/submit/readback.`);
}

async function runMaintenanceReadiness(args) {
  const commandArgs = ['--operation', args.operation || 'retire_link'];
  if (args.docEvidenceFile) commandArgs.push('--doc-evidence', args.docEvidenceFile);
  if (args.storeProbeFile) commandArgs.push('--store-probe', args.storeProbeFile);
  if (args.readbackEvidenceFile) commandArgs.push('--readback-evidence', args.readbackEvidenceFile);
  if (args.expect) commandArgs.push('--expect', args.expect);
  if (!args.json) commandArgs.push('--pretty');
  const result = await runLocalNodeScript('scripts/check_bi_ops_maintenance_readiness.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runImageAssetExecutor(args, action) {
  const store = [...new Set([...(args.stores || []), ...(args.writeStores || [])])][0] || '';
  if (!store) throw new Error(`${action} requires --store <店铺>`);
  if (!args.imageType) throw new Error(`${action} requires --image-type <1|2|5|6|7>`);
  const mode = args.mode || 'dry-run';
  const shouldUseCloud = mode === 'execute' && !args.openapiConfigFile && !args.openapiStoreTruthFile;
  if (shouldUseCloud) {
    const body = {store, imageType: args.imageType};
    if (action === 'upload-pic') {
      if (!args.imageFile) throw new Error('upload-pic requires --file <image.jpg|png>');
      body.file = await fileToCloudUploadBody(args.imageFile);
    } else {
      if (!args.imageUrl) throw new Error('transform-pic requires --url <https://...>');
      body.url = args.imageUrl;
    }
    const {json} = await request(args, `/api/openapi-image-asset/${action}`, {
      method: 'POST',
      body,
    });
    print(json);
    return;
  }
  assertLocalOpenApiExecutorAllowed(args, action);
  const commandArgs = [action, '--store', store, '--image-type', String(args.imageType), '--mode', args.mode || 'dry-run'];
  if (args.openapiConfigFile) commandArgs.push('--config', args.openapiConfigFile);
  if (args.openapiStoreTruthFile) commandArgs.push('--store-truth', args.openapiStoreTruthFile);
  if (action === 'upload-pic') {
    if (!args.imageFile) throw new Error('upload-pic requires --file <image.jpg|png>');
    commandArgs.push('--file', args.imageFile);
  } else {
    if (!args.imageUrl) throw new Error('transform-pic requires --url <https://...>');
    commandArgs.push('--url', args.imageUrl);
  }
  const result = await runLocalNodeScript('scripts/openapi_image_asset_executor.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runPlanImages(args) {
  if (!args.imageDir) throw new Error('plan-images requires --image-dir <图片文件夹>');
  const commandArgs = ['--dir', args.imageDir];
  const store = [...new Set([...(args.writeStores || []), ...(args.stores || [])])][0] || '';
  if (store) commandArgs.push('--store', store);
  if (args.approvedAssets) commandArgs.push('--approved');
  if (args.outputFile) commandArgs.push('--out', args.outputFile);
  if (!args.json) commandArgs.push('--pretty');
  const result = await runLocalNodeScript('scripts/link_ops_plan_image_roles.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

function publishPreparationFromArgs(args) {
  if (args.supplyPrice !== null && !Number.isFinite(args.supplyPrice)) throw new Error('--supply-price must be a number');
  if (args.inventory !== null && (!Number.isFinite(args.inventory) || args.inventory < 0 || !Number.isInteger(args.inventory))) {
    throw new Error('--inventory must be a non-negative integer');
  }
  if (args.inputCurrentMa !== null && (!Number.isFinite(args.inputCurrentMa) || args.inputCurrentMa <= 0)) {
    throw new Error('--input-current-ma must be a positive number');
  }
  if (args.inputCurrentA !== null && (!Number.isFinite(args.inputCurrentA) || args.inputCurrentA <= 0)) {
    throw new Error('--input-current-a must be a positive number');
  }
  if (args.inputCurrentMa !== null && args.inputCurrentA !== null) {
    throw new Error('--input-current-ma and --input-current-a are mutually exclusive');
  }
  if (args.inputCurrentValueId && !/^[1-9]\d*$/.test(args.inputCurrentValueId)) {
    throw new Error('--input-current-value-id must be a positive integer');
  }
  if (args.inputCurrentValueId && args.inputCurrentMa === null && args.inputCurrentA === null) {
    throw new Error('--input-current-value-id requires --input-current-ma or --input-current-a');
  }
  const categoryId = String(args.categoryId || '').trim();
  if (categoryId && (!/^\d+$/.test(categoryId) || Number(categoryId) <= 0)) throw new Error('--category-id must be a positive integer');
  const titleGroup = String(args.titleGroup || '').trim().toLowerCase();
  if (titleGroup && !/^title[123]$/.test(titleGroup)) throw new Error('--title-group must be title1, title2 or title3');
  return {
    titleGroup,
    standardGoodsSn: args.standardGoodsSn || '',
    supplierSku: args.supplierSkuList[0] || '',
    supplyPrice: args.supplyPrice,
    inventory: args.inventory,
    categoryId: categoryId ? Number(categoryId) : null,
    titleAr: args.titleAr || '',
    titleEn: args.titleEn || '',
    attributeOverrides: args.inputCurrentMa === null && args.inputCurrentA === null ? [] : [{
      attribute_id: 1002323,
      attribute_extra_value: args.inputCurrentA !== null
        ? String(args.inputCurrentA)
        : String(Math.round(args.inputCurrentMa)),
      attribute_unit: args.inputCurrentA !== null ? 'A' : 'mA',
      ...(args.inputCurrentValueId ? {attribute_value_id: args.inputCurrentValueId} : {}),
      label: '输入电流',
      source: 'explicit_prepare_publish',
    }],
  };
}

function preparedImageAssignments(plan) {
  const roles = plan?.roles || {};
  const rows = [];
  const add = (item, role, imageType, order) => {
    if (!item?.path) return;
    rows.push({
      name: item.name || path.basename(item.path),
      path: item.path,
      relativePath: item.relativePath || item.name || '',
      role,
      imageType,
      order,
      width: Number(item.width || 0),
      height: Number(item.height || 0),
    });
  };
  add(roles.mainCover, 'mainCover', 1, 0);
  add(roles.carouselSecondCover, 'carouselSecondCover', 1, 10);
  for (const [index, item] of (roles.otherDetailImages || []).entries()) add(item, 'detail', 2, 20 + index);
  add(roles.squareImage, 'squareImage', 5, 100);
  add(roles.skuImage, 'skuImage', 1, 110);
  const seen = new Set();
  return rows.filter(row => {
    const key = path.resolve(row.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.order - b.order);
}

async function runPreparePublish(args) {
  if (!args.taskId) throw new Error('prepare-publish requires --task-id <id>');
  if (args.allowEmptyDescription) {
    if (args.emptyDescriptionConfirm !== EMPTY_DESCRIPTION_CONFIRM_TEXT) {
      throw new Error(`--allow-empty-description 必须同时携带 --empty-description-confirm ${EMPTY_DESCRIPTION_CONFIRM_TEXT}`);
    }
  } else if (args.emptyDescriptionConfirm) {
    throw new Error('--empty-description-confirm 只能与 --allow-empty-description 同时使用');
  }
  if (args.reuseApprovedBinding) {
    if (args.imageDir) throw new Error('--reuse-approved-binding 与 --image-dir 互斥：复用服务端已审绑定时不扫描、不读取、不上传本地图片');
    if (args.sourceTaskId) throw new Error('--reuse-approved-binding 仅服务 copy_product_draft 发布准备；不能用于 update_images 维护任务的 --source-task-id 模式');
  } else if (!args.imageDir) {
    throw new Error('prepare-publish requires --image-dir <reviewed image folder>（或加 --reuse-approved-binding 复用该任务的已审图片绑定）');
  }
  const store = [...new Set([...(args.writeStores || []), ...(args.stores || [])])][0] || '';
  if (!store) throw new Error('prepare-publish requires --store <target store>');
  const publishPreparation = publishPreparationFromArgs(args);
  let plan = null;
  let uploaded = [];
  let bindingJson = null;
  if (args.reuseApprovedBinding) {
    ({json: bindingJson} = await request(args, '/api/link-ops-publish-assets', {
      method: 'POST',
      body: {
        taskId: args.taskId,
        store,
        sourceApproved: true,
        reuseApprovedBinding: true,
        bindings: [],
        publishPreparation,
        ...(args.allowEmptyDescription ? {
          allowEmptyDescription: true,
          emptyDescriptionConfirm: args.emptyDescriptionConfirm,
        } : {}),
      },
    }));
  } else {
    plan = await planLinkOpsImageRoles({dir: args.imageDir, sourceApproved: args.approvedAssets ? true : null, storeKey: store});
    const sourceApproved = args.approvedAssets || plan.approval?.sourceApproved === true;
    if (!sourceApproved) throw new Error('图片目录未标记为“已审可用”；请确认人工审核后加 --approved-assets');
    if (!plan.ok) throw new Error(`图片角色规划未通过：${(plan.blockers || []).join('；')}`);
    if (!plan.roles?.squareImage) throw new Error('读取真实图片尺寸后仍未找到 1:1 方形图，已在上传前停止');
    const assignments = preparedImageAssignments(plan);
    if (!assignments.length) throw new Error('没有可上传并绑定的审核图片');
    try {
      for (const [index, assignment] of assignments.entries()) {
        const file = await fileToCloudUploadBody(assignment.path);
        if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error(`SHEIN upload-pic 不支持该格式：${assignment.name}`);
        if (!args.json) process.stderr.write(`上传审核图片 ${index + 1}/${assignments.length}：${assignment.name}\n`);
        const {json} = await request(args, '/api/openapi-image-asset/upload-pic', {
          method: 'POST',
          body: {store, imageType: assignment.imageType, file},
        });
        const imageUrl = String(json?.result?.imageUrl || json?.adapterResult?.result?.imageUrl || '').trim();
        if (!imageUrl) throw new Error(`云端上传没有返回 imageUrl：${assignment.name}`);
        const bytes = await fs.readFile(assignment.path);
        uploaded.push({
          ...assignment,
          path: undefined,
          imageUrl,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        });
      }
    } catch (error) {
      error.response = {ok: false, uploadedBeforeFailure: uploaded.map(row => ({name: row.name, role: row.role, imageUrl: row.imageUrl}))};
      throw error;
    }
    ({json: bindingJson} = await request(args, '/api/link-ops-publish-assets', {
      method: 'POST',
      body: {
        taskId: args.taskId,
        store,
        sourceApproved: true,
        sourceDirLabel: path.basename(args.imageDir),
        bindings: uploaded,
        publishPreparation,
        ...(args.allowEmptyDescription ? {
          allowEmptyDescription: true,
          emptyDescriptionConfirm: args.emptyDescriptionConfirm,
        } : {}),
        sourceTaskId: args.sourceTaskId || '',
        productIdentity: {
          spuName: args.spuList[0] || '',
          skcName: args.skcList[0] || '',
          skuCodes: args.skuCodeList || [],
        },
      },
    }));
  }
  if (!String(bindingJson?.binding?.payloadSource || '').startsWith('task')) throw new Error('云端没有确认图片 payload 已绑定到同一 task，已停止重新预演');
  const {json: preflightJson} = await request(args, '/api/link-ops-execute', {
    method: 'POST',
    body: {id: args.taskId, mode: 'dry-run', source: 'codex_desktop_cli_prepare_publish'},
    allowJsonFailure: true,
  });
  const preflightResponse = linkOpsExecutionResponse(preflightJson);
  const reused = args.reuseApprovedBinding;
  print({
    ok: true,
    taskId: args.taskId,
    store,
    sourceApproved: true,
    reuseApprovedBinding: reused,
    plan: reused ? {
      source: 'existing_task_publishAssetBinding',
      sourceDir: '',
      scannedImages: 0,
      eligibleImages: 0,
      ignoredAbTestCovers: [],
      storeStyle: null,
      warnings: [],
    } : {
      sourceDir: plan.sourceDir,
      scannedImages: plan.counts?.scannedImages || 0,
      eligibleImages: plan.counts?.eligibleImages || 0,
      ignoredAbTestCovers: plan.roles?.ignoredAbTestCovers?.map(row => row.name) || [],
      storeStyle: plan.storeStyle || null,
      warnings: plan.warnings || [],
    },
    uploaded: uploaded.map(row => ({name: row.name, role: row.role, imageType: row.imageType, width: row.width, height: row.height, sha256: row.sha256})),
    binding: bindingJson.binding,
    preflightReady: preflightResponse.ok,
    preflightResult: linkOpsExecutionSummary(preflightResponse),
    task: preflightResponse.task,
    execution: preflightResponse.execution,
    safety: {
      sameTask: true,
      payloadSource: bindingJson.binding.payloadSource,
      realPublishOccurred: false,
      uploadedImageCount: uploaded.length,
      reusedApprovedBinding: reused,
      emptyDescriptionAuthorized: bindingJson?.binding?.emptyDescriptionAuthorization?.ok === true,
      nextStep: '核对新预演的 payloadHash 和字段；只有用户明确确认后才调用 execute。',
    },
  });
}

async function runPrepareDescriptions(args) {
  if (!args.taskId) throw new Error('prepare-descriptions requires --task-id <id>');
  if (!args.sourceFile) throw new Error('prepare-descriptions requires --source-file <实际审核资料HTML或普通OOXML DOCX>');
  const store = [...new Set([...(args.writeStores || []), ...(args.stores || [])])][0] || '';
  if (!store) throw new Error('prepare-descriptions requires --store <target store>');
  const section = String(args.section || 'auto').trim().toLowerCase();
  if (!['s09', 's9', 'auto'].includes(section)) {
    throw new Error(`prepare-descriptions --section 必须是 auto/s09/s9（当前 ${section || '(empty)'}）`);
  }
  const expectedRevisionProvided = args.expectedRevision !== null;
  if (expectedRevisionProvided
    && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision <= 0)) {
    throw new Error('prepare-descriptions --expected-revision 必须是正安全整数，描述未绑定');
  }
  const explicitExpectedRevision = expectedRevisionProvided ? args.expectedRevision : null;
  let sourceBytes;
  try {
    sourceBytes = await fs.readFile(args.sourceFile);
  } catch {
    throw new Error(`无法读取审核资料文件：${path.basename(args.sourceFile) || '(unknown)'}`);
  }
  const isDocx = /\.docx$/i.test(path.basename(args.sourceFile));
  const htmlText = isDocx ? '' : sourceBytes.toString('utf8');
  let providedMaterial = null;
  if (args.materialJsonFile) {
    providedMaterial = JSON.parse(await fs.readFile(args.materialJsonFile, 'utf8'));
  }
  const verified = isDocx
    ? verifyDescriptionMaterialAgainstDocx(sourceBytes, {
        material: providedMaterial,
        sourceFileBasename: path.basename(args.sourceFile),
        sourceFileSha256: providedMaterial?.sourceFileSha256 || '',
        section,
      })
    : verifyDescriptionMaterialAgainstHtml(htmlText, sourceBytes, {
        material: providedMaterial,
        sourceFileBasename: path.basename(args.sourceFile),
        sourceFileSha256: providedMaterial?.sourceFileSha256 || '',
        section,
      });
  const material = validateDescriptionMaterialJson(verified.material);
  const summary = describeDescriptionMaterial(material);
  const sourceProof = verified.sectionUsed === 'docx'
    ? DESCRIPTION_SOURCE_PROOF_DOCX
    : verified.sectionUsed === 's9'
      ? DESCRIPTION_SOURCE_PROOF_S9
      : DESCRIPTION_SOURCE_PROOF;
  const {json: taskListJson} = await request(args, '/api/link-ops-tasks?limit=500');
  const currentTask = (taskListJson?.data?.tasks || []).find(task => String(task?.id || '') === args.taskId) || null;
  if (!currentTask) throw new Error('当前账号无法精确读取目标 task，描述未绑定');
  const liveRevision = Number(currentTask.repositoryRevision || 0);
  if (!Number.isSafeInteger(liveRevision) || liveRevision <= 0) {
    throw new Error('目标 task 未返回可用于 CAS 的正整数 repositoryRevision，描述未绑定');
  }
  const existingBinding = currentTask?.descriptionMaterialBinding && typeof currentTask.descriptionMaterialBinding === 'object'
    ? currentTask.descriptionMaterialBinding
    : null;
  // Strict description-binding lock validation. The server projection is
  // trusted only when it is exactly {baseTaskRevision,currentRevision,ok,stale}
  // with boolean ok/stale satisfying stale === !ok, positive safe-integer
  // revisions, base equal to the existing binding's baseTaskRevision and
  // current equal to the live repositoryRevision. Any missing or extra field,
  // type error, contradiction, or revision mismatch makes the lock UNKNOWN:
  // the CLI never guesses freshness and never replays an old base.
  const existingBaseRevision = existingBinding
    && Number.isSafeInteger(existingBinding.baseTaskRevision) && existingBinding.baseTaskRevision > 0
    ? existingBinding.baseTaskRevision
    : 0;
  const existingBindingLock = currentTask?.descriptionBindingLock && typeof currentTask.descriptionBindingLock === 'object'
    ? currentTask.descriptionBindingLock
    : null;
  const existingBindingLockKnown = Boolean(
    existingBindingLock
    && !Array.isArray(existingBindingLock)
    && Object.keys(existingBindingLock).sort().join(',') === 'baseTaskRevision,currentRevision,ok,stale'
    && typeof existingBindingLock.ok === 'boolean'
    && typeof existingBindingLock.stale === 'boolean'
    && existingBindingLock.stale === !existingBindingLock.ok
    && typeof existingBindingLock.baseTaskRevision === 'number'
    && Number.isSafeInteger(existingBindingLock.baseTaskRevision)
    && existingBindingLock.baseTaskRevision > 0
    && existingBindingLock.baseTaskRevision === existingBaseRevision
    && typeof existingBindingLock.currentRevision === 'number'
    && Number.isSafeInteger(existingBindingLock.currentRevision)
    && existingBindingLock.currentRevision > 0
    && existingBindingLock.currentRevision === liveRevision,
  );
  const existingBindingStale = existingBindingLockKnown && existingBindingLock.stale === true;
  const existingBindingRequestKey = Number.isSafeInteger(existingBaseRevision) && existingBaseRevision > 0
    ? descriptionBindingRequestKey({
        taskId: args.taskId,
        targetStore: store,
        baseTaskRevision: existingBaseRevision,
        contentSha256: summary.contentSha256,
        sourceProof,
      })
    : '';
  const existingLegacyS09BindingRequestKey = sourceProof === DESCRIPTION_SOURCE_PROOF
    && Number.isSafeInteger(existingBaseRevision) && existingBaseRevision > 0
    ? descriptionBindingRequestKey({
        taskId: args.taskId,
        targetStore: store,
        baseTaskRevision: existingBaseRevision,
        contentSha256: summary.contentSha256,
      })
    : '';
  const exactExistingBinding = Boolean(
    existingBinding
    && String(existingBinding.targetStore || '').toUpperCase() === store.toUpperCase()
    && String(existingBinding.sourceFileSha256 || '').toLowerCase() === summary.sourceFileSha256
    && String(existingBinding.contentSha256 || '').toLowerCase() === summary.contentSha256
    && String(existingBinding.sourceProof || '') === sourceProof
    && [existingBindingRequestKey, existingLegacyS09BindingRequestKey].filter(Boolean)
      .includes(String(existingBinding.bindingRequestKey || '').toLowerCase()),
  );
  // Replaying an existing binding identity is only safe when the server
  // proves the binding still locks the current payload. A stale lock rebinds
  // at the live revision; a missing lock state fails closed instead of
  // guessing, unless the operator explicitly pinned a revision.
  const idempotentReplay = exactExistingBinding && existingBindingLockKnown && !existingBindingStale;
  if (explicitExpectedRevision
    && explicitExpectedRevision !== liveRevision
    && !(idempotentReplay && explicitExpectedRevision === existingBaseRevision)) {
    throw new Error(`目标 task revision 已变化：命令期望 ${explicitExpectedRevision}，实时读取为 ${liveRevision}；描述未绑定`);
  }
  if (exactExistingBinding && !existingBindingLockKnown && !explicitExpectedRevision) {
    throw new Error(`目标 task 已存在同源审核描述绑定，但云端描述绑定锁未知或不符合严格规范（必须恰为 baseTaskRevision/currentRevision/ok/stale，ok/stale 为互反 boolean，且 base/current 分别为绑定基线与实时 revision），无法区分幂等重放与过期重绑；请显式传 --expected-revision ${liveRevision} 后重试（描述未绑定）`);
  }
  // When the previous request committed the binding but failed only while
  // appending external audit, replay the original request identity. Sending
  // the new task revision would create a new request key and bind twice.
  const requestRevision = idempotentReplay
    ? existingBaseRevision
    : (explicitExpectedRevision || liveRevision);
  const bindBody = {
    taskId: args.taskId,
    store,
    sourceApproved: true,
    materialJson: material,
    sourceFile: {
      name: path.basename(args.sourceFile),
      dataBase64: sourceBytes.toString('base64'),
    },
    expectedRevision: requestRevision,
    section,
  };
  let bindJson;
  try {
    ({json: bindJson} = await request(args, '/api/link-ops-prepare-descriptions', {
      method: 'POST',
      body: bindBody,
      allowJsonFailure: true,
    }));
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'prepare-descriptions',
      taskId: args.taskId,
      store,
      stage: 'binding_not_committed',
      bindingCommitted: false,
      code: error?.code || error?.response?.code || null,
      status: error?.status || null,
      error: String(error?.message || '描述绑定失败').slice(0, 500),
      material: {
        sourceLabel: summary.sourceLabel,
        sourceFileSha256: summary.sourceFileSha256,
        contentSha256: summary.contentSha256,
        lineCounts: summary.lineCounts,
        hashes: summary.hashes,
      },
    });
    process.exitCode = 1;
    return;
  }
  const binding = bindJson.binding || {};
  if (bindJson.bindingCommitted !== true || bindJson.readbackVerified !== true || bindJson.auditPending === true || bindJson.ok !== true) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'prepare-descriptions',
      taskId: args.taskId,
      store,
      stage: String(bindJson.stage || 'binding_state_uncertain'),
      bindingCommitted: bindJson.bindingCommitted === true,
      repositoryEventCommitted: bindJson.repositoryEventCommitted === true,
      readbackVerified: bindJson.readbackVerified === true,
      auditPending: bindJson.auditPending === true,
      material: {
        sourceLabel: summary.sourceLabel,
        sourceFileSha256: summary.sourceFileSha256,
        contentSha256: summary.contentSha256,
        lineCounts: summary.lineCounts,
        hashes: summary.hashes,
      },
      bound: {
        targetStore: String(binding.targetStore || ''),
        newPayloadHash: String(binding.newPayloadHash || ''),
        bindingRequestKey: String(binding.bindingRequestKey || ''),
      },
      safety: {realPublishOccurred: false, dryRunAttempted: false},
    });
    process.exitCode = 1;
    return;
  }
  if (String(bindJson?.task?.id || '') !== args.taskId) {
    throw new Error('云端没有确认描述绑定仍是同一 task，已停止重新预演');
  }
  if (String(binding.targetStore || '').toUpperCase() !== store.toUpperCase()) {
    throw new Error('云端描述绑定目标店铺与请求不一致，已停止重新预演');
  }
  for (const language of ['ar', 'en', 'zh-cn']) {
    if (String(binding.hashes?.[language] || '').toLowerCase() !== String(summary.hashes?.[language] || '').toLowerCase()) {
      throw new Error(`云端描述绑定 ${language} hash 与本地审核资料不一致，已停止重新预演`);
    }
  }
  if (String(binding.sourceFileSha256 || '').toLowerCase() !== summary.sourceFileSha256
    || String(binding.contentSha256 || '').toLowerCase() !== summary.contentSha256) {
    throw new Error('云端描述绑定的源文件/content hash 与本地审核资料不一致，已停止重新预演');
  }
  let preflightJson;
  try {
    ({json: preflightJson} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: args.taskId, mode: 'dry-run', source: 'codex_desktop_cli_prepare_descriptions'},
      allowJsonFailure: true,
    }));
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'prepare-descriptions',
      taskId: args.taskId,
      store,
      stage: 'binding_committed_dry_run_failed',
      bindingCommitted: true,
      readbackVerified: true,
      auditPending: false,
      code: error?.code || null,
      status: error?.status || null,
      error: String(error?.message || '重新预演失败').slice(0, 500),
      material: {
        sourceLabel: summary.sourceLabel,
        sourceFileSha256: summary.sourceFileSha256,
        contentSha256: summary.contentSha256,
        lineCounts: summary.lineCounts,
        hashes: summary.hashes,
      },
      bound: {
        targetStore: String(binding.targetStore || ''),
        newPayloadHash: String(binding.newPayloadHash || ''),
        bindingRequestKey: String(binding.bindingRequestKey || ''),
      },
      safety: {realPublishOccurred: false, retryBinding: false},
    });
    process.exitCode = 1;
    return;
  }
  const preflightResponse = linkOpsExecutionResponse(preflightJson);
  const execution = preflightResponse.execution;
  const productExecutor = execution.openApiProductExecutors?.[0] || execution.hlOpenApiExecutor || {};
  const payloadSummary = productExecutor.payload?.summary || {};
  const dryRun = {
    state: String(execution.state || ''),
    ok: execution.preflight?.ok === true,
    blockerCount: Array.isArray(execution.preflight?.blockers) ? execution.preflight.blockers.length : 0,
    payloadHash: productExecutor.payload?.payloadHash || '',
    descriptionCount: Number(payloadSummary.descriptionCount || 0),
    descriptionLanguages: Array.isArray(payloadSummary.descriptionLanguages) ? payloadSummary.descriptionLanguages : [],
    descriptionLineCounts: payloadSummary.descriptionLineCounts || {},
    descriptionHashes: payloadSummary.descriptionHashes || {},
    descriptionBindingLocked: payloadSummary.descriptionBindingLocked === true,
  };
  // Terminal output carries hashes/counts/languages only. Full description text
  // never leaves the local source file into CLI stdout.
  const preparedOutput = buildPrepareDescriptionsCliOutput({
    summary,
    binding: {...binding, sameTask: true},
    dryRun,
    taskId: args.taskId,
    store,
  });
  const output = {
    ...preparedOutput,
    ...linkOpsExecutionSummary(preflightResponse),
    ok: preparedOutput.ok === true && preflightResponse.ok,
    task: preflightResponse.task,
    execution: preflightResponse.execution,
  };
  print(output);
  applyLinkOpsExecutionExitCode(output);
}

async function runRefreshProductAttributeBinding(args, store) {
  if (args.donorStore || args.donorSkc || args.attributeId !== null || args.adoptExisting) {
    throw new Error('prepare-product-attribute --refresh-binding 禁止携带 --donor-store/--donor-skc/--attribute-id/--adopt-existing；donor/属性/模式完全来自持久化绑定');
  }
  const explicitKey = String(args.expectedBindingRequestKey || '').trim().toLowerCase();
  if (explicitKey && !/^[a-f0-9]{64}$/.test(explicitKey)) {
    throw new Error('prepare-product-attribute --expected-binding-request-key 必须是 64 位 sha256');
  }
  const expectedRevisionProvided = args.expectedRevision !== null;
  if (expectedRevisionProvided
    && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision <= 0)) {
    throw new Error('prepare-product-attribute --expected-revision 必须是正安全整数，刷新未执行');
  }
  const {json: taskListJson} = await request(args, '/api/link-ops-tasks?limit=500');
  const currentTask = (taskListJson?.data?.tasks || []).find(task => String(task?.id || '') === args.taskId) || null;
  if (!currentTask) throw new Error('当前账号无法精确读取目标 task，刷新未执行');
  const liveRevision = Number(currentTask.repositoryRevision || 0);
  if (!Number.isSafeInteger(liveRevision) || liveRevision <= 0) {
    throw new Error('目标 task 未返回可用于 CAS 的正整数 repositoryRevision，刷新未执行');
  }
  const binding = currentTask?.productAttributeBinding && typeof currentTask.productAttributeBinding === 'object'
    ? currentTask.productAttributeBinding
    : null;
  if (!binding) throw new Error('目标 task 没有 productAttributeBinding，刷新未执行');
  const expectedBindingRequestKey = explicitKey || String(binding.bindingRequestKey || '');
  if (!/^[a-f0-9]{64}$/.test(expectedBindingRequestKey)) {
    throw new Error('目标 task 的绑定缺少可用 bindingRequestKey，刷新未执行');
  }
  const refreshBody = {
    taskId: args.taskId,
    store,
    bindingMode: PRODUCT_ATTRIBUTE_REQUEST_MODE_REFRESH,
    expectedRevision: expectedRevisionProvided ? args.expectedRevision : liveRevision,
    expectedBindingRequestKey,
  };
  let bindJson;
  try {
    ({json: bindJson} = await request(args, '/api/link-ops-prepare-product-attribute', {
      method: 'POST',
      body: refreshBody,
      allowJsonFailure: true,
    }));
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'prepare-product-attribute',
      taskId: args.taskId,
      store,
      bindingMode: PRODUCT_ATTRIBUTE_REQUEST_MODE_REFRESH,
      stage: 'binding_not_committed',
      bindingCommitted: false,
      code: error?.code || error?.response?.code || null,
      status: error?.status || null,
      error: String(error?.message || '商品属性绑定证据刷新失败').slice(0, 500),
      safety: {realPublishOccurred: false, dryRunReadyClaimed: false, payloadMutated: false},
    });
    process.exitCode = 1;
    return;
  }
  const outBinding = bindJson.binding || {};
  const output = {
    ok: bindJson.bindingCommitted === true
      && bindJson.readbackVerified === true
      && bindJson.auditPending !== true
      && bindJson.ok === true,
    aiInvoked: false,
    command: 'prepare-product-attribute',
    taskId: args.taskId,
    store,
    bindingMode: PRODUCT_ATTRIBUTE_REQUEST_MODE_REFRESH,
    stage: String(bindJson.stage || 'binding_state_uncertain'),
    bindingCommitted: bindJson.bindingCommitted === true,
    repositoryEventCommitted: bindJson.repositoryEventCommitted === true,
    readbackVerified: bindJson.readbackVerified === true,
    auditPending: bindJson.auditPending === true,
    code: String(bindJson.code || ''),
    error: String(bindJson.error || '').slice(0, 500),
    eventKey: String(bindJson.eventKey || ''),
    binding: {
      schemaVersion: outBinding.schemaVersion ?? null,
      bindingMode: String(outBinding.bindingMode || ''),
      attributeId: outBinding.attributeId ?? null,
      attributeValueId: outBinding.attributeValueId ?? null,
      donorStore: String(outBinding.donorStore || ''),
      donorSkc: String(outBinding.donorSkc || ''),
      donorSpu: String(outBinding.donorSpu || ''),
      canonicalCode: String(outBinding.canonicalCode || ''),
      evidenceSha256: String(outBinding.evidenceSha256 || ''),
      oldPayloadHash: String(outBinding.oldPayloadHash || ''),
      newPayloadHash: String(outBinding.newPayloadHash || ''),
      bindingRequestKey: String(outBinding.bindingRequestKey || ''),
    },
    nextStep: bindJson.nextStep || {command: 'preflight', note: '刷新后重新预演。', realPublish: false},
    safety: {
      realPublishOccurred: false,
      dryRunReadyClaimed: false,
      payloadMutated: false,
      nextStep: '刷新本身不预演、不发布；请另行执行 preflight。',
    },
  };
  print(output);
  if (!output.ok) process.exitCode = 1;
}


async function runRecoverUploadedAssetBinding(args) {
  if (!args.taskId) throw new Error('recover-uploaded-asset-binding requires --task-id <id>');
  const confirm = String(args.confirm || '').trim();
  if (confirm !== RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT) {
    throw new Error(`recover-uploaded-asset-binding 必须携带 --confirm ${RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT}`);
  }
  const expectedPrepareBatchId = String(args.expectedPrepareBatchId || '').trim();
  if (!expectedPrepareBatchId || !/^[a-f0-9]{64}$/.test(expectedPrepareBatchId)) {
    throw new Error('recover-uploaded-asset-binding requires --prepare-batch-id <64位十六进制哈希>');
  }
  const uploadedImages = Array.isArray(args.uploadedImages) ? args.uploadedImages : [];
  if (uploadedImages.length !== 6) {
    throw new Error(`recover-uploaded-asset-binding requires exactly 6 repeated --uploaded-image name|url|sha256 parameters; received ${uploadedImages.length}`);
  }
  for (const [field, code] of [['name', 'filename'], ['imageUrl', 'URL'], ['sha256', 'SHA-256']]) {
    if (new Set(uploadedImages.map(row => row[field])).size !== 6) {
      throw new Error(`recover-uploaded-asset-binding --uploaded-image ${code} values must be unique`);
    }
  }
  const expectedRevisionProvided = args.expectedRevision !== null;
  if (expectedRevisionProvided
    && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision <= 0)) {
    throw new Error('recover-uploaded-asset-binding --expected-revision 必须是正安全整数');
  }
  let recoverJson;
  try {
    ({json: recoverJson} = await request(args, '/api/link-ops-recover-uploaded-asset-binding', {
      method: 'POST',
      body: {
        taskId: args.taskId,
        confirm,
        expectedPrepareBatchId,
        uploadedImages,
        ...(expectedRevisionProvided ? {expectedRevision: args.expectedRevision} : {}),
      },
      allowJsonFailure: true,
    }));
  } catch (error) {
    const response = error?.response && typeof error.response === 'object' ? error.response : {};
    const committedBinding = response.binding && typeof response.binding === 'object' ? response.binding : {};
    print({
      ok: false,
      aiInvoked: false,
      command: 'recover-uploaded-asset-binding',
      taskId: args.taskId,
      stage: String(response.stage || 'binding_not_recovered'),
      bindingCommitted: response.bindingCommitted === true,
      readbackVerified: response.readbackVerified === true,
      auditPending: response.auditPending === true,
      persistedRevision: response.persistedRevision ?? null,
      bindingFingerprint: String(committedBinding.bindingFingerprint || response.bindingFingerprint || ''),
      imageCount: Number(committedBinding.imageCount || (Array.isArray(committedBinding.images) ? committedBinding.images.length : 0)),
      roles: Array.isArray(committedBinding.images) ? committedBinding.images.map(image => image.role) : [],
      prepareBatchId: String(committedBinding.prepareBatchId || expectedPrepareBatchId),
      authority: String(committedBinding.authority || ''),
      code: error?.code || response.code || null,
      status: error?.status || null,
      error: String(error?.message || '已上传素材绑定恢复失败').slice(0, 500),
      safety: {realPublishOccurred: false, newUploadTriggered: false, newTaskCreated: false},
    });
    process.exitCode = 1;
    return;
  }

  const binding = recoverJson.binding || {};
  const output = {
    ok: recoverJson.ok === true
      && recoverJson.bindingCommitted === true
      && recoverJson.readbackVerified === true
      && recoverJson.auditPending !== true,
    aiInvoked: false,
    command: 'recover-uploaded-asset-binding',
    taskId: args.taskId,
    idempotentReplay: recoverJson.idempotentReplay === true,
    bindingCommitted: recoverJson.bindingCommitted === true,
    readbackVerified: recoverJson.readbackVerified === true,
    auditPending: recoverJson.auditPending === true,
    persistedRevision: recoverJson.persistedRevision ?? null,
    stage: String(recoverJson.stage || 'binding_not_recovered'),
    code: String(recoverJson.code || ''),
    error: String(recoverJson.error || '').slice(0, 500),
    bindingFingerprint: String(binding.bindingFingerprint || recoverJson.bindingFingerprint || ''),
    imageCount: Number(binding.imageCount || (Array.isArray(binding.images) ? binding.images.length : 0)),
    roles: Array.isArray(binding.images) ? binding.images.map(img => img.role) : [],
    prepareBatchId: String(binding.prepareBatchId || expectedPrepareBatchId),
    authority: String(binding.authority || ''),
    nextStep: recoverJson.nextStep || {command: 'preflight', note: '图片绑定已恢复，旧预演已作废，请重新执行 preflight。', realPublish: false},
    safety: {
      realPublishOccurred: false,
      newUploadTriggered: false,
      newTaskCreated: false,
      sameTask: true,
      preflightInvalidated: true,
    },
  };
  print(output);
  if (!output.ok) process.exitCode = 1;
}


async function runPrepareProductAttribute(args) {
  if (!args.taskId) throw new Error('prepare-product-attribute requires --task-id <id>');
  const storeCandidates = [...new Set(
    [...(args.writeStores || []), ...(args.stores || [])]
      .map(value => String(value || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  if (storeCandidates.length !== 1) {
    throw new Error(`prepare-product-attribute 必须精确单个 --store（多个/零个均拒绝）；当前解析到 ${storeCandidates.length} 个店铺：${storeCandidates.join('/') || '(empty)'}`);
  }
  const store = storeCandidates[0];
  if (args.refreshBinding) {
    await runRefreshProductAttributeBinding(args, store);
    return;
  }
  const donorStore = String(args.donorStore || '').trim().toUpperCase();
  if (!donorStore || !/^[A-Z0-9]{2,4}$/.test(donorStore)) {
    throw new Error('prepare-product-attribute requires --donor-store <同货号 donor 店铺代码>');
  }
  const donorSkc = String(args.donorSkc || '').trim();
  if (!donorSkc || donorSkc.length > 160 || !isSheinSkc(donorSkc) || !/\d{8,}$/.test(donorSkc)) {
    throw new Error('prepare-product-attribute --donor-skc 必须是完整 SHEIN SKC（sv/sb/sh + 8 位以上数字，大小写不敏感）');
  }
  const attributeId = normalizeProductAttributeId(args.attributeId);
  if (attributeId === null || attributeId !== 1002328) {
    throw new Error('prepare-product-attribute --attribute-id 只允许受控白名单 1002328（Hazardous materials classification）');
  }
  const bindingMode = args.adoptExisting ? PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT : PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND;
  const expectedRevisionProvided = args.expectedRevision !== null;
  if (expectedRevisionProvided
    && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision <= 0)) {
    throw new Error('prepare-product-attribute --expected-revision 必须是正安全整数，属性未绑定');
  }
  const explicitExpectedRevision = expectedRevisionProvided ? args.expectedRevision : null;
  const {json: taskListJson} = await request(args, '/api/link-ops-tasks?limit=500');
  const currentTask = (taskListJson?.data?.tasks || []).find(task => String(task?.id || '') === args.taskId) || null;
  if (!currentTask) throw new Error('当前账号无法精确读取目标 task，属性未绑定');
  const liveRevision = Number(currentTask.repositoryRevision || 0);
  if (!Number.isSafeInteger(liveRevision) || liveRevision <= 0) {
    throw new Error('目标 task 未返回可用于 CAS 的正整数 repositoryRevision，属性未绑定');
  }
  // Strict attribute-binding lock validation. The server projection is
  // trusted only when it is exactly {baseTaskRevision,currentRevision,ok,stale}
  // with boolean ok/stale satisfying stale === !ok, positive safe-integer
  // revisions, base equal to the existing binding's baseTaskRevision and
  // current equal to the live repositoryRevision. Any deviation is UNKNOWN:
  // the CLI never guesses freshness and never replays an old base.
  const existingBinding = currentTask?.productAttributeBinding && typeof currentTask.productAttributeBinding === 'object'
    ? currentTask.productAttributeBinding
    : null;
  const existingBaseRevision = existingBinding
    && Number.isSafeInteger(existingBinding.baseTaskRevision) && existingBinding.baseTaskRevision > 0
    ? existingBinding.baseTaskRevision
    : 0;
  const existingBindingLock = currentTask?.productAttributeBindingLock && typeof currentTask.productAttributeBindingLock === 'object'
    ? currentTask.productAttributeBindingLock
    : null;
  const existingBindingLockKnown = Boolean(
    existingBindingLock
    && !Array.isArray(existingBindingLock)
    && Object.keys(existingBindingLock).sort().join(',') === 'baseTaskRevision,currentRevision,ok,stale'
    && typeof existingBindingLock.ok === 'boolean'
    && typeof existingBindingLock.stale === 'boolean'
    && existingBindingLock.stale === !existingBindingLock.ok
    && typeof existingBindingLock.baseTaskRevision === 'number'
    && Number.isSafeInteger(existingBindingLock.baseTaskRevision)
    && existingBindingLock.baseTaskRevision > 0
    && existingBindingLock.baseTaskRevision === existingBaseRevision
    && typeof existingBindingLock.currentRevision === 'number'
    && Number.isSafeInteger(existingBindingLock.currentRevision)
    && existingBindingLock.currentRevision > 0
    && existingBindingLock.currentRevision === liveRevision,
  );
  const existingBindingStale = existingBindingLockKnown && existingBindingLock.stale === true;
  const existingSchemaVersion = Number(existingBinding?.schemaVersion || 0);
  const existingRequestKey = Number.isSafeInteger(existingBaseRevision) && existingBaseRevision > 0
    ? (existingSchemaVersion === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION
        ? productAttributeBindingRequestKeyV2({
            schemaVersion: PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
            bindingMode: String(existingBinding?.bindingMode || ''),
            taskId: args.taskId,
            targetStore: store,
            baseTaskRevision: existingBaseRevision,
            attributeId,
            attributeValueId: normalizeProductAttributeId(existingBinding?.attributeValueId) || 0,
            donorStore,
            donorSkc,
            donorSpu: String(existingBinding?.donorSpu || ''),
            evidenceSha256: String(existingBinding?.evidenceSha256 || ''),
            oldPayloadHash: String(existingBinding?.oldPayloadHash || ''),
            newPayloadHash: String(existingBinding?.newPayloadHash || ''),
          })
        : existingSchemaVersion === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1
          ? productAttributeBindingRequestKey({
              taskId: args.taskId,
              targetStore: store,
              baseTaskRevision: existingBaseRevision,
              attributeId,
              attributeValueId: normalizeProductAttributeId(existingBinding?.attributeValueId) || 0,
              donorStore,
              donorSkc,
              donorSpu: String(existingBinding?.donorSpu || ''),
              evidenceSha256: String(existingBinding?.evidenceSha256 || ''),
            })
          : '')
    : '';
  const exactExistingBinding = Boolean(
    existingBinding
    && String(existingBinding.targetStore || '').toUpperCase() === store.toUpperCase()
    && normalizeProductAttributeId(existingBinding.attributeId) === attributeId
    && String(existingBinding.donorStore || '').toUpperCase() === donorStore
    && String(existingBinding.donorSkc || '') === donorSkc
    && String(existingBinding.bindingMode || PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND) === bindingMode
    && (existingSchemaVersion === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION
      || (existingSchemaVersion === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1
        && bindingMode === PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND))
    && existingRequestKey
    && String(existingBinding.bindingRequestKey || '').toLowerCase() === existingRequestKey.toLowerCase(),
  );
  // Replaying an existing binding identity is only safe when the server
  // proves the binding still locks the current payload. A stale lock rebinds
  // at the live revision; a missing lock state fails closed instead of
  // guessing, unless the operator explicitly pinned a revision.
  const idempotentReplay = exactExistingBinding && existingBindingLockKnown && !existingBindingStale;
  if (explicitExpectedRevision
    && explicitExpectedRevision !== liveRevision
    && !(idempotentReplay && explicitExpectedRevision === existingBaseRevision)) {
    throw new Error(`目标 task revision 已变化：命令期望 ${explicitExpectedRevision}，实时读取为 ${liveRevision}；属性未绑定`);
  }
  if (exactExistingBinding && !existingBindingLockKnown && !explicitExpectedRevision) {
    throw new Error(`目标 task 已存在同源商品属性绑定，但云端属性绑定锁未知或不符合严格规范（必须恰为 baseTaskRevision/currentRevision/ok/stale，ok/stale 为互反 boolean，且 base/current 分别为绑定基线与实时 revision），无法区分幂等重放与过期重绑；请显式传 --expected-revision ${liveRevision} 后重试（属性未绑定）`);
  }
  // When the previous request committed the binding but failed only while
  // appending external audit, replay the original request identity. Sending
  // the new task revision would create a new request key and bind twice.
  const requestRevision = idempotentReplay
    ? existingBaseRevision
    : (explicitExpectedRevision || liveRevision);
  const bindBody = {
    taskId: args.taskId,
    store,
    donorStore,
    donorSkc,
    attributeId,
    bindingMode,
    expectedRevision: requestRevision,
  };
  let bindJson;
  try {
    ({json: bindJson} = await request(args, '/api/link-ops-prepare-product-attribute', {
      method: 'POST',
      body: bindBody,
      allowJsonFailure: true,
    }));
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'prepare-product-attribute',
      taskId: args.taskId,
      store,
      stage: 'binding_not_committed',
      bindingCommitted: false,
      code: error?.code || error?.response?.code || null,
      status: error?.status || null,
      error: String(error?.message || '商品属性绑定失败').slice(0, 500),
      requested: {attributeId, donorStore, donorSkc, bindingMode},
      safety: {realPublishOccurred: false, dryRunAttempted: false},
    });
    process.exitCode = 1;
    return;
  }
  const binding = bindJson.binding || {};
  if (bindJson.bindingCommitted !== true || bindJson.readbackVerified !== true || bindJson.auditPending === true || bindJson.ok !== true) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'prepare-product-attribute',
      taskId: args.taskId,
      store,
      stage: String(bindJson.stage || 'binding_state_uncertain'),
      bindingCommitted: bindJson.bindingCommitted === true,
      repositoryEventCommitted: bindJson.repositoryEventCommitted === true,
      readbackVerified: bindJson.readbackVerified === true,
      auditPending: bindJson.auditPending === true,
      code: String(bindJson.code || ''),
      error: String(bindJson.error || '').slice(0, 500),
      requested: {attributeId, donorStore, donorSkc, bindingMode},
      bound: {
        attributeId: binding.attributeId ?? null,
        attributeValueId: binding.attributeValueId ?? null,
        donorStore: String(binding.donorStore || ''),
        donorSkc: String(binding.donorSkc || ''),
        donorSpu: String(binding.donorSpu || ''),
        canonicalCode: String(binding.canonicalCode || ''),
        newPayloadHash: String(binding.newPayloadHash || ''),
        bindingRequestKey: String(binding.bindingRequestKey || ''),
      },
      safety: {realPublishOccurred: false, dryRunAttempted: false},
    });
    process.exitCode = 1;
    return;
  }
  if (String(bindJson?.task?.id || '') !== args.taskId) {
    throw new Error('云端没有确认商品属性绑定仍是同一 task，已停止重新预演');
  }
  if (String(binding.targetStore || '').toUpperCase() !== store.toUpperCase()) {
    throw new Error('云端商品属性绑定目标店铺与请求不一致，已停止重新预演');
  }
  if (normalizeProductAttributeId(binding.attributeId) !== attributeId) {
    throw new Error('云端商品属性绑定 attributeId 与请求不一致，已停止重新预演');
  }
  const boundValueId = normalizeProductAttributeId(binding.attributeValueId);
  if (boundValueId === null) {
    throw new Error('云端商品属性绑定缺少正整数 attributeValueId，已停止重新预演');
  }
  if (String(binding.donorStore || '').toUpperCase() !== donorStore
    || String(binding.donorSkc || '') !== donorSkc) {
    throw new Error('云端商品属性绑定 donor 身份与请求不一致，已停止重新预演');
  }
  let preflightJson;
  try {
    ({json: preflightJson} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: args.taskId, mode: 'dry-run', source: 'codex_desktop_cli_prepare_product_attribute'},
      allowJsonFailure: true,
    }));
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'prepare-product-attribute',
      taskId: args.taskId,
      store,
      stage: 'binding_committed_dry_run_failed',
      bindingCommitted: true,
      readbackVerified: true,
      auditPending: false,
      code: error?.code || error?.response?.code || null,
      status: error?.status || null,
      error: String(error?.message || '重新预演失败').slice(0, 500),
      bound: {
        attributeId,
        attributeValueId: boundValueId,
        donorStore,
        donorSkc,
        newPayloadHash: String(binding.newPayloadHash || ''),
        bindingRequestKey: String(binding.bindingRequestKey || ''),
      },
      safety: {realPublishOccurred: false, retryBinding: false},
    });
    process.exitCode = 1;
    return;
  }
  const preflightResponse = linkOpsExecutionResponse(preflightJson);
  const execution = preflightResponse.execution;
  const productExecutor = execution.openApiProductExecutors?.[0] || execution.hlOpenApiExecutor || {};
  // Re-read the task after dry-run: the binding lock must still be KNOWN,
  // current and ok against the persisted payload, proving the bound attribute
  // row is the one that was just preflighted (the dry-run itself never
  // rewrites openapiPublishPayload).
  let lockKnownAfterDryRun = false;
  let lockStaleAfterDryRun = true;
  try {
    const {json: taskListAfterJson} = await request(args, '/api/link-ops-tasks?limit=500');
    const taskAfter = (taskListAfterJson?.data?.tasks || []).find(task => String(task?.id || '') === args.taskId) || null;
    const lockAfter = taskAfter?.productAttributeBindingLock && typeof taskAfter.productAttributeBindingLock === 'object'
      ? taskAfter.productAttributeBindingLock
      : null;
    const liveAfter = Number(taskAfter?.repositoryRevision || 0);
    const baseAfter = Number(taskAfter?.productAttributeBinding?.baseTaskRevision || 0);
    lockKnownAfterDryRun = Boolean(
      lockAfter
      && !Array.isArray(lockAfter)
      && Object.keys(lockAfter).sort().join(',') === 'baseTaskRevision,currentRevision,ok,stale'
      && typeof lockAfter.ok === 'boolean'
      && typeof lockAfter.stale === 'boolean'
      && lockAfter.stale === !lockAfter.ok
      && Number.isSafeInteger(lockAfter.baseTaskRevision)
      && lockAfter.baseTaskRevision > 0
      && lockAfter.baseTaskRevision === baseAfter
      && Number.isSafeInteger(lockAfter.currentRevision)
      && lockAfter.currentRevision > 0
      && lockAfter.currentRevision === liveAfter,
    );
    lockStaleAfterDryRun = !(lockKnownAfterDryRun && lockAfter?.ok === true);
  } catch {}
  const dryRun = {
    state: String(execution.state || ''),
    ok: execution.preflight?.ok === true,
    blockerCount: Array.isArray(execution.preflight?.blockers) ? execution.preflight.blockers.length : 0,
    payloadHash: String(productExecutor.payload?.payloadHash || ''),
    productAttributeCount: Number(productExecutor.payload?.summary?.productAttributeCount || 0) || 0,
    bindingLocked: lockKnownAfterDryRun && !lockStaleAfterDryRun,
  };
  const committedStage = String(bindJson.stage || 'binding_committed_needs_description_rebind');
  const bindingVerified = Boolean(
    bindJson.bindingCommitted === true
    && bindJson.readbackVerified === true
    && bindJson.auditPending !== true
    && bindJson.ok === true,
  );
  const output = {
    // Step 1 is complete when the binding itself is committed, independently
    // read back and audited. The dry-run is intentionally NOT ready yet: the
    // description lock is stale by design and the next step is a
    // prepare-descriptions rebind of the same material. After that, normal
    // preflight becomes the authority again.
    ok: bindingVerified && dryRun.bindingLocked,
    aiInvoked: false,
    command: 'prepare-product-attribute',
    taskId: args.taskId,
    store,
    bindingMode,
    stage: committedStage,
    bindingCommitted: bindJson.bindingCommitted === true,
    readbackVerified: bindJson.readbackVerified === true,
    auditPending: bindJson.auditPending === true,
    binding: {
      ...binding,
      sameTask: true,
      payloadSource: String(binding.payloadSource || 'task'),
      attributeValueId: boundValueId,
      canonicalCode: String(binding.canonicalCode || ''),
      rawTaskCode: String(binding.rawTaskCode || ''),
      rawDonorCode: String(binding.rawDonorCode || ''),
    },
    preflightReady: preflightResponse.ok,
    preflightResult: linkOpsExecutionSummary(preflightResponse),
    task: preflightResponse.task,
    execution: preflightResponse.execution,
    dryRun,
    nextStep: bindJson.nextStep || {
      command: 'prepare-descriptions',
      note: '请用原始审核 HTML 在同一任务重新绑定描述，然后重新预演。',
      realPublish: false,
    },
    safety: {
      sameTask: true,
      realPublishOccurred: false,
      dryRunReadyClaimed: false,
      nextStep: '同一任务 prepare-descriptions 重绑原始审核 HTML；之后重新预演通过、用户确认后才可 execute。',
    },
  };
  print(output);
  if (!output.ok) process.exitCode = 1;
}

async function runUpdateDescription(args) {
  if (!args.sourceTaskId) throw new Error('update-description requires --source-task-id <历史发布任务id>');
  if (!args.sourceFile) throw new Error('update-description requires --source-file <实际审核资料HTML>');
  const storeCandidates = [...new Set(
    [...(args.writeStores || []), ...(args.stores || [])]
      .map(value => String(value || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  if (storeCandidates.length !== 1) {
    throw new Error(`update-description 必须精确单个 --store（多个/零个均拒绝）；当前解析到 ${storeCandidates.length} 个店铺：${storeCandidates.join('/') || '(empty)'}`);
  }
  const store = storeCandidates[0];
  const spu = [...new Set(args.spuList || [])].map(value => String(value || '').trim()).filter(Boolean);
  if (spu.length !== 1) throw new Error('update-description 必须精确单个 --spu <唯一SPU>');
  const skc = [...new Set(args.skcList || [])].map(value => String(value || '').trim()).filter(Boolean);
  if (skc.length > 1) throw new Error('update-description 只允许一个 --skc');
  const section = ['s09', 's9', 'auto'].includes(String(args.section || 'auto'))
    ? String(args.section || 'auto')
    : 'auto';
  let sourceBytes;
  try {
    sourceBytes = await fs.readFile(args.sourceFile);
  } catch {
    throw new Error(`无法读取审核资料文件：${path.basename(args.sourceFile) || '(unknown)'}`);
  }
  const htmlText = sourceBytes.toString('utf8');
  let providedMaterial = null;
  if (args.materialJsonFile) {
    providedMaterial = JSON.parse(await fs.readFile(args.materialJsonFile, 'utf8'));
  }
  let verified;
  try {
    verified = verifyDescriptionMaterialAgainstHtml(htmlText, sourceBytes, {
      material: providedMaterial,
      sourceFileBasename: path.basename(args.sourceFile),
      sourceFileSha256: providedMaterial?.sourceFileSha256 || '',
      section,
    });
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'update-description',
      stage: 'local_source_rejected',
      code: error?.code || 'DESCRIPTION_SOURCE_VERIFICATION_FAILED',
      error: String(error?.message || error).slice(0, 500),
      safety: {noTaskCreated: true, realWriteOccurred: false},
    });
    process.exitCode = 1;
    return;
  }
  const material = validateDescriptionMaterialJson(verified.material);
  const summary = describeDescriptionMaterial(material);
  // 1) Create an independent maintenance task. The historical publish task is
  // only source evidence and is never modified.
  const createBody = {
    command: `历史商品描述回填：${store} 店 SPU ${spu[0]}（来源发布任务 ${args.sourceTaskId}）`,
    source: 'codex_desktop_cli_structured_update_description',
    intents: ['update_description'],
    targets: {stores: [store], writeStores: [store], productRefs: [spu[0]]},
    parameters: {
      sourceTaskId: args.sourceTaskId,
      spuName: spu[0],
      ...(skc.length ? {skcName: skc[0]} : {}),
    },
  };
  let createdJson;
  try {
    ({json: createdJson} = await request(args, '/api/link-ops-tasks', {method: 'POST', body: createBody}));
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'update-description',
      stage: 'task_creation_failed',
      status: error?.status || null,
      error: String(error?.message || '创建 update_description 任务失败').slice(0, 500),
      safety: {noTaskCreated: true, realWriteOccurred: false},
    });
    process.exitCode = 1;
    return;
  }
  const taskId = String(createdJson?.task?.id || createdJson?.data?.task?.id || '');
  if (!taskId) throw new Error('云端未返回新建 update_description 任务 id');
  const createdWriteStore = String(createdJson?.task?.targets?.writeStores?.[0] || createdJson?.task?.targets?.stores?.[0] || '').toUpperCase();
  if (createdWriteStore !== store.toUpperCase()) {
    throw new Error('云端新建任务的唯一写入店与请求不一致，已停止绑定');
  }
  // 2) Fresh-read the task revision, then bind with server-side HTML
  // verification (idempotent replay reuses the original request identity).
  const {json: taskListJson} = await request(args, '/api/link-ops-tasks?limit=500');
  const currentTask = (taskListJson?.data?.tasks || []).find(task => String(task?.id || '') === taskId) || null;
  if (!currentTask) throw new Error('当前账号无法精确读取新建任务 revision，描述未绑定');
  const liveRevision = Number(currentTask.repositoryRevision || 0);
  if (!Number.isSafeInteger(liveRevision) || liveRevision <= 0) {
    throw new Error('新建任务未返回可用于 CAS 的正整数 repositoryRevision，描述未绑定');
  }
  const existingBinding = currentTask?.descriptionMaterialBinding && typeof currentTask.descriptionMaterialBinding === 'object'
    ? currentTask.descriptionMaterialBinding
    : null;
  const existingBaseRevision = Number(existingBinding?.baseTaskRevision || 0);
  const existingBindingRequestKey = Number.isSafeInteger(existingBaseRevision) && existingBaseRevision > 0
    ? descriptionBindingRequestKey({
        taskId,
        targetStore: store,
        baseTaskRevision: existingBaseRevision,
        contentSha256: summary.contentSha256,
      })
    : '';
  const exactExistingBinding = Boolean(
    existingBinding
    && String(existingBinding.targetStore || '').toUpperCase() === store.toUpperCase()
    && String(existingBinding.targetSpu || '').toLowerCase() === spu[0].toLowerCase()
    && String(existingBinding.sourceFileSha256 || '').toLowerCase() === summary.sourceFileSha256
    && String(existingBinding.contentSha256 || '').toLowerCase() === summary.contentSha256
    && String(existingBinding.bindingRequestKey || '').toLowerCase() === existingBindingRequestKey,
  );
  const explicitExpectedRevision = Number.isFinite(args.expectedRevision) && args.expectedRevision > 0
    ? Math.trunc(args.expectedRevision)
    : null;
  if (explicitExpectedRevision
    && explicitExpectedRevision !== liveRevision
    && !(exactExistingBinding && explicitExpectedRevision === existingBaseRevision)) {
    throw new Error(`新建任务 revision 已变化：命令期望 ${explicitExpectedRevision}，实时读取为 ${liveRevision}；描述未绑定`);
  }
  const requestRevision = exactExistingBinding ? existingBaseRevision : (explicitExpectedRevision || liveRevision);
  const bindBody = {
    taskId,
    store,
    sourceApproved: true,
    materialJson: material,
    sourceFile: {
      name: path.basename(args.sourceFile),
      dataBase64: sourceBytes.toString('base64'),
    },
    section,
    expectedRevision: requestRevision,
  };
  let bindJson;
  try {
    ({json: bindJson} = await request(args, '/api/link-ops-prepare-update-description', {
      method: 'POST',
      body: bindBody,
      allowJsonFailure: true,
    }));
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'update-description',
      taskId,
      store,
      stage: 'binding_not_committed',
      bindingCommitted: false,
      code: error?.code || null,
      status: error?.status || null,
      error: String(error?.message || '描述绑定失败').slice(0, 500),
      material: {
        sourceLabel: summary.sourceLabel,
        sourceFileSha256: summary.sourceFileSha256,
        contentSha256: summary.contentSha256,
        lineCounts: summary.lineCounts,
        hashes: summary.hashes,
      },
      safety: {realWriteOccurred: false},
    });
    process.exitCode = 1;
    return;
  }
  const binding = bindJson.binding || {};
  if (bindJson.bindingCommitted !== true || bindJson.readbackVerified !== true || bindJson.auditPending === true || bindJson.ok !== true) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'update-description',
      taskId,
      store,
      stage: String(bindJson.stage || 'binding_state_uncertain'),
      bindingCommitted: bindJson.bindingCommitted === true,
      repositoryEventCommitted: bindJson.repositoryEventCommitted === true,
      readbackVerified: bindJson.readbackVerified === true,
      auditPending: bindJson.auditPending === true,
      material: {
        sourceLabel: summary.sourceLabel,
        sourceFileSha256: summary.sourceFileSha256,
        contentSha256: summary.contentSha256,
        lineCounts: summary.lineCounts,
        hashes: summary.hashes,
      },
      bound: {
        targetStore: String(binding.targetStore || ''),
        targetSpu: String(binding.targetSpu || ''),
        sourceTaskId: String(binding.sourceTaskId || ''),
        newPayloadHash: String(binding.newPayloadHash || ''),
      },
      safety: {realWriteOccurred: false, dryRunAttempted: false},
    });
    process.exitCode = 1;
    return;
  }
  if (String(bindJson?.task?.id || '') !== taskId) throw new Error('云端没有确认描述绑定仍是同一任务，已停止重新预演');
  if (String(binding.targetStore || '').toUpperCase() !== store.toUpperCase()) throw new Error('云端描述绑定目标店铺与请求不一致，已停止重新预演');
  if (String(binding.targetSpu || '').toLowerCase() !== spu[0].toLowerCase()) throw new Error('云端描述绑定目标 SPU 与请求不一致，已停止重新预演');
  if (String(binding.sourceTaskId || '') !== args.sourceTaskId) throw new Error('云端描述绑定来源任务与请求不一致，已停止重新预演');
  for (const language of ['ar', 'en', 'zh-cn']) {
    if (String(binding.hashes?.[language] || '').toLowerCase() !== String(summary.hashes?.[language] || '').toLowerCase()) {
      throw new Error(`云端描述绑定 ${language} hash 与本地审核资料不一致，已停止重新预演`);
    }
  }
  if (String(binding.sourceFileSha256 || '').toLowerCase() !== summary.sourceFileSha256
    || String(binding.contentSha256 || '').toLowerCase() !== summary.contentSha256) {
    throw new Error('云端描述绑定的源文件/content hash 与本地审核资料不一致，已停止重新预演');
  }
  // 3) Re-dry-run the same task to lock the exact payload hash.
  let preflightJson;
  try {
    ({json: preflightJson} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: taskId, mode: 'dry-run', source: 'codex_desktop_cli_update_description'},
      allowJsonFailure: true,
    }));
  } catch (error) {
    print({
      ok: false,
      aiInvoked: false,
      command: 'update-description',
      taskId,
      store,
      stage: 'binding_committed_dry_run_failed',
      bindingCommitted: true,
      readbackVerified: true,
      auditPending: false,
      code: error?.code || null,
      status: error?.status || null,
      error: String(error?.message || '重新预演失败').slice(0, 500),
      material: {
        sourceLabel: summary.sourceLabel,
        sourceFileSha256: summary.sourceFileSha256,
        contentSha256: summary.contentSha256,
        lineCounts: summary.lineCounts,
        hashes: summary.hashes,
      },
      bound: {
        targetStore: String(binding.targetStore || ''),
        targetSpu: String(binding.targetSpu || ''),
        sourceTaskId: String(binding.sourceTaskId || ''),
        newPayloadHash: String(binding.newPayloadHash || ''),
      },
      safety: {realWriteOccurred: false, retryBinding: false},
    });
    process.exitCode = 1;
    return;
  }
  const preflightResponse = linkOpsExecutionResponse(preflightJson);
  const execution = preflightResponse.execution;
  const maintenanceExecutor = (execution.linkMaintenanceExecutors || [])[0] || {};
  const executorSummary = maintenanceExecutor.payload?.summary || {};
  const descriptionUpdate = executorSummary.descriptionUpdate || {};
  const dryRun = {
    state: String(execution.state || ''),
    ok: execution.preflight?.ok === true,
    blockerCount: Array.isArray(execution.preflight?.blockers) ? execution.preflight.blockers.length : 0,
    payloadHash: String(executorSummary.payloadHash || maintenanceExecutor.payload?.payloadHash || ''),
    descriptionCount: Number(descriptionUpdate.descriptionCount || 0),
    spuName: String(descriptionUpdate.spuName || ''),
    descriptionPayloadHash: String(descriptionUpdate.payloadHash || ''),
    descriptionBindingLocked: Number(descriptionUpdate.descriptionCount || 0) === 2
      && String(descriptionUpdate.payloadHash || '').toLowerCase() === String(binding.newPayloadHash || '').toLowerCase(),
  };
  const preparedOutput = {
    ok: dryRun.ok && dryRun.descriptionBindingLocked
      && dryRun.descriptionCount === 2
      && dryRun.payloadHash.length === 64,
    aiInvoked: false,
    command: 'update-description',
    taskId,
    store,
    material: {
      sourceLabel: summary.sourceLabel,
      sourceFileSha256: summary.sourceFileSha256,
      contentSha256: summary.contentSha256,
      sectionUsed: verified.sectionUsed,
      publishLanguages: [...summary.publishLanguages],
      lineCounts: {...summary.lineCounts},
      hashes: {...summary.hashes},
    },
    bound: {
      targetStore: String(binding.targetStore || ''),
      targetSpu: String(binding.targetSpu || ''),
      sourceTaskId: String(binding.sourceTaskId || ''),
      sourceProof: String(binding.sourceProof || ''),
      newPayloadHash: String(binding.newPayloadHash || ''),
      preflightInvalidated: true,
    },
    dryRun,
    safety: {
      verbatimOnly: true,
      noAutoMapFromSource: true,
      minimalPartialEditOnly: true,
      oldPublishTaskUntouched: true,
      realWriteOccurred: false,
      nextStep: '核对新预演的 payloadHash 和描述 hash；只有用户明确确认后才调用 execute。',
    },
  };
  const output = {
    ...preparedOutput,
    ...linkOpsExecutionSummary(preflightResponse),
    ok: preparedOutput.ok === true && preflightResponse.ok,
    task: preflightResponse.task,
    execution: preflightResponse.execution,
  };
  print(output);
  applyLinkOpsExecutionExitCode(output);
}

async function runPreparePendingImageCorrection(args) {
  if (!args.taskId) throw new Error('prepare-pending-image-correction requires --task-id <id>');
  if (!args.sourceTaskId) throw new Error('prepare-pending-image-correction requires --source-task-id <published task id>');
  const store = [...new Set([...(args.writeStores || []), ...(args.stores || [])])][0] || '';
  if (!store) throw new Error('prepare-pending-image-correction requires --store <target store>');
  const {json: bindingJson} = await request(args, '/api/link-ops-publish-assets', {
    method: 'POST',
    body: {
      taskId: args.taskId,
      store,
      sourceApproved: true,
      sourceTaskId: args.sourceTaskId,
      reuseApprovedBinding: true,
    },
  });
  if (bindingJson?.binding?.pendingNewListingImageCorrection !== true) {
    throw new Error('云端没有生成待审核新品纠图计划；已停止预演');
  }
  const {json: preflightJson} = await request(args, '/api/link-ops-execute', {
    method: 'POST',
    body: {id: args.taskId, mode: 'dry-run', source: 'codex_desktop_cli_prepare_pending_image_correction'},
    allowJsonFailure: true,
  });
  const preflightResponse = linkOpsExecutionResponse(preflightJson);
  const output = {
    ...preflightResponse,
    taskId: args.taskId,
    sourceTaskId: args.sourceTaskId,
    store,
    binding: bindingJson.binding,
    safety: {
      imagesReused: true,
      imagesUploadedAgain: false,
      realWriteOccurred: false,
      nextStep: '核对撤回+完整重提计划及 payloadHash；只有用户明确确认后才调用 execute。',
    },
  };
  print(output);
  applyLinkOpsExecutionExitCode(output);
}

function operatorGuide() {
  return {
    ok: true,
    version: BI_OPS_CLI_VERSION,
    authority: [
      '用户当前明确指令',
      '已审可用/人工审核素材',
      '负责人规则与正式资料',
      'AI 建议',
    ],
    imageBoundary: '标题或核心卖点未采用某参数，不等于已审图片禁用；AI 只能提示，不能静默剔除。',
    objectiveBlockersOnly: ['文件损坏', '平台不支持的格式/大小', '明确错品', '图片角色/容量冲突', '真实 SHEIN 校验失败'],
    requiredFlow: '同一任务 create -> prepare-publish -> post-binding preflight -> 用户确认 -> execute -> readback',
    managedLauncher: path.join(os.homedir(), '.shein-bi', 'cli', 'shein-bi-ops.cmd'),
  };
}

async function runRetireCandidates(args) {
  if (!args.imageFile) throw new Error('retire-candidates requires --file <enriched candidate csv>');
  const commandArgs = ['--input', args.imageFile];
  if (args.outputFile) commandArgs.push('--out-dir', args.outputFile);
  if (args.performanceDate) commandArgs.push('--performance-date', args.performanceDate);
  const result = await runLocalNodeScript('scripts/build_link_retire_candidates_from_csv.mjs', commandArgs);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) process.exitCode = result.code;
}

async function runReadonlyExecutor(args, action) {
  const store = [...new Set([...(args.stores || []), ...(args.writeStores || [])])][0] || '';
  if (!store) throw new Error(`${action} requires --store <店铺>`);
  assertLocalOpenApiExecutorAllowed(args, action);
  const commandArgs = [action, '--store', store, '--mode', args.mode || 'dry-run'];
  if (args.openapiConfigFile) commandArgs.push('--config', args.openapiConfigFile);
  if (args.openapiStoreTruthFile) commandArgs.push('--store-truth', args.openapiStoreTruthFile);
  if (args.categoryId) commandArgs.push('--category', args.categoryId);
  if (args.pageNum) commandArgs.push('--page', String(args.pageNum));
  if (args.pageSize) commandArgs.push('--page-size', String(args.pageSize));
  if (args.languageList.length) commandArgs.push('--language', args.languageList.join(','));
  if (args.version) commandArgs.push('--version', args.version);
  for (const spu of args.spuList || []) commandArgs.push('--spu', spu);
  for (const skc of args.skcList || []) commandArgs.push('--skc', skc);
  for (const skuCode of args.skuCodeList || []) commandArgs.push('--sku-code', skuCode);
  for (const supplierSku of args.supplierSkuList || []) commandArgs.push('--supplier-sku', supplierSku);
  for (const product of args.products || []) {
    if (action === 'search-product') commandArgs.push('--supplier-code', product);
    else commandArgs.push('--spu', product);
  }
  const result = await runLocalNodeScript('scripts/openapi_readonly_executor.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runOrderFulfillmentExecutor(args) {
  const store = [...new Set([...(args.stores || []), ...(args.writeStores || [])])][0] || '';
  if (!store) throw new Error('order-fulfillment requires --store <店铺>');
  if (!args.operation) throw new Error('order-fulfillment requires --operation <export-address|import-express|place-express-order|print-express-info>');
  assertLocalOpenApiExecutorAllowed(args, 'order-fulfillment', {allowDryRunForTests: false});
  const commandArgs = [args.operation, '--store', store, '--mode', args.mode || 'dry-run'];
  if (args.confirm) commandArgs.push('--confirm', args.confirm);
  if (args.payloadHash) commandArgs.push('--payload-hash', args.payloadHash);
  if (args.openapiConfigFile) commandArgs.push('--config', args.openapiConfigFile);
  if (args.openapiStoreTruthFile) commandArgs.push('--store-truth', args.openapiStoreTruthFile);
  if (args.orderNo) commandArgs.push('--order-no', args.orderNo);
  if (args.handleType) commandArgs.push('--handle-type', String(args.handleType));
  if (args.expressCode) commandArgs.push('--express-code', args.expressCode);
  if (args.expressIdCode) commandArgs.push('--express-id-code', args.expressIdCode);
  if (args.expressChannelCode) commandArgs.push('--express-channel-code', args.expressChannelCode);
  if (args.goodsId) commandArgs.push('--goods-id', args.goodsId);
  if (args.goodsIds.length) commandArgs.push('--goods-ids', args.goodsIds.join(','));
  if (args.preRequestId) commandArgs.push('--pre-request-id', args.preRequestId);
  if (args.packageNo.length) commandArgs.push('--package-no', args.packageNo.join(','));
  if (args.deliveryNo) commandArgs.push('--delivery-no', args.deliveryNo);
  const result = await runLocalNodeScript('scripts/openapi_order_fulfillment_executor.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runCatalogPlan(args) {
  const commandArgs = ['plan'];
  if (args.format) commandArgs.push('--format', args.format);
  if (args.outputFile) commandArgs.push('--out', args.outputFile);
  const result = await runLocalNodeScript('scripts/openapi_catalog_executor.mjs', commandArgs);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(`openapi_catalog_executor plan failed with code ${result.code}`);
}

async function runCatalogExecutor(args) {
  const store = [...new Set([...(args.stores || []), ...(args.writeStores || [])])][0] || '';
  if (!store) throw new Error('openapi-call requires --store <店铺>');
  if (!args.docId && !args.endpoint) throw new Error('openapi-call requires --doc-id or --endpoint');
  assertLocalOpenApiExecutorAllowed(args, 'openapi-call');
  const commandArgs = ['--store', store, '--mode', args.mode || 'dry-run'];
  if (args.docId) commandArgs.push('--doc-id', args.docId);
  if (args.endpoint) commandArgs.push('--endpoint', args.endpoint);
  if (args.bodyFile) commandArgs.push('--body-file', args.bodyFile);
  else commandArgs.push('--body-json', args.bodyJson || '{}');
  if (args.queryFile) commandArgs.push('--query-file', args.queryFile);
  else if (args.queryJson) commandArgs.push('--query-json', args.queryJson);
  if (args.confirm) commandArgs.push('--confirm', args.confirm);
  if (args.payloadHash) commandArgs.push('--payload-hash', args.payloadHash);
  if (args.openapiConfigFile) commandArgs.push('--config', args.openapiConfigFile);
  if (args.openapiStoreTruthFile) commandArgs.push('--store-truth', args.openapiStoreTruthFile);
  const result = await runLocalNodeScript('scripts/openapi_catalog_executor.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function waitForLinkOpsJob(args, jobId) {
  const id = String(jobId || '').trim();
  if (!id) throw new Error('wait-job requires --job-id');
  const seconds = Number.isFinite(Number(args.waitSeconds)) && Number(args.waitSeconds) > 0
    ? Math.min(3_600, Number(args.waitSeconds))
    : 120;
  const deadline = Date.now() + seconds * 1_000;
  let last = null;
  while (Date.now() <= deadline) {
    const {json} = await request(args, `/api/link-ops-jobs/${encodeURIComponent(id)}`);
    last = json.data || json;
    if (['succeeded', 'failed', 'uncertain_write'].includes(String(last.status || ''))) return last;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const error = new Error(`Timed out waiting ${seconds}s for job ${id}`);
  error.response = last;
  throw error;
}

async function runDirectBiQuery(args, {legacyAlias = false} = {}) {
  if (!args.text) throw new Error(`${legacyAlias ? 'ask' : 'query'} requires --text`);
  const startedAt = new Date().toISOString();
  const diagnostics = await readReadOnlyPartnerDiagnostics(args);
  const query = new URLSearchParams({q: args.text, source: 'codex_desktop_cli'});
  const stores = [...new Set([...(args.stores || []), ...(args.sourceStores || [])])];
  if (stores.length) query.set('stores', stores.join(','));
  if (args.sections.length) query.set('sections', [...new Set(args.sections)].join(','));
  let json;
  let queryAttempts = 0;
  let queryWaitedMs = 0;
  try {
    const queryResult = await runBiQueryWithWait(
      ({signal}) => request(args, `/api/bi/query-data?${query.toString()}`, {signal}),
      {
        waitSeconds: args.waitSecondsProvided ? args.waitSeconds : 90,
        requestTimeoutMs: biQueryRequestTimeoutMs(args.sections),
        retryRequestTimeout: true,
      },
    );
    ({json} = queryResult.value);
    queryAttempts = queryResult.attempts;
    queryWaitedMs = queryResult.waitedMs;
  } catch (error) {
    queryAttempts = Number(error?.queryAttempts) || 1;
    queryWaitedMs = Number(error?.queryWaitedMs) || 0;
    if (!args.outputFile) throw error;
    const response = error?.response && typeof error.response === 'object' ? error.response : {};
    const responseCode = String(response.code || error?.code || '').trim();
    const incomplete = isIncompleteBiQueryError(error);
    const sectionIssues = Array.isArray(response?.sections?.issues)
      ? response.sections.issues.map(item => ({
          section: String(item?.section || ''),
          status: String(item?.status || ''),
          expectedGeneratedAt: String(item?.expectedGeneratedAt || ''),
          generatedAt: String(item?.generatedAt || ''),
        }))
      : [];
    const output = {
      ok: false,
      mode: 'direct-bi-data',
      readOnly: true,
      aiInvoked: false,
      question: args.text,
      generatedAt: new Date().toISOString(),
      sections: {requested: [...new Set(args.sections)], loaded: [], issues: sectionIssues},
      scope: {requestedStores: stores},
      rowCounts: {},
      error: {
        code: responseCode || (incomplete ? 'BI_QUERY_DATA_INCOMPLETE' : 'BI_QUERY_FAILED'),
        status: Number(error?.status) || null,
        message: String(error?.message || 'BI query failed').slice(0, 500),
      },
      cli: {
        command: legacyAlias ? 'ask' : 'query',
        legacyAlias,
        note: '失败证据已原子覆盖输出文件，未沿用旧查询结果',
        diagnostics,
      },
    };
    const finishedAt = new Date().toISOString();
    await invalidateOpsRunManifest(`${args.outputFile}.manifest.json`);
    const artifact = await writeOpsJsonArtifactAtomic(args.outputFile, output, {mode: 0o600});
    artifact.role = 'query_evidence';
    const run = buildOpsRun({
      operation: 'bi_ops_query', mode: 'read', readOnly: true,
      outcome: incomplete ? 'incomplete' : 'failed', startedAt, finishedAt,
      source: {authority: 'cloud_bi_query_data', asOf: finishedAt},
      scope: {stores},
      coverage: {requestedSections: [...new Set(args.sections)], loadedSections: [], issueCount: sectionIssues.length},
      summary: {question: args.text, rowCounts: {}, errorCode: output.error.code},
      metrics: {queryAttempts, queryWaitedMs},
      blockers: sectionIssues.length ? sectionIssues : [{code: output.error.code, message: output.error.message}],
    });
    const manifest = await writeOpsRunManifest({
      manifestFile: `${args.outputFile}.manifest.json`,
      run,
      artifacts: [artifact],
    });
    print({...compactOpsRun(run, manifest), savedTo: args.outputFile});
    process.exitCode = run.exitCode;
    return;
  }
  const output = {
    ...json,
    cli: {
      command: legacyAlias ? 'ask' : 'query',
      legacyAlias,
      note: legacyAlias
        ? 'ask 已改为 query 兼容别名；本次没有调用云端问数模型'
        : '当前 Codex 应直接分析 data，不得再转发给其他问数模型',
      diagnostics,
    },
  };
  if (!args.outputFile) {
    print(output);
    return;
  }
  await fs.mkdir(path.dirname(args.outputFile), {recursive: true});
  await invalidateOpsRunManifest(`${args.outputFile}.manifest.json`);
  const artifact = await writeOpsJsonArtifactAtomic(args.outputFile, output, {mode: 0o600});
  artifact.role = 'query_evidence';
  const finishedAt = new Date().toISOString();
  const businessDateCandidate = String(
    output.data?.dates?.salesDate
      || output.data?.dates?.businessDate
      || output.salesUpdatedAt
      || output.generatedAt
      || '',
  ).slice(0, 10);
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(businessDateCandidate) ? businessDateCandidate : '';
  const run = buildOpsRun({
    operation: 'bi_ops_query', mode: 'read', readOnly: true,
    outcome: output.ok === false ? 'incomplete' : 'succeeded', startedAt, finishedAt,
    source: {
      authority: 'cloud_bi_query_data',
      asOf: output.generatedAt || finishedAt,
      businessDate,
      sections: output.sections?.loaded || [],
    },
    scope: output.scope,
    coverage: {
      requestedSections: output.sections?.requested || [],
      loadedSections: output.sections?.loaded || [],
      issueCount: output.sections?.issues?.length || 0,
    },
    summary: {question: output.question, rowCounts: output.rowCounts},
    metrics: {queryAttempts, queryWaitedMs},
    blockers: output.sections?.issues || [],
  });
  const manifest = await writeOpsRunManifest({
    manifestFile: `${args.outputFile}.manifest.json`,
    run,
    artifacts: [artifact],
  });
  print({...compactOpsRun(run, manifest), savedTo: args.outputFile, aiInvoked: false, cli: output.cli});
  if (!run.ok) process.exitCode = run.exitCode;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'version') {
    const installRoot = await findManagedPartnerCliInstallRoot({entryRoot: ROOT});
    print({ok: true, version: BI_OPS_CLI_VERSION, managed: Boolean(installRoot), installRoot: installRoot || null});
    return;
  }
  if (args.command === 'guide') {
    print(operatorGuide());
    return;
  }
  if (args.command === 'help') {
    console.log(help());
    return;
  }
  if (args.command === 'login') {
    if (!args.username && process.stdin.isTTY) args.username = (await promptLine('BI账号: ')).trim();
    if (args.passwordStdin) args.password = (await readStdinText()).trim();
    if (!args.password && process.stdin.isTTY) args.password = await promptHidden('BI密码: ');
    if (!args.username || !args.password) throw new Error('login requires --username and --password, SHEIN_BI_USERNAME/SHEIN_BI_PASSWORD, or interactive input');
    const {json, res} = await request(args, '/api/login', {
      method: 'POST',
      auth: false,
      body: {
        username: args.username,
        password: args.password,
        client: 'partner-cli',
        clientVersion: BI_OPS_CLI_VERSION,
      },
    });
    const cookie = cookieFromSetCookie(res.headers);
    if (!cookie) throw new Error('Login succeeded but Set-Cookie was missing');
    await writeSession(args.sessionFile, {
      baseUrl: args.baseUrl,
      cookie,
      user: json.user,
      session: json.session || null,
      expiresAt: String(json.session?.expiresAt || ''),
      savedAt: new Date().toISOString(),
      note: 'Session cookie only; plaintext password is never stored. A mode-0600 backup is maintained for interrupted-write recovery.',
    });
    const cliUpdate = await refreshPartnerCli(args, {force: true}).catch(error => ({ok: false, warning: String(error?.message || error)}));
    const knowledge = await refreshPartnerKnowledge(args).catch(error => ({ok: false, warning: String(error?.message || error)}));
    print({ok: true, user: json.user, sessionFile: args.sessionFile, knowledge: {
      updated: Boolean(knowledge?.updated),
      current: Boolean(knowledge?.ok && knowledge?.current !== false),
      sourceCommit: String(knowledge?.manifest?.sourceCommit || ''),
    }, cliUpdate: {
      managed: Boolean(cliUpdate?.managed),
      updated: Boolean(cliUpdate?.updated),
      currentVersion: BI_OPS_CLI_VERSION,
      installedVersion: cliUpdate?.latestVersion || BI_OPS_CLI_VERSION,
      warning: cliUpdate?.warning || '',
    }, session: json.session || null});
    return;
  }
  if (args.command === 'logout') {
    await request(args, '/api/logout', {method: 'POST'}).catch(() => null);
    await fs.rm(args.sessionFile, {force: true}).catch(() => {});
    await fs.rm(sessionBackupFile(args.sessionFile), {force: true}).catch(() => {});
    print({ok: true, sessionFile: args.sessionFile, loggedOut: true});
    return;
  }
  if (args.command === 'knowledge-status' || args.command === 'knowledge_status') {
    const knowledge = await refreshPartnerKnowledge(args, {strict: true, force: true});
    print({ok: true, version: BI_OPS_CLI_VERSION, knowledge});
    return;
  }
  if (args.command === 'update-status' || args.command === 'update_status') {
    const update = await refreshPartnerCli(args, {force: true, checkOnly: true});
    print({ok: true, version: BI_OPS_CLI_VERSION, update});
    return;
  }
  if (args.command === 'update') {
    const update = await refreshPartnerCliAndRelaunchIfNeeded(args, {force: true});
    if (update.relaunched) return;
    print({ok: true, version: BI_OPS_CLI_VERSION, update: update.result});
    return;
  }
  const readOnlyQuery = args.command === 'query' || args.command === 'ask';
  if (!readOnlyQuery && AUTO_UPDATE_COMMANDS.has(args.command)) {
    const update = await refreshPartnerCliAndRelaunchIfNeeded(args, {force: args.command === 'execute'});
    if (update.relaunched) return;
  }
  if (!readOnlyQuery && KNOWLEDGE_CHECK_COMMANDS.has(args.command)) {
    await refreshPartnerKnowledge(args, {
      strict: args.command === 'execute',
      force: args.command === 'execute',
      allowTransientCacheFallback: true,
    });
  }
  if (args.command === 'doctor') {
    const report = await runDoctor(args);
    print(report, !args.json);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (args.command === 'maintenance-readiness' || args.command === 'maintenance_readiness') {
    await runMaintenanceReadiness(args);
    return;
  }
  if (args.command === 'plan-images' || args.command === 'plan_images') {
    await runPlanImages(args);
    return;
  }
  if (args.command === 'prepare-publish' || args.command === 'prepare_publish') {
    await runPreparePublish(args);
    return;
  }
  if (args.command === 'lock-source' || args.command === 'lock_source') {
    await runLockSource(args);
    return;
  }
  if (args.command === 'prepare-descriptions' || args.command === 'prepare_descriptions') {
    await runPrepareDescriptions(args);
    return;
  }
  if (args.command === 'prepare-product-attribute' || args.command === 'prepare_product_attribute') {
    await runPrepareProductAttribute(args);
    return;
  }
  if (args.command === 'recover-uploaded-asset-binding' || args.command === 'recover_uploaded_asset_binding') {
    await runRecoverUploadedAssetBinding(args);
    return;
  }
  if (args.command === 'update-description' || args.command === 'update_description') {
    await runUpdateDescription(args);
    return;
  }
  if (args.command === 'prepare-pending-image-correction' || args.command === 'prepare_pending_image_correction') {
    await runPreparePendingImageCorrection(args);
    return;
  }
  if (args.command === 'retire-candidates' || args.command === 'retire_candidates') {
    await runRetireCandidates(args);
    return;
  }
  if (args.command === 'upload-pic' || args.command === 'upload_pic') {
    await runImageAssetExecutor(args, 'upload-pic');
    return;
  }
  if (args.command === 'transform-pic' || args.command === 'transform_pic') {
    await runImageAssetExecutor(args, 'transform-pic');
    return;
  }
  if (args.command === 'audit-status' || args.command === 'audit_status') {
    await runReadonlyExecutor(args, 'audit-status');
    return;
  }
  if (args.command === 'search-product' || args.command === 'search_product') {
    await runReadonlyExecutor(args, 'search-product');
    return;
  }
  if (args.command === 'publish-standard' || args.command === 'publish_standard') {
    await runReadonlyExecutor(args, 'publish-standard');
    return;
  }
  if (args.command === 'shelf-quota' || args.command === 'shelf_quota') {
    await runReadonlyExecutor(args, 'shelf-quota');
    return;
  }
  if (args.command === 'order-fulfillment' || args.command === 'order_fulfillment') {
    await runOrderFulfillmentExecutor(args);
    return;
  }
  if (args.command === 'openapi-catalog-plan' || args.command === 'openapi_catalog_plan') {
    await runCatalogPlan(args);
    return;
  }
  if (args.command === 'openapi-call' || args.command === 'openapi_call') {
    await runCatalogExecutor(args);
    return;
  }
  if (args.command === 'me') {
    const {json} = await request(args, '/api/auth/me');
    print(json);
    return;
  }
  if (args.command === 'capabilities') {
    const {json} = await request(args, '/api/openapi-capabilities');
    print(json, !args.json);
    return;
  }
  if (args.command === 'query') {
    await runDirectBiQuery(args);
    return;
  }
  if (args.command === 'ask') {
    await runDirectBiQuery(args, {legacyAlias: true});
    return;
  }
  if (args.command === 'chats') {
    const {json} = await request(args, `/api/link-ops-chats?limit=${encodeURIComponent(args.limit)}`);
    print(json.data || json, !args.json);
    return;
  }
  if (args.command === 'jobs') {
    const query = new URLSearchParams({limit: String(args.limit)});
    if (args.status) query.set('status', args.status);
    if (args.globalView) query.set('scope', 'all');
    const {json} = await request(args, `/api/link-ops-jobs?${query}`);
    print(json, !args.json);
    return;
  }
  if (args.command === 'job') {
    if (!args.jobId) throw new Error('job requires --job-id');
    const scope = args.globalView ? '?scope=all' : '';
    const {json} = await request(args, `/api/link-ops-jobs/${encodeURIComponent(args.jobId)}${scope}`);
    print(json.data || json, !args.json);
    return;
  }
  if (args.command === 'wait-job' || args.command === 'wait_job') {
    const job = await waitForLinkOpsJob(args, args.jobId);
    print({ok: job.status === 'succeeded', job}, !args.json);
    if (job.status !== 'succeeded') process.exitCode = 1;
    return;
  }
  if (args.command === 'chat') {
    if (!args.text) throw new Error('chat requires --text');
    const {json} = await request(args, '/api/link-ops-chats', {
      method: 'POST',
      body: {
        message: args.text,
        sessionId: args.chatSessionId || undefined,
        askAgent: args.askAgent,
        agentProfile: args.profile || undefined,
        source: 'codex_desktop_cli',
      },
    });
    const job = json.job || null;
    const completedJob = job && args.waitSeconds > 0 ? await waitForLinkOpsJob(args, job.id) : null;
    print({ok: true, session: json.session, autoTask: json.autoTask, job, completedJob, data: json.data, taskData: json.taskData});
    return;
  }
  if (args.command === 'tasks') {
    const scoped = args.chatSessionId ? `&sessionId=${encodeURIComponent(args.chatSessionId)}` : '';
    const {json} = await request(args, `/api/link-ops-tasks?limit=${encodeURIComponent(args.limit)}${scoped}`);
    print(json.data || json, !args.json);
    return;
  }
  if (args.command === 'create' || args.command === 'operate') {
    if (!args.text) throw new Error(`${args.command} requires --text`);
    if (args.command === 'operate' && !args.operation) {
      throw new Error('operate requires --operation <supported operation>');
    }
    const {json} = await request(args, '/api/link-ops-tasks', {
      method: 'POST',
      body: {
        command: args.text,
        source: args.operation ? 'codex_desktop_cli_structured' : 'codex_desktop_cli',
        intents: args.operation ? [args.operation] : undefined,
        targets: taskTargets(args),
        parameters: taskParameters(args),
      },
    });
    if (args.command === 'create') {
      print({ok: true, task: json.task, data: json.data, aiInvoked: false});
      return;
    }
    const taskId = json.task?.id || json.data?.task?.id || '';
    if (!taskId) throw new Error('operate created no task id');
    const {json: preflightJson} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: taskId, mode: 'dry-run', source: 'codex_desktop_cli_structured'},
      allowJsonFailure: true,
    });
    const output = {
      ...linkOpsExecutionResponse(preflightJson, {fallbackTask: json.task}),
      aiInvoked: false,
      mode: 'structured-operation',
      nextStep: preflightJson.ok === false
        ? '任务已保留；请按 task ID 处理 blockers 后重跑 preflight，勿重复 operate 创建任务。'
        : '核对系统检查结果；只有用户明确确认后才调用 execute。',
    };
    print(output);
    applyLinkOpsExecutionExitCode(output);
    return;
  }
  if (args.command === 'authorize-duplicate-publish') {
    if (!args.taskId) throw new Error('authorize-duplicate-publish requires --task-id');
    const store = [...new Set([...(args.writeStores || []), ...(args.stores || [])])][0] || '';
    if (!store) throw new Error('authorize-duplicate-publish requires --store <target store>');
    if (!args.skcList.length) throw new Error('authorize-duplicate-publish requires --skc <existing SKC>');
    if (!args.note) throw new Error('authorize-duplicate-publish requires --note <business reason>');
    if (args.confirm !== ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT) {
      throw new Error(`authorize-duplicate-publish requires --confirm ${ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT}`);
    }
    const {json} = await request(args, '/api/link-ops-tasks', {
      method: 'PATCH',
      body: {
        id: args.taskId,
        event: 'authorize_additional_same_code_link_cli',
        duplicatePublishOverride: {
          store,
          existingSkcs: args.skcList,
          reason: args.note,
          confirmation: args.confirm,
        },
      },
    });
    print({ok: true, task: json.task, data: json.data});
    return;
  }
  if (args.command === 'preflight') {
    if (!args.taskId) throw new Error('preflight requires --task-id');
    const {json} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: args.taskId, mode: 'dry-run', source: 'codex_desktop_cli'},
      allowJsonFailure: true,
    });
    const output = linkOpsExecutionResponse(json);
    print(output);
    applyLinkOpsExecutionExitCode(output);
    return;
  }
  if (args.command === 'execute') {
    if (!args.taskId) throw new Error('execute requires --task-id');
    if (args.confirm !== SUBMIT_CONFIRM_TEXT) throw new Error(`execute requires --confirm ${SUBMIT_CONFIRM_TEXT}`);
    const {json} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: args.taskId, mode: 'execute', confirm: args.confirm, source: 'codex_desktop_cli'},
      allowJsonFailure: true,
    });
    const output = linkOpsExecutionResponse(json);
    print(output);
    applyLinkOpsExecutionExitCode(output);
    return;
  }
  if (args.command === 'resolve') {
    if (!args.taskId) throw new Error('resolve requires --task-id');
    const status = args.status || 'done';
    if (!['done', 'archived'].includes(status)) throw new Error('resolve --status must be done or archived');
    if (!args.note) throw new Error('resolve requires --note to explain the manual decision');
    const {json} = await request(args, '/api/link-ops-tasks', {
      method: 'PATCH',
      body: {id: args.taskId, status, note: args.note, event: 'manual_lifecycle_resolve_cli'},
    });
    print({ok: true, task: json.task, data: json.data});
    return;
  }
  if (args.command === 'audit') {
    if (!args.taskId) throw new Error('audit requires --task-id');
    const {json} = await request(args, `/api/link-ops-audit?taskId=${encodeURIComponent(args.taskId)}&limit=${encodeURIComponent(args.limit)}`);
    print(json);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch(err => {
  const out = {
    ok: false,
    error: String(err?.message || String(err)).replace(/[A-Za-z]:[\\/][^\r\n"']+/g, '[local-path-redacted]').slice(0, 1000),
    code: err?.code || null,
    status: err?.status || null,
  };
  console.error(JSON.stringify(out, null, 2));
  process.exitCode = 1;
});
