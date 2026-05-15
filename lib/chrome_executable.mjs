import fss from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function isWindowsDrivePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || ''));
}

function commandExists(command) {
  if (!command) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', [command], {stdio: 'ignore', windowsHide: true});
    return result.status === 0;
  }
  const result = spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {stdio: 'ignore'});
  return result.status === 0;
}

export function findChromeExecutable() {
  const envPath = process.env.CHROME_PATH?.trim();
  const windowsCandidates = [
    'D:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'chrome.exe',
  ];
  const linuxCandidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ];
  const candidates = [
    envPath,
    ...(process.platform === 'win32' ? windowsCandidates : linuxCandidates),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isWindowsDrivePath(candidate)) {
      if (process.platform === 'win32' && fss.existsSync(candidate)) return candidate;
      continue;
    }
    if (path.isAbsolute(candidate)) {
      if (fss.existsSync(candidate)) return candidate;
      continue;
    }
    if (commandExists(candidate)) return candidate;
  }
  return null;
}

export function requireChromeExecutable(context = 'Chrome/Chromium') {
  const executable = findChromeExecutable();
  if (!executable) throw new Error(`Cannot find ${context} executable. Set CHROME_PATH or install Chrome/Chromium.`);
  return executable;
}
