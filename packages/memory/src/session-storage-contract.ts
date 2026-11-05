/**
 * The only Session predecessor that schema v17 may own directly.
 *
 * Keep this literal instead of a moving current-1 window: a future schema bump
 * must make an explicit compatibility decision for every historic layout.
 */
export const SESSION_STORAGE_PREDECESSOR_VERSION = 16;

function freezeColumnContract(
  value: Record<string, readonly string[]>,
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([table, columns]) => [table, Object.freeze([...columns])]),
  ));
}

/**
 * Complete ordinary owner storage required from a genuine schema-v16 file.
 *
 * A v17 owner validates this before any CREATE IF NOT EXISTS statement so
 * missing truth cannot be silently replaced by an empty table. FTS5 virtual
 * tables and their shadow tables are deliberately excluded: they are derived
 * indexes rebuildable from the ordinary source tables below. SQLite/PG vector
 * build rows are retained here even though embeddings are also derivable,
 * because they are ordinary owner tables and v16 has no migration that can
 * prove an empty recreation was intentional.
 */
export const SESSION_V16_STORAGE_REQUIRED_COLUMNS = freezeColumnContract({
  memory_meta: ['id', 'arc_id', 'stage', 'plot_round', 'bars', 'config', 'longterm', 'summary_round'],
  chat_log: ['id', 'round', 'role', 'content', 'created_at'],
  memory_arc: [
    'id', 'code', 'chapter', 'title', 'summary', 'status', 'seq', 'access_count', 'last_access_ms',
  ],
  memory_summary: [
    'id', 'code', 'round', 'delta', 'scene', 'created_at', 'access_count', 'last_access_ms',
  ],
  memory_event: [
    'id', 'code', 'description', 'characters', 'refs', 'resolved', 'access_count', 'last_access_ms',
  ],
  memory_parallel: ['id', 'kind', 'countdown_min', 'actor', 'location', 'action', 'next_stage'],
  memory_state: [
    'id', 'entity_type', 'entity_id', 'name', 'state_json', 'updated_round',
    'access_count', 'last_access_ms',
  ],
  lorebook_entry: [
    'id', 'uid', 'book', 'key', 'comment', 'content', 'selective', 'depth', 'constant',
    'use_regex', 'triggers', 'probability', 'useProbability', 'active',
  ],
  idx_entity: ['entity', 'category', 'row_id', 'weight'],
  vec_memory: [
    'source', 'row_id', 'build_id', 'content_hash', 'model', 'preprocess',
    'indexed_at', 'active', 'dims', 'embedding',
  ],
  vec_index_build: [
    'build_id', 'source', 'model', 'preprocess', 'status', 'created_at', 'activated_at',
  ],
  audit_log: [
    'id', 'round', 'mode', 'validator_output', 'attempts', 'final_action', 'created_at',
  ],
  round_ledger: [
    'round', 'user_msg_id', 'assistant_msg_id', 'meta_snapshot',
    'state_snapshot', 'created', 'created_at',
  ],
  state_snapshot: [
    'id', 'scope', 'scope_key', 'branch_key', 'state_json', 'state_version', 'instance_id',
    'initialized', 'updated_round', 'updated_at', 'history_epoch', 'source', 'note',
  ],
  session_control: ['session_key', 'control_key', 'value', 'updated_at'],
  character_registry: [
    'id', 'session_key', 'character_id', 'name', 'kind', 'create_operation_id', 'created_at',
  ],
  character_alias: ['id', 'session_key', 'alias', 'character_id', 'explicit', 'created_at'],
  character_alias_operation: [
    'id', 'session_key', 'character_id', 'operation_id', 'alias', 'alias_digest',
    'mention_key', 'expected_entity_version', 'rollback_entity_version', 'created_alias',
    'source_refs', 'provenance_digest', 'intent_fingerprint', 'created_at', 'rolled_back_at',
  ],
  character_fact_log: [
    'id', 'session_key', 'character_id', 'field', 'scope_kind', 'fact_kind', 'status',
    'value_json', 'scene_id', 'effective_round', 'effective_message_id', 'source_refs',
    'history_epoch', 'entity_version', 'operation_id', 'candidate_fingerprint', 'created_at',
  ],
  character_mention_pool: [
    'id', 'session_key', 'mention_key', 'entity_type', 'display_name', 'name_candidates',
    'rounds_json', 'pending_json', 'first_round', 'last_round', 'first_message_id',
    'last_message_id', 'promoted_character_id', 'promoted_at', 'created_at', 'updated_at',
  ],
  turn_job_outcome: [
    'run_id', 'session_id', 'action', 'round', 'assistant_message_id', 'revision', 'committed_at',
  ],
  turn_observation: [
    'observation_id', 'run_id', 'session_id', 'round', 'assistant_message_id',
    'source_revision', 'query_plan_version', 'routing_digest', 'recall_hit_count',
    'recall_codes_json', 'worldbook_hit_count', 'resolved_entity_count',
    'ambiguous_entity_count', 'skill_ids_json', 'skill_body_hashes_json',
    'skill_tokens', 'assembled_prompt_tokens', 'harness_lane',
    'harness_evidence_count', 'model_attempts', 'payload_digest', 'created_at',
  ],
  learning_outbox: [
    'event_id', 'run_id', 'session_id', 'card_id', 'content_mode', 'event_kind',
    'round', 'user_message_id', 'assistant_message_id', 'source_revision',
    'subject_digest', 'features_json', 'payload_digest', 'created_at', 'delivered_at',
  ],
  story_index: ['round', 'content', 'created_at'],
  turn_ledger: [
    'id', 'session_id', 'round', 'attempt', 'retry_index', 'clicked_regenerate',
    'outcome', 'token_cost', 'context_fingerprint', 'reward', 'prev_prose_md5', 'created_at',
  ],
  summary_segment: ['id', 'seg_type', 'text', 'round', 'created_at'],
  state_commit: [
    'operation_id', 'scope', 'scope_key', 'branch_key', 'instance_id', 'state_version',
    'changes_json', 'intent_hash', 'result_json', 'status', 'created_at', 'history_epoch',
    'predecessor_json',
  ],
});

/** Director tables were optional in v16, but if either exists both must be complete. */
export const SESSION_DIRECTOR_STORAGE_REQUIRED_COLUMNS = freezeColumnContract({
  director_continuity_snapshot: [
    'session_id', 'projection_version', 'source_revision', 'source_round', 'parent_digest',
    'input_digest', 'projection_digest', 'projection_json', 'idempotency_key', 'created_at',
  ],
  director_continuity_invalidation: [
    'session_id', 'invalidation_version', 'invalid_from_round',
    'through_projection_version', 'reason', 'created_at',
  ],
});
