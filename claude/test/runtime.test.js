import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchVerifiedWebc,
  launchClaude,
  validateRuntimeManifest,
} from '../src/runtime.js';

const encoder = new TextEncoder();

async function hash(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fixture() {
  const bytes = encoder.encode('webc-fixture');
  return {
    bytes,
    manifest: {
      schema: 1,
      url: '/about/node-claude.webc',
      size: bytes.byteLength,
      sha256: await hash(bytes),
      nodeSha256: 'f'.repeat(64),
      sdkVersion: '0.11.0',
      nodeVersion: '25.0.0-pre',
      claudeVersion: '2.0.0',
      command: 'node',
      args: ['/app/claude-debug.mjs'],
    },
  };
}

describe('browser Wasmer runtime', () => {
  it('accepts only the pinned runtime manifest contract', async () => {
    const { manifest } = await fixture();
    assert.deepEqual(validateRuntimeManifest(manifest), manifest);
    assert.throws(
      () => validateRuntimeManifest({ ...manifest, command: 'sh' }),
      /runtime manifest/i,
    );
    assert.throws(
      () => validateRuntimeManifest({ ...manifest, url: 'https://attacker.example/x' }),
      /runtime manifest/i,
    );
  });

  it('streams bytes with progress and verifies exact size and SHA-256', async () => {
    const { bytes, manifest } = await fixture();
    const progress = [];
    const result = await fetchVerifiedWebc(manifest, {
      baseUrl: 'https://asplos.dev/claude/',
      fetchImpl: async (url) => {
        assert.equal(url, 'https://asplos.dev/about/node-claude.webc');
        return new Response(bytes, {
          headers: { 'Content-Length': String(bytes.byteLength) },
        });
      },
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });

    assert.deepEqual(result, bytes);
    assert.deepEqual(progress.at(-1), [bytes.byteLength, bytes.byteLength]);
    await assert.rejects(
      fetchVerifiedWebc({ ...manifest, sha256: '0'.repeat(64) }, {
        baseUrl: 'https://asplos.dev/claude/',
        fetchImpl: async () => new Response(bytes),
      }),
      /integrity/i,
    );
  });

  it('loads WEBC into a cached Wasmer sandbox with fixed relay environment', async () => {
    const { bytes, manifest } = await fixture();
    const calls = [];
    const process = { stdin: {}, stdout: {}, stderr: {}, resizeTerminal() {} };
    const sandbox = {
      command(command, args, options) {
        calls.push(['command', command, args, options]);
        return {
          async spawn(options) {
            calls.push(['spawn', options]);
            return process;
          },
        };
      },
    };
    class FakeWasmer {
      constructor(options) {
        calls.push(['constructor', options]);
        this.packages = {
          load: async (loadedBytes) => {
            calls.push(['load', loadedBytes]);
            return { id: 'package' };
          },
        };
        this.sandboxes = {
          create: async (options) => {
            calls.push(['sandbox', options]);
            return sandbox;
          },
        };
      }
      async ready() { calls.push(['ready']); }
    }
    const fetchImpl = async (url) => {
      if (url.endsWith('runtime-manifest.json')) return Response.json(manifest);
      return new Response(bytes, {
        headers: { 'Content-Length': String(bytes.byteLength) },
      });
    };

    const launched = await launchClaude({
      capability: 'signed-five-minute-capability',
      wispUrl: 'wss://asplos.dev/wisp/',
      manifestUrl: 'https://asplos.dev/about/runtime-manifest.json',
      columns: 100,
      rows: 30,
      isolated: true,
      fetchImpl,
      sdkLoader: async () => ({ Wasmer: FakeWasmer }),
    });

    assert.equal(launched.process, process);
    assert.equal(launched.sandbox, sandbox);
    assert.deepEqual(calls[0], [
      'constructor',
      { parallelism: 2, cache: { namespace: `node-claude-${manifest.sha256.slice(0, 16)}` } },
    ]);
    const sandboxOptions = calls.find(([name]) => name === 'sandbox')[1];
    assert.deepEqual(sandboxOptions.network, {
      mode: 'wisp',
      url: 'wss://asplos.dev/wisp/',
    });
    assert.equal(sandboxOptions.env.HOME, '/workspace');
    assert.equal(
      sandboxOptions.env.ANTHROPIC_BASE_URL,
      'https://asplos.dev/api/anthropic',
    );
    assert.equal(
      sandboxOptions.env.ANTHROPIC_AUTH_TOKEN,
      'signed-five-minute-capability',
    );
    assert.deepEqual(calls.find(([name]) => name === 'command'), [
      'command',
      'node',
      ['/app/claude-debug.mjs'],
      { cwd: '/workspace' },
    ]);
    assert.deepEqual(calls.find(([name]) => name === 'spawn'), [
      'spawn',
      { terminal: { columns: 100, rows: 30 } },
    ]);
  });

  it('requires cross-origin isolation and the fixed same-origin WISP endpoint', async () => {
    const base = {
      capability: 'signed-five-minute-capability',
      manifestUrl: 'https://asplos.dev/about/runtime-manifest.json',
      fetchImpl: async () => { throw new Error('must not fetch'); },
    };
    await assert.rejects(
      launchClaude({ ...base, isolated: false, wispUrl: 'wss://asplos.dev/wisp/' }),
      /cross-origin isolated/i,
    );
    await assert.rejects(
      launchClaude({
        ...base,
        isolated: true,
        wispUrl: 'wss://attacker.example/wisp/',
      }),
      /WISP endpoint/i,
    );
  });
});
