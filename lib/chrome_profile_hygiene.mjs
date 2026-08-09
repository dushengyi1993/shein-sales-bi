import fs from 'node:fs';
import path from 'node:path';

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
  if (!fs.existsSync(localStatePath)) {
    return {profileDir: resolvedProfile, localStatePath, exists: false, value: undefined, disabled: false};
  }
  const text = fs.readFileSync(localStatePath, 'utf8').replace(/^\uFEFF/, '');
  const localState = text.trim() ? JSON.parse(text) : {};
  const value = localState?.optimization_guide?.on_device_foundational_model_user_settings;
  return {profileDir: resolvedProfile, localStatePath, exists: true, value, disabled: value === false};
}

export function disableChromeOnDeviceAiForProfile(profileDir) {
  const resolvedProfile = path.resolve(profileDir);
  const localStatePath = path.join(resolvedProfile, 'Local State');
  fs.mkdirSync(resolvedProfile, {recursive: true});

  let localState = {};
  if (fs.existsSync(localStatePath)) {
    const text = fs.readFileSync(localStatePath, 'utf8').replace(/^\uFEFF/, '');
    localState = text.trim() ? JSON.parse(text) : {};
  }
  localState.optimization_guide ||= {};
  const previous = localState.optimization_guide.on_device_foundational_model_user_settings;
  if (previous !== false) {
    localState.optimization_guide.on_device_foundational_model_user_settings = false;
    fs.writeFileSync(localStatePath, JSON.stringify(localState, null, 2), 'utf8');
  }
  return {
    profileDir: resolvedProfile,
    localStatePath,
    previous,
    disabled: true,
    changed: previous !== false,
  };
}
