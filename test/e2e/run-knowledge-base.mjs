/**
 * Knowledge base: the feature that fails most quietly when it is forwarded.
 *
 * Cursor's "remember this" writes to the user's account. A BYOK session has
 * no account, so a forwarded `KnowledgeBaseAdd` reports success and the
 * following `KnowledgeBaseList` comes back empty — nothing errors, the note
 * is simply gone. Serving the four methods from a local file is what keeps
 * the feature honest.
 *
 * Everything here runs against the real server with the real descriptors
 * extracted from the installed Cursor; only the official API is mocked.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

await import('../harness/lib/dns-override.cjs');

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig } from '@mycursor/core/config';
import { extractDescriptors, locateInstalls } from '@mycursor/patcher';
import { DescriptorRegistry, decodeMessage, encodeMessage } from '@mycursor/protocol/schema';
import { MyCursorServer } from '@mycursor/server';

const here = dirname(fileURLToPath(import.meta.url));
const workDir = join(here, '..', '..', '.verify-out', 'knowledge-base');
const home = join(workDir, 'home');

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  console.log('mycursor knowledge base verification');

  const env = { ...process.env };
  delete env.MYCURSOR_CURSOR_ROOT;
  const install = locateInstalls(env).installs.find((entry) => entry.kind === 'desktop');
  if (!install) {
    console.error('no desktop Cursor installation found; this verification reads its schema');
    process.exit(2);
  }
  const document = extractDescriptors(install).document;
  const registry = DescriptorRegistry.fromDocument(document);

  console.log('\n── The methods were recovered from the installed Cursor');
  for (const name of ['List', 'Add', 'Update', 'Remove']) {
    const method = registry.method('aiserver.v1.AiService', `KnowledgeBase${name}`);
    check(`KnowledgeBase${name} has a typed signature`, Boolean(method),
      method ? `${method.input} -> ${method.output}` : 'absent');
  }

  const descriptorsPath = join(home, 'cursor-descriptors.json');
  const knowledgePath = join(home, 'knowledge-base.json');
  writeFileSync(descriptorsPath, JSON.stringify(document));

  const config = createDefaultConfig();
  config.server = { host: '127.0.0.1', port: 39891, tlsPort: 39892 };
  config.uplink.mode = 'local';
  config.interception.hostPatterns = ['^api2\\.cursor\\.test$'];
  const configPath = join(home, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(home, 'providers.json'), `${JSON.stringify({ $schemaVersion: 2, providers: [] }, null, 2)}\n`);

  const server = new MyCursorServer({
    configPath,
    providersPath: join(home, 'providers.json'),
    descriptorsPath,
    knowledgePath,
    tlsDirectory: home,
    logLevel: 'warn',
  });
  const running = await server.listen();
  const base = `http://127.0.0.1:${running.plainPort}`;

  /** Calls one of the four methods and decodes the reply. */
  const call = async (name, request) => {
    const [, method] = [`KnowledgeBase${name}`, `KnowledgeBase${name}`];
    const response = await fetch(`${base}/aiserver.v1.AiService/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/proto', 'x-mycursor-upstream': 'api2.cursor.test' },
      body: encodeMessage(registry, `aiserver.v1.KnowledgeBase${name}Request`, request),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      message: decodeMessage(registry, `aiserver.v1.KnowledgeBase${name}Response`, body),
    };
  };

  try {
    console.log('\n── Add, then list');

    const added = await call('Add', {
      knowledge: 'This repo pins pnpm to 11.15.1.',
      title: 'Package manager',
      gitOrigin: 'git@example.com:acme/app.git',
    });
    check('the add was served locally', added.status === 200, String(added.status));
    check('the add reported success with an id',
      added.message.success === true && String(added.message.id ?? '').length > 0,
      String(added.message.id));

    // This is the assertion that a forwarded implementation fails: the add
    // looks fine either way, only the read-back tells the truth.
    const listed = await call('List', { gitOrigin: 'git@example.com:acme/app.git', limit: 10 });
    check('the entry came back from the list', (listed.message.allResults ?? []).length === 1,
      `${(listed.message.allResults ?? []).length} entries`);
    const entry = (listed.message.allResults ?? [])[0];
    check('the text and title survived the round trip',
      entry?.knowledge === 'This repo pins pnpm to 11.15.1.' && entry?.title === 'Package manager',
      JSON.stringify({ title: entry?.title }));
    check('an entry the user typed is not marked as generated', entry?.isGenerated === false,
      String(entry?.isGenerated));
    check('the entry carries a creation time', /^\d{4}-\d{2}-\d{2}T/.test(String(entry?.createdAt)),
      String(entry?.createdAt));

    console.log('\n── Scoping, updating and removing');

    await call('Add', { knowledge: 'Global note.', title: 'Everywhere', gitOrigin: '' });
    await call('Add', {
      knowledge: 'Other project note.',
      title: 'Elsewhere',
      gitOrigin: 'git@example.com:acme/other.git',
    });

    const scoped = await call('List', { gitOrigin: 'git@example.com:acme/app.git', limit: 10 });
    const titles = (scoped.message.allResults ?? []).map((item) => item.title).sort();
    check('another repository\'s notes are not listed', !titles.includes('Elsewhere'), titles.join(', '));
    check('notes with no repository apply everywhere', titles.includes('Everywhere'), titles.join(', '));

    const capped = await call('List', { gitOrigin: 'git@example.com:acme/app.git', limit: 1 });
    check('the limit is honoured', (capped.message.allResults ?? []).length === 1,
      `${(capped.message.allResults ?? []).length} entries`);

    const generated = await call('Add', {
      knowledge: 'Written by the agent.',
      title: 'From a conversation',
      gitOrigin: '',
      composerId: 'conv-1',
    });
    const withGenerated = await call('List', { gitOrigin: '', limit: 50 });
    const generatedEntry = (withGenerated.message.allResults ?? []).find(
      (item) => item.id === generated.message.id,
    );
    check('an entry added during a conversation is marked as generated',
      generatedEntry?.isGenerated === true, String(generatedEntry?.isGenerated));

    const updated = await call('Update', {
      id: added.message.id,
      knowledge: 'This repo pins pnpm to 11.15.1 and Node to 20+.',
      title: 'Package manager and Node',
    });
    check('the update reported success', updated.message.success === true);
    const afterUpdate = await call('List', { gitOrigin: 'git@example.com:acme/app.git', limit: 10 });
    const edited = (afterUpdate.message.allResults ?? []).find((item) => item.id === added.message.id);
    check('the edit was persisted', edited?.title === 'Package manager and Node', edited?.title);

    const missing = await call('Update', { id: 'no-such-id', knowledge: 'x', title: 'y' });
    check('updating an unknown id reports failure rather than creating one',
      missing.message.success !== true, String(missing.message.success));

    const removed = await call('Remove', { id: added.message.id });
    check('the remove reported success', removed.message.success === true);
    const afterRemove = await call('List', { gitOrigin: 'git@example.com:acme/app.git', limit: 10 });
    check('the removed entry is gone',
      !(afterRemove.message.allResults ?? []).some((item) => item.id === added.message.id));
    // The two global notes remain visible here; the other repository's note
    // is still stored but correctly out of scope.
    const remaining = (afterRemove.message.allResults ?? []).map((item) => item.title).sort();
    check('the remove took only the entry it named',
      remaining.join(', ') === 'Everywhere, From a conversation', remaining.join(', '));

    console.log('\n── The notes outlive the process');

    const onDisk = JSON.parse(readFileSync(knowledgePath, 'utf8'));
    check('the entries were written to a file the user owns',
      Array.isArray(onDisk.entries) && onDisk.entries.length === 3,
      `${onDisk.entries?.length} entries at ${knowledgePath.split(/[\\/]/).at(-1)}`);

    await running.close();

    const restarted = new MyCursorServer({
      configPath,
      providersPath: join(home, 'providers.json'),
      descriptorsPath,
      knowledgePath,
      tlsDirectory: home,
      logLevel: 'warn',
    });
    const secondRun = await restarted.listen();
    try {
      const response = await fetch(
        `http://127.0.0.1:${secondRun.plainPort}/aiserver.v1.AiService/KnowledgeBaseList`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/proto', 'x-mycursor-upstream': 'api2.cursor.test' },
          body: encodeMessage(registry, 'aiserver.v1.KnowledgeBaseListRequest', { gitOrigin: '', limit: 50 }),
        },
      );
      const reloaded = decodeMessage(
        registry,
        'aiserver.v1.KnowledgeBaseListResponse',
        new Uint8Array(await response.arrayBuffer()),
      );
      check('a restarted server still serves the notes',
        (reloaded.allResults ?? []).length === 3,
        `${(reloaded.allResults ?? []).length} entries`);
    } finally {
      await secondRun.close();
    }

    console.log('\n── Without a schema the calls are forwarded, not guessed');

    const bareHome = join(workDir, 'bare');
    mkdirSync(bareHome, { recursive: true });
    const bareConfig = createDefaultConfig();
    bareConfig.server = { host: '127.0.0.1', port: 39893, tlsPort: 39894 };
    bareConfig.uplink.mode = 'local';
    bareConfig.interception.hostPatterns = ['^api2\\.cursor\\.test$'];
    const bareConfigPath = join(bareHome, 'config.json');
    writeFileSync(bareConfigPath, `${JSON.stringify(bareConfig, null, 2)}\n`);
    writeFileSync(join(bareHome, 'providers.json'), `${JSON.stringify({ $schemaVersion: 2, providers: [] }, null, 2)}\n`);

    const bare = new MyCursorServer({
      configPath: bareConfigPath,
      providersPath: join(bareHome, 'providers.json'),
      descriptorsPath: join(bareHome, 'absent-descriptors.json'),
      knowledgePath: join(bareHome, 'knowledge-base.json'),
      tlsDirectory: bareHome,
      logLevel: 'error',
    });
    const bareRunning = await bare.listen();
    try {
      const response = await fetch(
        `http://127.0.0.1:${bareRunning.plainPort}/aiserver.v1.AiService/KnowledgeBaseList`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/proto', 'x-mycursor-upstream': 'api2.cursor.test' },
          body: new Uint8Array([0]),
        },
      );
      // No upstream is listening, so the forward fails — which is the point:
      // the server tried to forward rather than answering from a guess.
      const counters = bareRunning.status().counters;
      check('a schema-less knowledge call was forwarded rather than answered',
        (counters['upstream'] ?? 0) >= 1 && response.status !== 200,
        `${Object.entries(counters).map(([key, value]) => `${key}=${value}`).join(' ')} · status ${response.status}`);
    } finally {
      await bareRunning.close();
    }
  } finally {
    rmSync(join(workDir, 'unused'), { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed checks:');
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail ?? ''}`);
    process.exitCode = 1;
  }
}

await main();
