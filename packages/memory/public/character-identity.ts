/**
 * Public source-level NPC identity boundary for outer workspaces.
 *
 * Runtime apps must not depend on ignored `packages/memory/dist/**` artifacts,
 * and the architecture gate forbids reaching into another package's private
 * `src/**` tree. Keep this surface deliberately narrow: it exports only the
 * value-free identity predicates needed before any CharacterStore read/write.
 */
export {
  isEligibleNpcMentionCandidate,
  isPlausibleNpcIdentityName,
} from '../src/character.ts';
