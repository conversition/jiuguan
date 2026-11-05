/** Pure Critic input/source contracts; importing this facade grants no execution authority. */
export { CRITIC_INPUT_VERSION, createCriticInput, parseCriticInput, criticPayloadDigest, criticPayloadManifest,
  criticInputManifest, parseCriticInputManifest } from '../src/critic-input.ts';
export type { CriticInputV1, CriticInputManifestV1, CriticPayloadManifestV1, CriticJsonValue } from '../src/critic-input.ts';
