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

function isDigit(byte) {
  return byte >= 0x30 && byte <= 0x39;
}

function isNonZeroDigit(byte) {
  return byte >= 0x31 && byte <= 0x39;
}

function isHexDigit(byte) {
  return isDigit(byte)
    || (byte >= 0x41 && byte <= 0x46)
    || (byte >= 0x61 && byte <= 0x66);
}

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function fail(code, message) {
  throw new BoundedTopLevelJsonError(code, message);
}

class StreamingJsonSyntaxValidator {
  constructor() {
    this.stack = [];
    this.token = null;
    this.started = false;
    this.done = false;
  }

  expectedState() {
    return this.stack.at(-1)?.state || (this.started ? 'done' : 'root');
  }

  completeValue(offset) {
    const parent = this.stack.at(-1);
    if (!parent) {
      this.done = true;
      return;
    }
    if (!['value', 'valueOrEnd'].includes(parent.state)) {
      fail('INVALID_JSON_SYNTAX', `Unexpected completed value at byte ${offset}`);
    }
    parent.state = 'commaOrEnd';
  }

  closeContainer(type, byte, offset) {
    const container = this.stack.at(-1);
    if (!container || container.type !== type) {
      fail('MISMATCHED_DELIMITER', `Mismatched JSON delimiter at byte ${offset}`);
    }
    if (type === 'object' && !['keyOrEnd', 'commaOrEnd'].includes(container.state)) {
      fail('INVALID_JSON_SYNTAX', `Object closed before a value completed at byte ${offset}`);
    }
    if (type === 'array' && !['valueOrEnd', 'commaOrEnd'].includes(container.state)) {
      fail('INVALID_JSON_SYNTAX', `Array closed before a value completed at byte ${offset}`);
    }
    this.stack.pop();
    if (!this.stack.length) {
      this.done = true;
    } else {
      this.completeValue(offset);
    }
  }

  startString(role) {
    this.token = {type: 'string', role, escaped: false, unicodeRemaining: 0};
  }

  startScalar(byte, offset) {
    if (byte === 0x74) this.token = {type: 'literal', expected: 'true', index: 1};
    else if (byte === 0x66) this.token = {type: 'literal', expected: 'false', index: 1};
    else if (byte === 0x6e) this.token = {type: 'literal', expected: 'null', index: 1};
    else if (byte === 0x2d) this.token = {type: 'number', state: 'sign'};
    else if (byte === 0x30) this.token = {type: 'number', state: 'zero'};
    else if (isNonZeroDigit(byte)) this.token = {type: 'number', state: 'integer'};
    else fail('INVALID_JSON_SYNTAX', `Invalid JSON value at byte ${offset}`);
  }

  scalarComplete() {
    if (this.token?.type === 'literal') return this.token.index === this.token.expected.length;
    return this.token?.type === 'number'
      && ['zero', 'integer', 'fraction', 'exponent'].includes(this.token.state);
  }

  advanceScalar(byte, offset) {
    const token = this.token;
    if (token.type === 'literal') {
      if (token.index >= token.expected.length
        || byte !== token.expected.charCodeAt(token.index)) {
        fail('INVALID_JSON_SYNTAX', `Invalid JSON literal at byte ${offset}`);
      }
      token.index += 1;
      return;
    }
    switch (token.state) {
      case 'sign':
        if (byte === 0x30) token.state = 'zero';
        else if (isNonZeroDigit(byte)) token.state = 'integer';
        else fail('INVALID_JSON_SYNTAX', `Invalid JSON number at byte ${offset}`);
        break;
      case 'zero':
        if (byte === 0x2e) token.state = 'fractionStart';
        else if (byte === 0x65 || byte === 0x45) token.state = 'exponentStart';
        else fail('INVALID_JSON_SYNTAX', `Invalid JSON number at byte ${offset}`);
        break;
      case 'integer':
        if (isDigit(byte)) break;
        if (byte === 0x2e) token.state = 'fractionStart';
        else if (byte === 0x65 || byte === 0x45) token.state = 'exponentStart';
        else fail('INVALID_JSON_SYNTAX', `Invalid JSON number at byte ${offset}`);
        break;
      case 'fractionStart':
        if (!isDigit(byte)) fail('INVALID_JSON_SYNTAX', `Invalid JSON fraction at byte ${offset}`);
        token.state = 'fraction';
        break;
      case 'fraction':
        if (isDigit(byte)) break;
        if (byte === 0x65 || byte === 0x45) token.state = 'exponentStart';
        else fail('INVALID_JSON_SYNTAX', `Invalid JSON fraction at byte ${offset}`);
        break;
      case 'exponentStart':
        if (byte === 0x2b || byte === 0x2d) token.state = 'exponentSign';
        else if (isDigit(byte)) token.state = 'exponent';
        else fail('INVALID_JSON_SYNTAX', `Invalid JSON exponent at byte ${offset}`);
        break;
      case 'exponentSign':
        if (!isDigit(byte)) fail('INVALID_JSON_SYNTAX', `Invalid JSON exponent at byte ${offset}`);
        token.state = 'exponent';
        break;
      case 'exponent':
        if (!isDigit(byte)) fail('INVALID_JSON_SYNTAX', `Invalid JSON exponent at byte ${offset}`);
        break;
      default:
        fail('INVALID_JSON_SYNTAX', `Invalid scalar state at byte ${offset}`);
    }
  }

  push(byte, offset) {
    let reprocess = true;
    while (reprocess) {
      reprocess = false;
      if (this.token?.type === 'string') {
        const token = this.token;
        if (token.unicodeRemaining > 0) {
          if (!isHexDigit(byte)) fail('INVALID_JSON_SYNTAX', `Invalid unicode escape at byte ${offset}`);
          token.unicodeRemaining -= 1;
          if (token.unicodeRemaining === 0) token.escaped = false;
          return;
        }
        if (token.escaped) {
          if (byte === 0x75) token.unicodeRemaining = 4;
          else if ([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(byte)) token.escaped = false;
          else fail('INVALID_JSON_SYNTAX', `Invalid string escape at byte ${offset}`);
          return;
        }
        if (byte < 0x20) fail('INVALID_JSON_SYNTAX', `Unescaped control byte in string at byte ${offset}`);
        if (byte === ASCII.backslash) token.escaped = true;
        else if (byte === ASCII.quote) {
          this.token = null;
          if (token.role === 'key') this.stack.at(-1).state = 'colon';
          else this.completeValue(offset);
        }
        return;
      }

      if (this.token) {
        const delimiter = isWhitespace(byte)
          || byte === ASCII.comma || byte === ASCII.closeObject || byte === ASCII.closeArray;
        if (delimiter) {
          if (!this.scalarComplete()) fail('INVALID_JSON_SYNTAX', `Incomplete JSON scalar at byte ${offset}`);
          this.token = null;
          this.completeValue(offset);
          reprocess = true;
          continue;
        }
        this.advanceScalar(byte, offset);
        return;
      }

      if (isWhitespace(byte)) return;
      if (this.done) fail('TRAILING_CONTENT', `Unexpected content after JSON root at byte ${offset}`);
      if (!this.started) {
        if (byte !== ASCII.openObject) fail('ROOT_NOT_OBJECT', 'JSON root must be an object');
        this.started = true;
        this.stack.push({type: 'object', state: 'keyOrEnd'});
        return;
      }

      const container = this.stack.at(-1);
      if (!container) fail('INVALID_JSON_SYNTAX', `Missing JSON container at byte ${offset}`);
      if (container.type === 'object') {
        if (container.state === 'keyOrEnd') {
          if (byte === ASCII.closeObject) this.closeContainer('object', byte, offset);
          else if (byte === ASCII.quote) this.startString('key');
          else fail('INVALID_JSON_SYNTAX', `Expected object key at byte ${offset}`);
          return;
        }
        if (container.state === 'key') {
          if (byte !== ASCII.quote) fail('INVALID_JSON_SYNTAX', `Expected object key at byte ${offset}`);
          this.startString('key');
          return;
        }
        if (container.state === 'colon') {
          if (byte !== ASCII.colon) fail('INVALID_JSON_SYNTAX', `Expected colon at byte ${offset}`);
          container.state = 'value';
          return;
        }
        if (container.state === 'commaOrEnd') {
          if (byte === ASCII.comma) container.state = 'key';
          else if (byte === ASCII.closeObject) this.closeContainer('object', byte, offset);
          else fail('INVALID_JSON_SYNTAX', `Expected object delimiter at byte ${offset}`);
          return;
        }
      } else if (container.state === 'commaOrEnd') {
        if (byte === ASCII.comma) container.state = 'value';
        else if (byte === ASCII.closeArray) this.closeContainer('array', byte, offset);
        else fail('INVALID_JSON_SYNTAX', `Expected array delimiter at byte ${offset}`);
        return;
      } else if (container.state === 'valueOrEnd' && byte === ASCII.closeArray) {
        this.closeContainer('array', byte, offset);
        return;
      }

      if (!['value', 'valueOrEnd'].includes(container.state)) {
        fail('INVALID_JSON_SYNTAX', `Expected JSON value at byte ${offset}`);
      }
      if (byte === ASCII.openObject) this.stack.push({type: 'object', state: 'keyOrEnd'});
      else if (byte === ASCII.openArray) this.stack.push({type: 'array', state: 'valueOrEnd'});
      else if (byte === ASCII.quote) this.startString('value');
      else this.startScalar(byte, offset);
      return;
    }
  }

  finish() {
    if (this.token || this.stack.length || !this.done) {
      fail('TRUNCATED_JSON', 'JSON document is truncated');
    }
  }
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
  const syntax = new StreamingJsonSyntaxValidator();
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
      syntax.push(byte, offset);

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
  syntax.finish();
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
