/**
 * 公开版不内置任何迁移方法论文本。
 *
 * 上游私有素材里的 procedure step 正文属于使用者的 Skill 资产，不随源码分发。
 * 基础 stepId（continuity.scan / story.advance / state.reconcile）仍由编译器内置，
 * 其余自定义 step 请通过 Skill 包由使用者自行提供。
 */
export const MIGRATED_PROCEDURE_STEP_TEXT: Readonly<Record<string, string>> = Object.freeze({});
