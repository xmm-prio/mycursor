/**
 * `mycursor uninstall`
 *
 * Restores every patched file. A backup is preferred because it restores
 * bytes exactly; where one is missing the payload block is cut out of the file
 * instead, so a Cursor upgrade that replaced a backup still leaves a way back.
 */

import { resolveConfigPaths } from '@mycursor/core/config';
import { formatLocateResult, locateInstalls, removeManifest, uninstallInstall } from '@mycursor/patcher';

import { extension } from './extension.js';
import { detail, fail, heading, info, ok, warn } from '../ui.js';

export async function uninstall(): Promise<number> {
  heading('mycursor uninstall');

  const located = locateInstalls();
  if (located.installs.length === 0) {
    fail('no Cursor installation found');
    console.log(`\n${formatLocateResult(located)}`);
    return 1;
  }

  let restored = 0;
  let stripped = 0;
  let failures = 0;

  for (const layout of located.installs) {
    heading(`${layout.kind} install · Cursor ${layout.version}`);
    info(layout.root);

    const result = uninstallInstall(layout);
    for (const file of result.restored) detail(`restored ${file}`);
    for (const file of result.stripped) detail(`stripped payload from ${file}`);
    for (const problem of result.failed) fail(`${problem.file}: ${problem.error}`);

    restored += result.restored.length;
    stripped += result.stripped.length;
    failures += result.failed.length;
  }

  removeManifest(resolveConfigPaths().root);

  // Removing the panel too, so "uninstall" leaves nothing of the toolkit
  // behind in Cursor itself. A failure here is reported but does not fail the
  // command: the patched files are already restored, which is the part that
  // matters.
  const extensionCode = await extension({ packOnly: false, remove: true });
  if (extensionCode !== 0) detail('the panel extension may still be installed');

  heading('summary');
  if (restored === 0 && stripped === 0) {
    warn('nothing to undo — no payload was found');
  } else {
    ok(`restored ${restored} file(s), stripped ${stripped} file(s)`);
    // Configuration is left in place on purpose: an uninstall is usually a step
    // in troubleshooting, and deleting a user's API keys would be hostile.
    detail(`configuration under ${resolveConfigPaths().root} was left in place`);
    detail('restart Cursor for the change to take effect');
  }

  return failures > 0 ? 1 : 0;
}
