import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_MESSAGE_BYTES = 64 * 1024;

export class ProtocolError extends Error {
  constructor(message = 'Invalid protocol message') {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function safeTokenEqual(actual, expected) {
  const validTypes = typeof actual === 'string' && typeof expected === 'string';
  const actualBuffer = Buffer.from(typeof actual === 'string' ? actual : '');
  const expectedBuffer = Buffer.from(typeof expected === 'string' ? expected : '');
  const actualDigest = createHash('sha256').update(actualBuffer).digest();
  const expectedDigest = createHash('sha256').update(expectedBuffer).digest();
  const digestsEqual = timingSafeEqual(actualDigest, expectedDigest);

  return validTypes
    && actualBuffer.length === expectedBuffer.length
    && digestsEqual;
}

export function isAllowedOrigin(origin, allowedOrigins) {
  const entries = Array.isArray(allowedOrigins)
    ? allowedOrigins
    : typeof allowedOrigins === 'string'
      ? allowedOrigins.split(',')
      : [];

  const candidate = parseHttpOrigin(origin);
  if (candidate === null) {
    return false;
  }

  return entries.some((entry) => {
    const allowed = typeof entry === 'string'
      ? parseHttpOrigin(entry.trim())
      : null;
    return allowed !== null && allowed === candidate;
  });
}

function parseHttpOrigin(value) {
  if (typeof value !== 'string' || value === '') {
    return null;
  }

  const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[^/?#@:\\\s%]+)(?::([0-9]+))?\/?$/.exec(value);
  if (match === null) {
    return null;
  }

  const [, protocol, rawHost, rawPort] = match;
  if (rawPort !== undefined) {
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || String(port) !== rawPort) {
      return null;
    }
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
    ) {
      return null;
    }

    const defaultPort = protocol === 'https' ? '443' : '80';
    const normalizedPort = rawPort === undefined || rawPort === defaultPort
      ? ''
      : `:${rawPort}`;
    const safelyNormalizedOrigin = `${protocol}://${rawHost.toLowerCase()}${normalizedPort}`;
    if (url.origin !== safelyNormalizedOrigin) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function clampTerminalSize(cols, rows) {
  return {
    cols: Math.min(240, Math.max(20, cols)),
    rows: Math.min(100, Math.max(5, rows)),
  };
}

export function parseClientMessage(raw, isBinary = false) {
  if (isBinary) {
    throw new ProtocolError();
  }

  let payload;
  if (typeof raw === 'string') {
    payload = raw;
  } else if (Buffer.isBuffer(raw) || ArrayBuffer.isView(raw)) {
    payload = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  } else if (raw instanceof ArrayBuffer) {
    payload = Buffer.from(raw).toString('utf8');
  } else {
    throw new ProtocolError();
  }

  if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new ProtocolError();
  }

  let message;
  try {
    message = JSON.parse(payload);
  } catch {
    throw new ProtocolError();
  }

  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new ProtocolError();
  }

  switch (message.type) {
    case 'auth':
      if (typeof message.token !== 'string') {
        throw new ProtocolError();
      }
      return { type: 'auth', token: message.token };

    case 'input':
      if (typeof message.data !== 'string') {
        throw new ProtocolError();
      }
      return { type: 'input', data: message.data };

    case 'resize':
      if (
        typeof message.cols !== 'number'
        || typeof message.rows !== 'number'
        || !Number.isInteger(message.cols)
        || !Number.isInteger(message.rows)
      ) {
        throw new ProtocolError();
      }
      return { type: 'resize', ...clampTerminalSize(message.cols, message.rows) };

    default:
      throw new ProtocolError();
  }
}

export function serverMessage(type, fields = {}) {
  if (typeof type !== 'string' || type.length === 0) {
    throw new ProtocolError();
  }

  if (fields === null || typeof fields !== 'object') {
    throw new ProtocolError();
  }

  const prototype = Object.getPrototypeOf(fields);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolError();
  }

  const reservedKeys = new Set([
    'type',
    'toJSON',
    '__proto__',
    'constructor',
    'prototype',
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(fields);
  const payload = Object.create(null);
  payload.type = type;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || reservedKeys.has(key)) {
      throw new ProtocolError();
    }

    const descriptor = descriptors[key];
    if ('get' in descriptor || 'set' in descriptor) {
      throw new ProtocolError();
    }

    if (descriptor.enumerable) {
      payload[key] = descriptor.value;
    }
  }

  return JSON.stringify(payload);
}
