# `@jiuguan/session`

会话编排领域包，负责酒馆会话生命周期、上下文装配、回合执行、剧情索引、分镜与视频提示词编排。

## 边界

```text
apps/server ───────────┐
                      ├──> packages/session ──> core / memory / prompt / proxy / ...
tools/cli/session shim ┘
```

- 生产服务直接依赖本包，不再依赖 `tools/cli/session.ts` 的领域实现。
- `tools/cli/session.ts` 仅是向后兼容入口，保留原来的 `pnpm session` 用法。
- 本包不得依赖 `apps/*`、`plugins/*` 或 `tools/*`。
- 运行时数据路径继续以进程工作目录为基准；迁移时不得改成相对 `import.meta.url`。

## 当前迁移边界

本轮只完成“所有权迁移”，没有在同一轮拆写 7,000 行级的 `ChatSession`，以避免把结构调整与行为重写混在一起。跨包相对路径也暂由 shrink-only baseline 管理；统一切换 `@jiuguan/*` 公共导出属于后续 2B。

后续拆分建议按以下顺序进行，并保持 `src/index.ts` 为公开门面：

1. 会话初始化与恢复；
2. 上下文收集与编译；
3. 单回合执行与 Provider 调用；
4. 提交事务、回滚与幂等；
5. 查询投影与只读接口。
