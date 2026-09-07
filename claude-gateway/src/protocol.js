import { timingSafeEqual } from 'node:crypto';

export const MAX_MESSAGE_BYTES = 64 * 1024;

export class ProtocolError extends Error {
  constructor(message = 'Invalid protocol message') {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') {
    return false;
  }

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isAllowedOrigin(origin, allowedOrigins) {
  if (typeof origin !== 'string') {
    return false;
  }

  const entries = Array.isArray(allowedOrigins)
    ? allowedOrigins
    : typeof allowedOrigins === 'string'
      ? allowedOrigins.split(',')
      : [];

  let candidate;
  try {
    candidate = new URL(origin).origin;
  } catch {
    return false;
  }

  return entries.some((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return false;
    }

    try {
      return new URL(entry.trim()).origin === candidate;
    } catch {
      return false;
    }
  });
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
        || !Number.isFinite(message.cols)
        || !Number.isFinite(message.rows)
      ) {
        throw new ProtocolError();
      }
      return { type: 'resize', ...clampTerminalSize(message.cols, message.rows) };

    default:
      throw new ProtocolError();
  }
}

export function serverMessage(type, fields = {}) {
  return JSON.stringify({ type, ...fields });
}
