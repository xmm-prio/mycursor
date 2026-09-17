/**
 * Where configuration and state live on disk.
 *
 * The directory is overridable through `MYCURSOR_HOME` so a sandbox run — or a
 * second Cursor profile — can be pointed somewhere harmless without touching
 * the real installation.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  DESCRIPTORS_FILE_NAME,
  KNOWLEDGE_FILE_NAME,
  MODELS_CATALOG_FILE_NAME,
  PROVIDERS_FILE_NAME,
  STATE_DB_FILE_NAME,
} from './defaults.js';

export const HOME_ENV_VAR = 'MYCURSOR_HOME';

export interface ConfigPaths {
  root: string;
  config: string;
  providers: string;
  modelsCatalog: string;
  /**
   * Protobuf descriptors recovered from the installed Cursor.
   *
   * Kept beside the configuration rather than in the repository: it is derived
   * from the user's own installation and has to be refreshed when Cursor is
   * upgraded.
   */
  descriptors: string;
  /** Knowledge base entries, which a BYOK session has no account to store. */
  knowledge: string;
  state: string;
  logs: string;
}

/** Resolves the configuration root, honouring the environment override. */
export function resolveConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOME_ENV_VAR];
  if (override && override.trim()) return override.trim();
  return join(homedir(), CONFIG_DIR_NAME);
}

export function resolveConfigPaths(env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const root = resolveConfigRoot(env);
  return {
    root,
    config: join(root, CONFIG_FILE_NAME),
    providers: join(root, PROVIDERS_FILE_NAME),
    modelsCatalog: join(root, MODELS_CATALOG_FILE_NAME),
    descriptors: join(root, DESCRIPTORS_FILE_NAME),
    knowledge: join(root, KNOWLEDGE_FILE_NAME),
    state: join(root, STATE_DB_FILE_NAME),
    logs: join(root, 'logs'),
  };
}
