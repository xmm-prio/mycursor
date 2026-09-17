/**
 * `aiserver.v1.AiService/KnowledgeBase{List,Add,Update,Remove}`
 *
 * These four back Cursor's "remember this" feature. Upstream they write to
 * the user's account, which a BYOK session does not have — so forwarding them
 * fails in the quietest possible way: the add reports success, the list comes
 * back empty, and the user concludes the feature is broken rather than
 * unavailable.
 *
 * Answering locally keeps the feature working against a file the user owns.
 * As everywhere else, a missing descriptor means forwarding rather than
 * guessing at field numbers.
 */

import type { Logger } from '@mycursor/core/logging';
import {
  decodeMessage,
  encodeMessage,
  type DescriptorRegistry,
  type MessageValue,
} from '@mycursor/protocol/schema';

import type { KnowledgeStore } from '../../knowledge/store.js';

const TYPES = {
  list: ['aiserver.v1.KnowledgeBaseListRequest', 'aiserver.v1.KnowledgeBaseListResponse'],
  add: ['aiserver.v1.KnowledgeBaseAddRequest', 'aiserver.v1.KnowledgeBaseAddResponse'],
  update: ['aiserver.v1.KnowledgeBaseUpdateRequest', 'aiserver.v1.KnowledgeBaseUpdateResponse'],
  remove: ['aiserver.v1.KnowledgeBaseRemoveRequest', 'aiserver.v1.KnowledgeBaseRemoveResponse'],
} as const;

export type KnowledgeOperation = keyof typeof TYPES;

export interface KnowledgeInput {
  operation: KnowledgeOperation;
  descriptors: DescriptorRegistry;
  store: KnowledgeStore;
  requestBody: Uint8Array;
  logger: Logger;
}

export interface KnowledgeOutcome {
  /** Encoded response, or null when the request should be forwarded. */
  bytes: Uint8Array | null;
  reason: string;
}

export function handleKnowledgeBase(input: KnowledgeInput): KnowledgeOutcome {
  const { operation, descriptors, store, requestBody, logger } = input;
  const [requestType, responseType] = TYPES[operation];

  if (!descriptors.has(requestType) || !descriptors.has(responseType)) {
    return { bytes: null, reason: `no descriptor for ${requestType}; run "mycursor schema"` };
  }

  let request: MessageValue;
  try {
    request = decodeMessage(descriptors, requestType, requestBody);
  } catch (error) {
    return { bytes: null, reason: `request could not be decoded: ${(error as Error).message}` };
  }

  const response = apply(operation, request, store, logger);

  try {
    return { bytes: encodeMessage(descriptors, responseType, response), reason: operation };
  } catch (error) {
    return { bytes: null, reason: `response could not be encoded: ${(error as Error).message}` };
  }
}

function apply(
  operation: KnowledgeOperation,
  request: MessageValue,
  store: KnowledgeStore,
  logger: Logger,
): MessageValue {
  const text = (key: string): string => String(request[key] ?? '');

  switch (operation) {
    case 'list': {
      const limit = Number(request['limit'] ?? 0);
      const entries = store.list(text('gitOrigin'), Number.isFinite(limit) ? limit : 0);
      logger.debug('knowledge base listed', { entries: entries.length });
      return {
        success: true,
        allResults: entries.map((entry) => ({
          id: entry.id,
          knowledge: entry.knowledge,
          title: entry.title,
          createdAt: entry.createdAt,
          isGenerated: entry.isGenerated,
        })),
      };
    }

    case 'add': {
      // `composerId` marks an entry the agent wrote during a conversation
      // rather than one the user typed, which the picker renders differently.
      const id = store.add({
        knowledge: text('knowledge'),
        title: text('title'),
        gitOrigin: text('gitOrigin'),
        isGenerated: text('composerId').length > 0,
      });
      logger.info('knowledge base entry added', { id });
      return { success: true, id };
    }

    case 'update': {
      const id = text('id');
      const success = store.update(id, {
        knowledge: 'knowledge' in request ? text('knowledge') : undefined,
        title: 'title' in request ? text('title') : undefined,
      });
      if (!success) logger.warn('knowledge base update named an unknown entry', { id });
      return { success };
    }

    case 'remove': {
      const id = text('id');
      const success = store.remove(id);
      if (!success) logger.warn('knowledge base remove named an unknown entry', { id });
      return { success };
    }
  }
}
