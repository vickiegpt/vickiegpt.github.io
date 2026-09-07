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

test('safeTokenEqual accepts equal tokens', () => {
  assert.equal(safeTokenEqual('secret-token', 'secret-token'), true);
});

test('safeTokenEqual rejects unequal tokens of equal length', () => {
  assert.equal(safeTokenEqual('secret-token', 'public-token'), false);
});

test('safeTokenEqual rejects tokens of unequal length', () => {
  assert.equal(safeTokenEqual('short', 'a-longer-token'), false);
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
