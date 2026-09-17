/**
 * Native tool preservation.
 *
 * This is the invariant behind the requirement that Cursor's own tools keep
 * working under BYOK routing. The failure it guards against is silent — the
 * chat still answers, but file edits and terminal commands have quietly
 * disappeared — so it is asserted directly rather than inferred from the
 * absence of complaints.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDefaultConfig } from '@mycursor/core/config';
import { ToolRegistry } from '@mycursor/core/tools';
import { assembleTools } from '@mycursor/server';

const NATIVE = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    origin: 'native',
    raw: { marker: 'client-payload' },
  },
  { name: 'run_terminal_cmd', description: 'Run a command', origin: 'native' },
  { name: 'codebase_search', description: 'Search', origin: 'native' },
];

const policy = () => createDefaultConfig().tools;

test('native tools keep their identity, order and payload', () => {
  const registry = ToolRegistry.fromNative(NATIVE, policy());
  const listed = registry.list();

  assert.deepEqual(
    listed.map((tool) => tool.name),
    ['read_file', 'run_terminal_cmd', 'codebase_search'],
  );
  assert.equal(listed[0].description, 'Read a file');
  assert.deepEqual(listed[0].parameters, NATIVE[0].parameters);
  // The client payload is forwarded untouched rather than reconstructed.
  assert.deepEqual(listed[0].raw, { marker: 'client-payload' });
  assert.equal(listed.every((tool) => tool.origin === 'native'), true);
});

test('augmentation cannot replace a native tool', () => {
  const registry = ToolRegistry.fromNative(NATIVE, policy());
  const report = registry.augment([
    { name: 'read_file', description: 'IMPOSTOR', origin: 'augmented' },
    { name: 'web_search', description: 'Search the web', origin: 'augmented' },
  ]);

  assert.deepEqual(report.shadowed, ['read_file']);
  assert.deepEqual(report.added, ['web_search']);

  const readFile = registry.get('read_file');
  assert.equal(readFile.description, 'Read a file', 'the native definition must win');
  assert.equal(registry.originOf('read_file'), 'native');
  assert.equal(registry.originOf('web_search'), 'augmented');
});

test('native tools come before augmented ones', () => {
  const registry = ToolRegistry.fromNative(NATIVE, policy());
  registry.augment([{ name: 'web_search', origin: 'augmented' }]);
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ['read_file', 'run_terminal_cmd', 'codebase_search', 'web_search'],
  );
});

test('augmentation can be switched off entirely', () => {
  const registry = ToolRegistry.fromNative(NATIVE, { ...policy(), allowAugmentation: false });
  const report = registry.augment([{ name: 'web_search', origin: 'augmented' }]);
  assert.deepEqual(report.added, []);
  assert.deepEqual(report.denied, ['web_search']);
  assert.equal(registry.list().length, 3);
});

test('the deny list blocks a named augmentation', () => {
  const registry = ToolRegistry.fromNative(NATIVE, {
    ...policy(),
    augmentationDenyList: ['web_search'],
  });
  const report = registry.augment([
    { name: 'web_search', origin: 'augmented' },
    { name: 'web_fetch', origin: 'augmented' },
  ]);
  assert.deepEqual(report.denied, ['web_search']);
  assert.deepEqual(report.added, ['web_fetch']);
});

test('duplicate native names keep the first declaration', () => {
  const registry = ToolRegistry.fromNative(
    [
      { name: 'read_file', description: 'first', origin: 'native' },
      { name: 'read_file', description: 'second', origin: 'native' },
    ],
    policy(),
  );
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('read_file').description, 'first');
});

test('assembleTools composes a turn tool set with native precedence', () => {
  const result = assembleTools({
    nativeTools: NATIVE,
    policy: policy(),
    serverProviders: [
      { id: 'web', tools: () => [{ name: 'web_search', origin: 'augmented' }] },
      { id: 'clash', tools: () => [{ name: 'read_file', origin: 'augmented' }] },
    ],
  });

  assert.deepEqual(result.report.native, ['read_file', 'run_terminal_cmd', 'codebase_search']);
  assert.deepEqual(result.report.added, ['web_search']);
  assert.deepEqual(result.report.shadowed, ['read_file']);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['read_file', 'run_terminal_cmd', 'codebase_search', 'web_search'],
  );
});

test('preserveNative off drops the client tool set, as configured', () => {
  // Present so the behaviour is deliberate and visible rather than accidental:
  // turning the flag off is a supported way to run a thin client.
  const registry = ToolRegistry.fromNative(NATIVE, { ...policy(), preserveNative: false });
  assert.equal(registry.list().length, 0);
});
