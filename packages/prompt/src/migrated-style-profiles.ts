/**
 * 公开版不内置任何迁移文风资产。
 *
 * 上游私有素材里的 style.<作者>.v1 条目属于使用者的素材库，不随源码分发。
 * 需要文风时请在自己机器上运行 `pnpm style:import`（JG_STYLE_SRC 指向自己的文风库），
 * 由本地 skill 目录承载。此表保持为空：编译器只暴露结构，不携带任何成文内容。
 */
export const MIGRATED_STYLE_PROFILE_TEXT: Readonly<Record<string, string>> = Object.freeze({});
