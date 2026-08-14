export class BoundedTopLevelJsonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoundedTopLevelJsonError';
    this.code = code;
  }
}

const ASCII = {
  quote: 0x22,
  backslash: 0x5c,
  openObject: 0x7b,
  closeObject: 0x7d,
  openArray: 0x5b,
  closeArray: 0x5d,
  colon: 0x3a,
  comma: 0x2c,
};

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function fail(code, message) {
  throw new BoundedTopLevelJsonError(code, message);
}

function normalizeLimits(limits) {
  const out = new Map();
  for (const [key, value] of Object.entries(limits || {})) {
    const limit = Number(value);
    if (!key || !Number.isSafeInteger(limit) || limit <= 0) {
      fail('INVALID_FIELD_LIMIT', `Invalid capture limit for ${key || '(empty)'}`);
    }
    out.set(key, limit);
  }
  if (!out.size) fail('NO_FIELDS_REQUESTED', 'At least one top-level field must be requested');
  return out;
}

/**
 * Scan a UTF-8 JSON object without materialising the complete document.
 * Only requested top-level values are retained, each under an explicit byte
 * budget. Structural framing, duplicate requested keys and truncated input
 * fail closed. Returned ranges use byte offsets: [start, end).
 */
export async function scanBoundedTopLevelJson(readable, limits) {
  const captureLimits = normalizeLimits(limits);
  const fields = new Map();
  const stack = [];
  let phase = 'beforeRoot';
  let offset = 0;
  let inString = false;
  let escaped = false;
  let stringRole = '';
  let keyBytes = [];
  let currentKey = '';
  let valueKind = '';
  let valueStart = -1;
  let capture = null;
  let captureLength = 0;
  let scalarLastNonWhitespaceLength = 0;
  let scalarLastNonWhitespaceOffset = -1;

  const appendCapture = byte => {
    if (!capture) return;
    if (captureLength >= capture.length) {
      fail('FIELD_TOO_LARGE', `Top-level field ${currentKey} exceeds ${capture.length} bytes`);
    }
    capture[captureLength++] = byte;
  };

  const startValue = (kind, byte, byteOffset) => {
    valueKind = kind;
    valueStart = byteOffset;
    const limit = captureLimits.get(currentKey);
    capture = limit ? Buffer.allocUnsafe(limit) : null;
    captureLength = 0;
    scalarLastNonWhitespaceLength = 0;
    scalarLastNonWhitespaceOffset = -1;
    appendCapture(byte);
    if (kind === 'scalar' && !isWhitespace(byte)) {
      scalarLastNonWhitespaceLength = captureLength;
      scalarLastNonWhitespaceOffset = byteOffset;
    }
  };

  const finishValue = endOffset => {
    if (!valueKind) fail('INTERNAL_STATE', 'Attempted to finish a missing value');
    if (captureLimits.has(currentKey)) {
      if (fields.has(currentKey)) fail('DUPLICATE_FIELD', `Duplicate top-level field ${currentKey}`);
      const usedLength = valueKind === 'scalar' ? scalarLastNonWhitespaceLength : captureLength;
      const usedEnd = valueKind === 'scalar' ? scalarLastNonWhitespaceOffset + 1 : endOffset;
      if (usedLength <= 0 || usedEnd <= valueStart) fail('INVALID_FIELD_VALUE', `Invalid value for ${currentKey}`);
      const raw = Buffer.from(capture.subarray(0, usedLength));
      let value;
      try {
        value = JSON.parse(raw.toString('utf8'));
      } catch {
        fail('INVALID_FIELD_JSON', `Top-level field ${currentKey} is not valid JSON`);
      }
      fields.set(currentKey, {value, raw, start: valueStart, end: usedEnd});
    }
    valueKind = '';
    valueStart = -1;
    capture = null;
    captureLength = 0;
    currentKey = '';
    phase = 'commaOrEnd';
  };

  const closeComposite = (byte, byteOffset) => {
    const expected = byte === ASCII.closeObject ? ASCII.openObject : ASCII.openArray;
    if (stack.at(-1) !== expected) fail('MISMATCHED_DELIMITER', `Mismatched JSON delimiter at byte ${byteOffset}`);
    stack.pop();
    if (valueKind === 'composite' && stack.length === 1) finishValue(byteOffset + 1);
  };

  for await (const chunkValue of readable) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    for (let index = 0; index < chunk.length; index += 1, offset += 1) {
      const byte = chunk[index];

      if (inString) {
        if (stringRole === 'key') {
          keyBytes.push(byte);
          if (keyBytes.length > 1024) fail('KEY_TOO_LARGE', `Top-level key exceeds 1024 bytes at byte ${offset}`);
        } else if (valueKind) {
          appendCapture(byte);
        }
        if (escaped) {
          escaped = false;
          continue;
        }
        if (byte === ASCII.backslash) {
          escaped = true;
          continue;
        }
        if (byte !== ASCII.quote) continue;
        inString = false;
        if (stringRole === 'key') {
          try {
            currentKey = JSON.parse(Buffer.from(keyBytes).toString('utf8'));
          } catch {
            fail('INVALID_KEY_JSON', `Invalid top-level key at byte ${offset}`);
          }
          if (typeof currentKey !== 'string') fail('INVALID_KEY_JSON', `Non-string top-level key at byte ${offset}`);
          phase = 'colon';
        } else if (stringRole === 'value') {
          finishValue(offset + 1);
        }
        stringRole = '';
        continue;
      }

      if (valueKind === 'composite') {
        appendCapture(byte);
        if (byte === ASCII.quote) {
          inString = true;
          stringRole = 'nested';
        } else if (byte === ASCII.openObject || byte === ASCII.openArray) {
          stack.push(byte);
        } else if (byte === ASCII.closeObject || byte === ASCII.closeArray) {
          closeComposite(byte, offset);
        }
        continue;
      }

      if (valueKind === 'scalar') {
        if ((byte === ASCII.comma || byte === ASCII.closeObject) && stack.length === 1) {
          finishValue(offset);
          // The delimiter belongs to the root object and is processed below.
        } else {
          appendCapture(byte);
          if (!isWhitespace(byte)) {
            scalarLastNonWhitespaceLength = captureLength;
            scalarLastNonWhitespaceOffset = offset;
          }
          continue;
        }
      }

      if (phase === 'beforeRoot') {
        if (isWhitespace(byte)) continue;
        if (byte !== ASCII.openObject) fail('ROOT_NOT_OBJECT', 'JSON root must be an object');
        stack.push(byte);
        phase = 'keyOrEnd';
        continue;
      }

      if (phase === 'keyOrEnd') {
        if (isWhitespace(byte)) continue;
        if (byte === ASCII.closeObject && stack.length === 1) {
          stack.pop();
          phase = 'done';
          continue;
        }
        if (byte !== ASCII.quote || stack.length !== 1) fail('EXPECTED_KEY', `Expected top-level key at byte ${offset}`);
        inString = true;
        stringRole = 'key';
        keyBytes = [byte];
        continue;
      }

      if (phase === 'colon') {
        if (isWhitespace(byte)) continue;
        if (byte !== ASCII.colon) fail('EXPECTED_COLON', `Expected colon after ${currentKey} at byte ${offset}`);
        phase = 'value';
        continue;
      }

      if (phase === 'value') {
        if (isWhitespace(byte)) continue;
        if (byte === ASCII.quote) {
          startValue('string', byte, offset);
          inString = true;
          stringRole = 'value';
        } else if (byte === ASCII.openObject || byte === ASCII.openArray) {
          startValue('composite', byte, offset);
          stack.push(byte);
        } else if (byte === ASCII.closeObject || byte === ASCII.comma) {
          fail('MISSING_VALUE', `Missing value for ${currentKey} at byte ${offset}`);
        } else {
          startValue('scalar', byte, offset);
        }
        continue;
      }

      if (phase === 'commaOrEnd') {
        if (isWhitespace(byte)) continue;
        if (byte === ASCII.comma && stack.length === 1) {
          phase = 'keyOrEnd';
          continue;
        }
        if (byte === ASCII.closeObject && stack.length === 1) {
          stack.pop();
          phase = 'done';
          continue;
        }
        fail('EXPECTED_DELIMITER', `Expected comma or root end at byte ${offset}`);
      }

      if (phase === 'done' && !isWhitespace(byte)) {
        fail('TRAILING_CONTENT', `Unexpected content after JSON root at byte ${offset}`);
      }
    }
  }

  if (inString || escaped || valueKind || stack.length || phase !== 'done') {
    fail('TRUNCATED_JSON', 'JSON document is truncated');
  }
  return {byteLength: offset, fields: Object.fromEntries(fields)};
}

export async function* streamFileHandleWithReplacement(handle, stat, replacement = null) {
  const size = Number(stat?.size || 0);
  if (!replacement) {
    if (size > 0) yield* handle.createReadStream({start: 0, end: size - 1, autoClose: false});
    return;
  }
  const start = Number(replacement.start);
  const end = Number(replacement.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > size) {
    fail('INVALID_REPLACEMENT_RANGE', `Invalid replacement range ${start}:${end} for ${size} bytes`);
  }
  if (start > 0) yield* handle.createReadStream({start: 0, end: start - 1, autoClose: false});
  yield Buffer.isBuffer(replacement.value) ? replacement.value : Buffer.from(String(replacement.value), 'utf8');
  if (end < size) yield* handle.createReadStream({start: end, end: size - 1, autoClose: false});
}
