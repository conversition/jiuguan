/**
 * Narrow source-level boundary for the direction/preference consolidation (P16 C3.3).
 *
 * `packages/session` 与 `apps/server` 需要消费这份纯合同，但直接相对导入
 * `packages/agent-policy/src/**` 会新增被 import 门禁拒绝的跨包私有边。
 * 运行时会走 `@jiuguan/agent-policy` 的构建产物；源码模式走这里。
 */
export {
  DIRECTION_GUIDANCE_VERSION,
  DIRECTION_GUIDANCE_DIRECTIONS,
  DIRECTION_GUIDANCE_DIRECTIONS_POOL,
  consolidateDirectionGuidance,
  directionGuidanceBlockDigest,
  renderDirectionGuidance,
  type DirectionGuidance,
  type DirectionSlot,
  type PreferenceAxis,
} from '../src/direction-consolidation.ts';
