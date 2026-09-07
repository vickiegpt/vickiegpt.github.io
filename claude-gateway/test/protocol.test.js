import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_MESSAGE_BYTES,
  ProtocolError,
  clampTerminalSize,
  isAllowedOrigin,
  parseClientMessage,
  safeTokenEqual,
  serverMessage,
} from '../src/protocol.js';

function inputPayloadOfByteLength(byteLength) {
  const emptyPayload = JSON.stringify({ type: 'input', data: '' });
  const multibyteData = '界';
  const paddingLength = byteLength
    - Buffer.byteLength(emptyPayload)
    - Buffer.byteLength(multibyteData);

  assert.ok(paddingLength >= 0);
  const payload = JSON.stringify({
    type: 'input',
    data: multibyteData + 'x'.repeat(paddingLength),
  });
  assert.equal(Buffer.byteLength(payload), byteLength);
  return payload;
}

test('safeTokenEqual accepts equal tokens', () => {
  assert.equal(safeTokenEqual('secret-token', 'secret-token'), true);
});

test('safeTokenEqual rejects unequal tokens of equal length', () => {
  assert.equal(safeTokenEqual('secret-token', 'public-token'), false);
});

test('safeTokenEqual rejects tokens of unequal length', () => {
  assert.equal(safeTokenEqual('short', 'a-longer-token'), false);
});

test('safeTokenEqual compares unequal UTF-8 tokens with equal byte lengths', () => {
  assert.equal(safeTokenEqual('é', 'ab'), false);
});

test('safeTokenEqual rejects UTF-8 tokens with equal character lengths but unequal byte lengths', () => {
  assert.equal(safeTokenEqual('é', 'a'), false);
});

test('safeTokenEqual accepts equal empty tokens', () => {
  assert.equal(safeTokenEqual('', ''), true);
});

test('isAllowedOrigin accepts an exactly listed origin from a string', () => {
  assert.equal(isAllowedOrigin('https://asplos.dev', 'https://asplos.dev, https://example.com'), true);
});

test('isAllowedOrigin rejects an unlisted origin', () => {
  assert.equal(isAllowedOrigin('https://attacker.example', ['https://asplos.dev']), false);
});

test('isAllowedOrigin rejects a prefix-confusion origin', () => {
  assert.equal(isAllowedOrigin('https://asplos.dev.attacker.example', 'https://asplos.dev'), false);
});

test('isAllowedOrigin preserves host case and default-port normalization', () => {
  assert.equal(isAllowedOrigin('HTTPS://ASPLOS.DEV:443', 'https://asplos.dev'), true);
  assert.equal(isAllowedOrigin('http://ASPlOS.dev:80', ['http://asplos.dev']), true);
});

test('isAllowedOrigin rejects credentials', () => {
  assert.equal(isAllowedOrigin('https://user:pass@asplos.dev', 'https://asplos.dev'), false);
});

test('isAllowedOrigin rejects non-root paths', () => {
  assert.equal(isAllowedOrigin('https://asplos.dev/session', 'https://asplos.dev'), false);
  assert.equal(isAllowedOrigin('https://asplos.dev', 'https://asplos.dev/session'), false);
});

test('isAllowedOrigin rejects queries and fragments', () => {
  assert.equal(isAllowedOrigin('https://asplos.dev?admin=true', 'https://asplos.dev'), false);
  assert.equal(isAllowedOrigin('https://asplos.dev#trusted', 'https://asplos.dev'), false);
});

test('isAllowedOrigin rejects opaque and blob origins', () => {
  assert.equal(isAllowedOrigin('data:text/plain,https://asplos.dev', 'https://asplos.dev'), false);
  assert.equal(isAllowedOrigin('blob:https://asplos.dev/id', 'https://asplos.dev'), false);
});

test('parseClientMessage parses an auth message', () => {
  assert.deepEqual(parseClientMessage('{"type":"auth","token":"secret"}'), {
    type: 'auth',
    token: 'secret',
  });
});

test('parseClientMessage parses an input message', () => {
  assert.deepEqual(parseClientMessage(Buffer.from('{"type":"input","data":"ls\\n"}')), {
    type: 'input',
    data: 'ls\n',
  });
});

test('parseClientMessage parses and clamps a resize message', () => {
  assert.deepEqual(parseClientMessage('{"type":"resize","cols":500,"rows":2}'), {
    type: 'resize',
    cols: 240,
    rows: 5,
  });
});

test('parseClientMessage rejects malformed JSON', () => {
  assert.throws(() => parseClientMessage('{not-json'), ProtocolError);
});

test('parseClientMessage rejects binary input', () => {
  assert.throws(() => parseClientMessage(Buffer.from('{}'), true), ProtocolError);
});

test('parseClientMessage rejects unknown message types', () => {
  assert.throws(() => parseClientMessage('{"type":"launch"}'), ProtocolError);
});

test('parseClientMessage rejects payloads over 64 KiB', () => {
  assert.throws(() => parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1)), ProtocolError);
});

test('parseClientMessage accepts valid multibyte JSON at exactly 64 KiB from a Buffer', () => {
  const payload = inputPayloadOfByteLength(MAX_MESSAGE_BYTES);
  const message = parseClientMessage(Buffer.from(payload));

  assert.equal(message.type, 'input');
  assert.equal(message.data.startsWith('界'), true);
});

test('parseClientMessage rejects valid multibyte JSON above 64 KiB from a Buffer', () => {
  const payload = inputPayloadOfByteLength(MAX_MESSAGE_BYTES + 1);
  assert.throws(() => parseClientMessage(Buffer.from(payload)), ProtocolError);
});

test('parseClientMessage rejects invalid auth fields', () => {
  assert.throws(() => parseClientMessage('{"type":"auth","token":42}'), ProtocolError);
});

test('parseClientMessage rejects invalid input fields', () => {
  assert.throws(() => parseClientMessage('{"type":"input","data":null}'), ProtocolError);
});

test('parseClientMessage rejects extra-large input data', () => {
  const data = 'x'.repeat(MAX_MESSAGE_BYTES);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'input', data })), ProtocolError);
});

test('parseClientMessage rejects invalid resize field types', () => {
  assert.throws(() => parseClientMessage('{"type":"resize","cols":"80","rows":24}'), ProtocolError);
});

test('parseClientMessage rejects non-finite resize values', () => {
  assert.throws(() => parseClientMessage('{"type":"resize","cols":1e309,"rows":24}'), ProtocolError);
});

test('parseClientMessage rejects fractional resize values', () => {
  assert.throws(
    () => parseClientMessage('{"type":"resize","cols":80.5,"rows":24}'),
    ProtocolError,
  );
  assert.throws(
    () => parseClientMessage('{"type":"resize","cols":80,"rows":24.5}'),
    ProtocolError,
  );
});

test('clampTerminalSize preserves values at every limit', () => {
  assert.deepEqual(clampTerminalSize(20, 5), { cols: 20, rows: 5 });
  assert.deepEqual(clampTerminalSize(240, 100), { cols: 240, rows: 100 });
});

test('clampTerminalSize clamps values beyond every limit', () => {
  assert.deepEqual(clampTerminalSize(19, 4), { cols: 20, rows: 5 });
  assert.deepEqual(clampTerminalSize(241, 101), { cols: 240, rows: 100 });
});

test('serverMessage serializes a typed server payload', () => {
  assert.equal(serverMessage('ready', { sessionId: 'abc' }), '{"type":"ready","sessionId":"abc"}');
});

test('serverMessage rejects invalid message types', () => {
  assert.throws(() => serverMessage('', {}), ProtocolError);
  assert.throws(() => serverMessage(42, {}), ProtocolError);
});

test('serverMessage accepts only plain field records', () => {
  assert.throws(() => serverMessage('ready', null), ProtocolError);
  assert.throws(() => serverMessage('ready', []), ProtocolError);
  assert.throws(() => serverMessage('ready', new Date()), ProtocolError);
});

test('serverMessage rejects fields that attempt to override the message type', () => {
  assert.throws(() => serverMessage('ready', { type: 'error' }), ProtocolError);
});

test('serverMessage rejects fields that customize JSON serialization', () => {
  assert.throws(
    () => serverMessage('ready', { toJSON: () => ({ type: 'error' }) }),
    ProtocolError,
  );
});

test('serverMessage rejects prototype-related reserved fields', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const fields = JSON.parse(`{"${key}":"unsafe"}`);
    assert.throws(() => serverMessage('ready', fields), ProtocolError);
  }
});
