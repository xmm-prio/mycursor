/**
 * The context Cursor attaches to an agent turn.
 *
 * `RequestContext` carries the things that make the agent behave the way the
 * user configured it: their rules, the skills they installed, and the custom
 * subagents they defined. None of it reaches the model unless this toolkit
 * puts it there.
 *
 * Dropping any of it is a silent failure of exactly the kind this project
 * keeps running into. A turn without the user's rules still answers, it just
 * ignores every convention they wrote down — which reads as "the model got
 * worse" rather than "the integration dropped something".
 */

import type { Logger } from '@mycursor/core/logging';
import type { MessageValue } from '@mycursor/protocol/schema';

export interface CursorRule {
  path: string;
  content: string;
  /** Rules the user marked as always-apply. */
  required: boolean;
}

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
}

export interface CustomSubagent {
  name: string;
  description: string;
  /** Model the user chose for this subagent, when they chose one. */
  model: string;
  /** Extra system prompt this subagent runs with. */
  prompt: string;
  /** Tool names this subagent is limited to; empty means no restriction. */
  tools: string[];
  /** When set, the subagent must use the conversation's model. */
  forceDefaultModel: boolean;
}

export interface TurnContext {
  rules: CursorRule[];
  skills: AgentSkill[];
  subagents: CustomSubagent[];
}

const asList = (value: unknown): MessageValue[] =>
  Array.isArray(value) ? (value as MessageValue[]) : [];

const text = (value: unknown): string => String(value ?? '').trim();

/**
 * Finds the request context.
 *
 * A client may attach it directly to the user message action or hang it off
 * the request-context parts as dynamic context; both are read so neither
 * client shape loses its configuration.
 */
function locateContext(runRequest: MessageValue): MessageValue | undefined {
  const action = runRequest['action'] as MessageValue | undefined;
  const userAction = action?.['userMessageAction'] as MessageValue | undefined;
  const direct = userAction?.['requestContext'] as MessageValue | undefined;
  if (direct) return direct;

  const parts = action?.['requestContextParts'] as MessageValue | undefined;
  return parts?.['dynamicContext'] as MessageValue | undefined;
}

export function readTurnContext(runRequest: MessageValue, logger: Logger): TurnContext {
  // Skill options may ride on the run request even when no context is
  // attached, so an absent context is an empty one rather than an early exit.
  const context = locateContext(runRequest) ?? {};

  const rules: CursorRule[] = [];
  // `nonFileRules` holds the rules that are not tied to a file glob; both
  // kinds apply to a turn.
  for (const raw of [...asList(context['rules']), ...asList(context['nonFileRules'])]) {
    // A rule that failed to parse would be forwarded as broken text.
    if (text(raw['parseError'])) {
      logger.debug('skipping a rule that failed to parse', { path: text(raw['fullPath']) });
      continue;
    }
    const content = text(raw['content']);
    if (!content) continue;
    rules.push({
      path: text(raw['fullPath']),
      content,
      required: raw['isRequired'] === true,
    });
  }

  const skills: AgentSkill[] = [];
  const seenSkills = new Set<string>();
  // Descriptors name and describe a skill; `agentSkills` carries the body.
  // Clients send the options either on the run request or inside the context,
  // so both are read and merged by name.
  const descriptors = [
    ...asList((runRequest['skillOptions'] as MessageValue | undefined)?.['skillDescriptors']),
    ...asList((context['skillOptions'] as MessageValue | undefined)?.['skillDescriptors']),
  ];
  for (const raw of descriptors) {
    if (raw['enabled'] === false || text(raw['parseError'])) continue;
    const name = text(raw['name']);
    if (!name || seenSkills.has(name)) continue;
    seenSkills.add(name);
    skills.push({
      name,
      description: text(raw['description']),
      path: text(raw['folderPath']) || text(raw['readmeFilePath']),
    });
  }
  for (const raw of asList(context['agentSkills'])) {
    if (text(raw['parseError'])) continue;
    const path = text(raw['fullPath']);
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
    if (!name || seenSkills.has(name)) continue;
    seenSkills.add(name);
    skills.push({ name, description: text(raw['description']), path });
  }

  const subagents: CustomSubagent[] = [];
  for (const raw of asList(context['customSubagents'])) {
    const name = text(raw['name']);
    if (!name) continue;
    subagents.push({
      name,
      description: text(raw['description']),
      model: text(raw['model']),
      prompt: text(raw['prompt']),
      tools: toStringList(raw['tools']),
      forceDefaultModel: raw['forceDefaultModel'] === true,
    });
  }

  return { rules, skills, subagents };
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Assembles the system prompt for a turn.
 *
 * Order is deliberate: Cursor's own prompt first so it frames everything,
 * then the subagent's brief, then the user's rules, then the skill listing.
 * Rules come before skills because a rule may say when to reach for one.
 */
export function buildSystemPrompt(input: {
  customSystemPrompt: string;
  subagent: CustomSubagent | null;
  context: TurnContext;
}): string {
  const sections: string[] = [];

  if (input.customSystemPrompt) sections.push(input.customSystemPrompt);
  if (input.subagent?.prompt) sections.push(input.subagent.prompt);

  if (input.context.rules.length > 0) {
    const rendered = input.context.rules.map((rule) => {
      const heading = rule.path ? `<!-- ${rule.path}${rule.required ? ' (always applies)' : ''} -->` : '';
      return [heading, rule.content].filter(Boolean).join('\n');
    });
    sections.push(`# User rules\n\n${rendered.join('\n\n')}`);
  }

  if (input.context.skills.length > 0) {
    // The body of a skill is read on demand through the file tools, so only
    // the listing goes in the prompt; inlining every skill would swamp it.
    const rendered = input.context.skills.map((skill) => {
      const suffix = skill.path ? ` — ${skill.path}` : '';
      return `- **${skill.name}**: ${skill.description || '(no description)'}${suffix}`;
    });
    sections.push(
      `# Available skills\n\nRead the skill file before following it.\n\n${rendered.join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

export interface SubagentResolution {
  /** The custom subagent this run belongs to, when it is one. */
  subagent: CustomSubagent | null;
  /** Model id to use, or null to fall back to the conversation's model. */
  modelId: string | null;
  reason: string;
}

/**
 * Works out which model a subagent run should use.
 *
 * A subagent run arrives as its own request carrying `subagentTypeName`, and
 * the user may have chosen a different, usually cheaper, model for it.
 * Ignoring that choice sends every subagent to the main model, which is both
 * slower and more expensive than what the user asked for.
 *
 * Four sources can name the model, in descending authority:
 *
 *  1. `forceDefaultModel` on the subagent definition, a hard constraint from
 *     whoever wrote the subagent.
 *  2. `subagentModelOverrides`, the user's explicit choice keyed by subagent
 *     name — the only source that says which subagent it is talking about.
 *  3. The `model` in the subagent's own definition.
 *  4. `selectedSubagentModels`, which is positional and therefore a last
 *     resort: it is only trustworthy when it holds a single entry.
 */
export function resolveSubagent(
  runRequest: MessageValue,
  context: TurnContext,
): SubagentResolution {
  const typeName = text(runRequest['subagentTypeName']);
  if (!typeName) return { subagent: null, modelId: null, reason: 'not a subagent run' };

  const subagent = context.subagents.find((entry) => entry.name === typeName) ?? null;

  if (subagent?.forceDefaultModel) {
    return { subagent, modelId: null, reason: 'subagent is pinned to the conversation model' };
  }

  const override = asList(runRequest['subagentModelOverrides']).find(
    (entry) => text(entry['subagentType']) === typeName,
  );
  if (override) {
    // `inherit` and `disabled` both mean "no model of its own here"; a
    // disabled subagent should not have been started, so the conversation
    // model is the safe reading rather than refusing to answer.
    const overrideId = text((override['model'] as MessageValue | undefined)?.['modelId']);
    if (overrideId) {
      return { subagent, modelId: overrideId, reason: 'model from the subagent override' };
    }
    if (override['inherit'] === true || override['disabled'] === true) {
      return { subagent, modelId: null, reason: 'subagent override inherits the conversation model' };
    }
  }

  if (subagent?.model) {
    return { subagent, modelId: subagent.model, reason: 'model from the subagent definition' };
  }

  const selections = asList(runRequest['selectedSubagentModels']);
  const selectedId = selections.length === 1 ? text(selections[0]?.['modelId']) : '';
  if (selectedId) {
    return { subagent, modelId: selectedId, reason: 'model from the subagent selection' };
  }

  return { subagent, modelId: null, reason: 'no subagent model configured' };
}
