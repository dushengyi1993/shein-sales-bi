import fs from 'node:fs/promises';
import path from 'node:path';

export const UPLOAD_PIC_ENDPOINT = '/open-api/goods/upload-pic';
export const SHEIN_IMAGE_TYPE_LABELS = Object.freeze({
  1: 'main',
  2: 'detail',
  5: 'square',
  6: 'color_swatch',
  7: 'site_detail',
});
const VALID_IMAGE_TYPES = new Set(Object.keys(SHEIN_IMAGE_TYPE_LABELS).map(Number));
const VALID_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function normalizeImageType(imageType) {
  const n = Number(imageType);
  return Number.isInteger(n) ? n : NaN;
}

function imageContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

export async function inspectUploadPicInput({imageType, filePath}) {
  const type = normalizeImageType(imageType);
  const blockers = [];
  if (!VALID_IMAGE_TYPES.has(type)) blockers.push(`image_type must be one of 1/2/5/6/7; got ${imageType}`);
  if (!filePath) blockers.push('filePath is required');
  const resolvedFilePath = filePath ? path.resolve(filePath) : '';
  let file = null;
  if (resolvedFilePath) {
    const ext = path.extname(resolvedFilePath).toLowerCase();
    if (!VALID_EXTENSIONS.has(ext)) blockers.push(`upload-pic only accepts JPG/JPEG/PNG files; got ${ext || '(none)'}`);
    try {
      const stat = await fs.stat(resolvedFilePath);
      if (!stat.isFile()) blockers.push(`filePath is not a file: ${resolvedFilePath}`);
      if (stat.size > MAX_IMAGE_BYTES) blockers.push(`image exceeds 3MB OpenAPI limit: ${stat.size} bytes`);
      file = {path: resolvedFilePath, filename: path.basename(resolvedFilePath), size: stat.size, contentType: imageContentType(resolvedFilePath)};
    } catch (err) {
      blockers.push(`image file not found: ${resolvedFilePath}`);
    }
  }
  return {
    ok: blockers.length === 0,
    blockers,
    imageType: type,
    imageTypeLabel: SHEIN_IMAGE_TYPE_LABELS[type] || '',
    file,
  };
}

export function buildUploadPicPlan(input) {
  return {
    endpoint: UPLOAD_PIC_ENDPOINT,
    method: 'POST',
    contentType: 'multipart/form-data',
    fields: {image_type: String(input.imageType)},
    file: input.file ? {
      filename: input.file.filename,
      size: input.file.size,
      contentType: input.file.contentType,
    } : null,
    imageTypeLabel: input.imageTypeLabel,
  };
}

export async function executeUploadPic(client, params, {mode = 'dry-run'} = {}) {
  const input = await inspectUploadPicInput(params || {});
  const plan = buildUploadPicPlan(input);
  if (!input.ok) return {ok: false, mode, endpoint: UPLOAD_PIC_ENDPOINT, plan, blockers: input.blockers};
  if (mode !== 'execute') {
    return {ok: true, mode: 'dry-run', endpoint: UPLOAD_PIC_ENDPOINT, plan, note: 'dry-run only validates local file and payload; it does not upload to SHEIN.'};
  }
  const data = await fs.readFile(input.file.path);
  const form = new FormData();
  form.set('image_type', String(input.imageType));
  form.set('file', new Blob([data], {type: input.file.contentType}), input.file.filename);
  const requestMultipart = typeof client.requestMultipart === 'function'
    ? client.requestMultipart.bind(client)
    : (endpoint, options) => client.request(endpoint, {...options, body: options.formData});
  const response = await requestMultipart(UPLOAD_PIC_ENDPOINT, {
    method: 'POST',
    formData: form,
    headers: {language: 'zh-cn'},
  });
  const code = String(response.data?.code ?? '');
  const ok = response.ok && code === '0';
  const info = response.data?.info || {};
  return {
    ok,
    mode: 'execute',
    endpoint: UPLOAD_PIC_ENDPOINT,
    code,
    msg: response.data?.msg || '',
    traceId: response.data?.traceId || '',
    result: {
      imageUrl: info.image_url || '',
      width: Number(info.width || 0),
      height: Number(info.height || 0),
      size: Number(info.size || 0),
      imageHexType: info.image_hex_type || '',
    },
    blockers: ok ? [] : [`upload-pic failed: code=${code || '(missing)'} msg=${response.data?.msg || response.statusText || ''}`],
  };
}
