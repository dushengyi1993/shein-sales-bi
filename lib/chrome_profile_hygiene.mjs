import fs from 'node:fs';
import path from 'node:path';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFileIfPresent(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Publish complete UTF-8 bytes through a same-directory exclusive temporary,
 * file fsync, and rename. Trusted local Chrome profiles only need this small
 * synchronous boundary; `beforeRename` is a test-only fault hook.
 */
export function writeTextFileAtomicSync(file, text, options = {}) {
  const target = path.resolve(String(file || ''));
  if (!file) throw new TypeError('Chrome profile metadata file is required');
  const directory = path.dirname(target);
  fs.mkdirSync(directory, {recursive: true});
  const bytes = Buffer.isBuffer(text) ? Buffer.from(text) : Buffer.from(String(text), 'utf8');
  const existingBytes = readFileIfPresent(target);
  if (existingBytes?.equals(bytes)) return {file: target, changed: false, bytes: bytes.length};
  let existingMode;
  try {
    existingMode = fs.statSync(target).mode & 0o7777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const mode = existingMode ?? (options.mode === undefined ? 0o666 : options.mode);
  const enforceMode = existingMode !== undefined || options.mode !== undefined;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new TypeError('Chrome profile metadata mode must be an integer between 0 and 07777');
  }
  const temporary = path.join(directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd;
  let renamed = false;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    if (enforceMode && typeof fs.fchmodSync === 'function') fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (typeof options.beforeRename === 'function') options.beforeRename(temporary, target);
    fs.renameSync(temporary, target);
    renamed = true;
    return {file: target, changed: true, bytes: bytes.length, mode};
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (!renamed) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

export function writeJsonFileAtomicSync(file, value, options = {}) {
  const spacing = options.spacing === undefined ? 2 : options.spacing;
  const suffix = options.trailingNewline === true ? '\n' : '';
  const serialized = JSON.stringify(value, null, spacing);
  if (typeof serialized !== 'string') throw new TypeError('Chrome profile metadata JSON value is not serializable');
  return writeTextFileAtomicSync(file, `${serialized}${suffix}`, options);
}

export const writeAtomicTextSync = writeTextFileAtomicSync;
export const writeAtomicJsonSync = writeJsonFileAtomicSync;

/** Read a JSON object without treating malformed data as {}. */
export function readJsonFileSync(file, {allowMissing = true} = {}) {
  const bytes = readFileIfPresent(file);
  if (!bytes) {
    if (allowMissing) return undefined;
    throw new Error(`Chrome profile metadata file is missing: ${file}`);
  }
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  let value;
  try {
    if (!text.trim()) throw new SyntaxError('empty JSON document');
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Chrome profile metadata JSON is invalid: ${file}`, {cause: error});
  }
  if (!isPlainObject(value)) {
    throw new Error(`Chrome profile metadata JSON root must be an object: ${file}`);
  }
  return value;
}

// SHEIN automation does not use Chrome's local generative-AI model. Keep both
// the browser-level setting and command-line feature gates disabled: the
// setting is the durable control, while the flags protect newly created or
// temporarily incomplete profiles before Local State is persisted.
export const SHEIN_CHROME_DISABLED_MODEL_FEATURES = Object.freeze([
  'OptimizationGuideOnDeviceModel',
  'OptimizationGuideModelDownloading',
  'OptimizationGuideModelExecution',
  'PromptAPIForGeminiNano',
  'SummarizationAPIForGeminiNano',
  'WriterAPIForGeminiNano',
  'RewriterAPIForGeminiNano',
]);

export function chromeDisabledFeaturesArg(extraFeatures = []) {
  const features = [...new Set([
    ...SHEIN_CHROME_DISABLED_MODEL_FEATURES,
    ...extraFeatures.filter(Boolean),
  ])];
  return `--disable-features=${features.join(',')}`;
}

export function readChromeOnDeviceAiSetting(profileDir) {
  const resolvedProfile = path.resolve(profileDir);
  const localStatePath = path.join(resolvedProfile, 'Local State');
  if (!fs.existsSync(resolvedProfile)) {
    return {profileDir: resolvedProfile, localStatePath, exists: false, value: undefined, disabled: false};
  }
  const localState = readJsonFileSync(localStatePath, {allowMissing: true});
  if (!localState) {
    return {profileDir: resolvedProfile, localStatePath, exists: false, value: undefined, disabled: false};
  }
  const value = localState?.optimization_guide?.on_device_foundational_model_user_settings;
  return {profileDir: resolvedProfile, localStatePath, exists: true, value, disabled: value === false};
}

export function disableChromeOnDeviceAiForProfile(profileDir) {
  const resolvedProfile = path.resolve(profileDir);
  const localStatePath = path.join(resolvedProfile, 'Local State');
  fs.mkdirSync(resolvedProfile, {recursive: true});

  const localState = readJsonFileSync(localStatePath, {allowMissing: true}) || {};
  if (localState.optimization_guide === undefined) localState.optimization_guide = {};
  if (!isPlainObject(localState.optimization_guide)) {
    throw new Error(`Chrome Local State optimization_guide must be an object: ${localStatePath}`);
  }
  const previous = localState.optimization_guide.on_device_foundational_model_user_settings;
  let changed = false;
  if (previous !== false) {
    localState.optimization_guide.on_device_foundational_model_user_settings = false;
    changed = writeJsonFileAtomicSync(localStatePath, localState).changed;
  }
  return {
    profileDir: resolvedProfile,
    localStatePath,
    previous,
    disabled: true,
    changed,
  };
}
