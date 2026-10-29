// INPUT: Official scoped SystemPrompt section API and a trusted Harness source.
// OUTPUT: One additive routing section and its exact repeatable effect disposer.
// POS: DSH prompt contribution seam; does not change persona, context or permissions.
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { Harness } from '../../protocol/message.ts';
import { routingGuidance } from '../../routing/policy.ts';

type RoutingPrompt = Pick<SystemPrompt, 'section' | 'getSectionOrder'>;

export function installRoutingGuidance(
  prompt: RoutingPrompt | null | undefined, source: Harness,
): () => void {
  try {
    if (!prompt) throw new Error('ROUTING_GUIDANCE_UNAVAILABLE');
    return prompt.section({
      name: 'agent-message-switchboard:routing',
      order: prompt.getSectionOrder('TOOL_SESSION_QUERY'),
      text: routingGuidance(source),
      interpolate: false,
    });
  } catch {
    throw new Error('ROUTING_GUIDANCE_UNAVAILABLE');
  }
}
