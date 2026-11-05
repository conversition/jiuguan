export interface NpcRelationshipProjectionLike {
  readonly relationships: readonly Readonly<{
    readonly fromCharacterId: string;
    readonly toCharacterId: string;
    readonly type: string;
  }>[];
}

export interface NpcOccupiedRelationshipTarget {
  readonly characterId: string;
  readonly toCharacterId: string;
  readonly relationType: string;
}

/**
 * Build the authoritative current-relationship target set used by guarded auto apply.
 *
 * CharacterStore keeps code-derived reverse edges in the original projection, so the
 * relationship's own fromCharacterId is authoritative; the projection owner is not.
 */
export function npcOccupiedRelationshipTargets(
  projections: readonly NpcRelationshipProjectionLike[],
  allowedCharacterIds: readonly string[],
): readonly Readonly<NpcOccupiedRelationshipTarget>[] {
  const allowed = new Set(allowedCharacterIds);
  const keyed = new Map<string, NpcOccupiedRelationshipTarget>();
  for (const projection of projections) {
    for (const relationship of projection.relationships) {
      if (!allowed.has(relationship.fromCharacterId) || !allowed.has(relationship.toCharacterId)) continue;
      const target = {
        characterId: relationship.fromCharacterId,
        toCharacterId: relationship.toCharacterId,
        relationType: relationship.type,
      };
      keyed.set(`${target.characterId}\0${target.toCharacterId}\0${target.relationType}`, target);
    }
  }
  return Object.freeze([...keyed.values()].sort((left, right) => (
    `${left.characterId}\0${left.toCharacterId}\0${left.relationType}`
      .localeCompare(`${right.characterId}\0${right.toCharacterId}\0${right.relationType}`)
  )).map((target) => Object.freeze(target)));
}
