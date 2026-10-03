# 参与 Jiuguan

感谢你愿意帮助改进 Jiuguan。当前项目处于 `v0.1` 公开预览阶段，贡献时优先保证：

1. 不泄露用户数据；
2. 不破坏本地优先和 fail-closed 默认边界；
3. 对外说明与实际能力一致；
4. 改动能够被另一位维护者复现和验证。

## 提交 Issue 前

- 先搜索是否已有相同问题；
- 使用仓库提供的 Bug 或功能建议模板；
- 只提供复现问题所需的最小信息；
- 对主机名、绝对路径、会话 ID 和模型响应做脱敏；
- 不上传角色卡、世界书、预设、Skill、会话数据库或私人日志。

安全问题请按 [SECURITY.md](SECURITY.md) 处理，不要公开披露。

## 本地开发

```powershell
git clone https://github.com/conversition/jiuguan.git
Set-Location jiuguan
pnpm install --frozen-lockfile
```

提交前至少运行：

```powershell
pnpm public:verify
pnpm typecheck
pnpm build
```

`public:verify` 是发布隐私门禁，不能因为“只是文档”而跳过。测试和示例必须使用合成匿名数据，
不得依赖开发者电脑上的真实资产或历史会话。

## 分支与提交

- 从 `main` 创建短生命周期分支；
- 推荐分支名：`feat/...`、`fix/...`、`docs/...`、`test/...`；
- 一个提交只解决一个明确问题；
- 提交信息说明“做了什么”，必要时补充“为什么”；
- 不重写他人正在使用的公开分支。

## Pull Request 清单

- [ ] 说明了问题、方案和用户可感知变化；
- [ ] 没有提交 Key、Cookie、设备凭据、数据库、日志或个人绝对路径；
- [ ] 新增 fixture 为合成匿名数据；
- [ ] `pnpm public:verify` 通过；
- [ ] `pnpm typecheck` 通过；
- [ ] `pnpm build` 通过，或清楚解释未执行原因；
- [ ] 涉及 Agent Lane 时说明准入、预算、终止条件和回滚方式；
- [ ] 涉及数据写入时说明 schema、provenance、幂等和 revision CAS 边界；
- [ ] 文档与实际行为同步更新。

## 设计原则

- **用户控制**：高成本或有副作用的动作必须具备明确授权。
- **默认关闭**：实验 Agent 能力在未知配置下保持 fail-closed。
- **业务真值唯一**：SQLite/本地资产是业务真值；派生语义索引必须可重建。
- **提案先于写入**：模型产出 typed proposal，不直接修改业务状态。
- **移动端不保存宿主密钥**：Provider 凭据只由电脑宿主读取。
