/**
 * plugin 包 - 插件清单 schema（参考 SillyTavern 插件接口：manifest.json + git 安装）
 * ST 字段兼容：display_name / name / version / description / author / homepage / license /
 *              includes(客户端 JS/CSS) / build_dir / download_script
 * 本平台扩展字段：server（服务端钩子入口，沙箱执行）
 */
import { z } from 'zod';

function isSafePluginRelativePath(value: string): boolean {
  if (!value || value.includes('\0')) return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) return false;
  const segments = normalized.split('/');
  return segments.every((segment, index) => segment !== '..' && (segment !== '.' || index === 0));
}

const PluginRelativePathSchema = z.string().refine(
  isSafePluginRelativePath,
  '路径必须位于插件目录内（禁止绝对路径与 ..）',
);

export const PluginManifestSchema = z.object({
  /** 插件 id（小写字母/数字/-/_，目录名与注册表主键） */
  name: z.string().regex(/^[a-z0-9_-]+$/, 'name 须为小写字母/数字/-/_（目录名）'),
  display_name: z.string().default(''),
  version: z.string().default('0.1.0'),
  description: z.string().default(''),
  author: z.string().default(''),
  homepage: z.string().optional(),
  license: z.string().optional(),
  /** ST 兼容：客户端 JS/CSS 文件（v1.1 预留：UI 扩展点，当前仅记录元数据） */
  includes: z.array(PluginRelativePathSchema).default([]),
  /** ST 兼容：构建产物子目录（repo 根为源码，此目录为可发布产物） */
  build_dir: PluginRelativePathSchema.optional(),
  /** ST 兼容：额外资产下载脚本（v1.1 预留） */
  download_script: z.string().optional(),
  /** 本平台扩展：服务端钩子入口文件（CJS 风格，沙箱执行） */
  server: PluginRelativePathSchema.optional(),
  /** 声明支持的钩子（信息性） */
  hooks: z.array(z.string()).optional(),
  /** 权限声明（0.5.0 沙箱强化）：未声明 = 最小权限；超范围源码拒载 */
  permissions: z.object({
    network: z.boolean().optional(),
    fs: z.boolean().optional(),
    runtime: z.boolean().optional(),
  }).default({}),
}).passthrough();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
