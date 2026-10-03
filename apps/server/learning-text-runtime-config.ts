export const LEARNING_TEXT_PROVIDER_ACK = 'p14-learning-text-provider-v1' as const;

export interface LearningTextRuntimeConfig {
  readonly mode: 'off' | 'preference' | 'style' | 'all';
  readonly preferenceEnabled: boolean;
  readonly styleEnabled: boolean;
}

/**
 * Separate privacy ceiling for optional learning calls that transmit conversation prose.
 * Agent quality-beta ACK is not sufficient: the operator must acknowledge this payload class.
 */
export function parseLearningTextRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LearningTextRuntimeConfig {
  const mode = (env.JG_AGENT_LEARNING_TEXT ?? 'off').trim().toLowerCase();
  if (mode === 'off') return Object.freeze({
    mode: 'off', preferenceEnabled: false, styleEnabled: false,
  });
  if (mode !== 'preference' && mode !== 'style' && mode !== 'all') {
    throw new Error('JG_AGENT_LEARNING_TEXT 只允许 off、preference、style 或 all');
  }
  if (env.JG_AGENT_LEARNING_TEXT_ACK !== LEARNING_TEXT_PROVIDER_ACK) {
    throw new Error(
      `JG_AGENT_LEARNING_TEXT=${mode} 需要 JG_AGENT_LEARNING_TEXT_ACK=${LEARNING_TEXT_PROVIDER_ACK}`,
    );
  }
  return Object.freeze({
    mode,
    preferenceEnabled: mode === 'preference' || mode === 'all',
    styleEnabled: mode === 'style' || mode === 'all',
  });
}
