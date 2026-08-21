诊断结论（已用 web.log + 会话 DB + git diff 三重实证）
你看到的日志序列（首轮失败→错误召回→兜底清孤儿 r2→预计算正常→窗口后生成卡住）实际是 两个真实 bug 的连锁：

Bug A（crash 根因，导致「首轮失败 + 兜底清理孤儿」）
web.log 里实锤的报错：Cannot read properties of undefined (reading 'state_changes')。
链是：turn.ts 的 safeParseTurn() 只要 JSON 里有 plan 键就放行，不校验 memory_delta/prose 是否存在；接着 normalizeTurn() 无保护地取 t.memory_delta.state_changes → 模型这次输出缺 memory_delta 时直接 TypeError 裸奔。这个异常没被 attemptTurn 的 try 接住（归一化在 try 之外），一路漏到 server 的 /api/turn catch → 触发 rollbackFailedTurn() 清孤儿 user + 轮次回退。本应走的「契约失败→干净的错误召回重试」被短路成整轮 crash。会话 DB 佐证：r2 停在「（本轮回合生成失败，请重试）」。

Bug B（0.5.0 工具 DAG 回归，记忆块静默失活 → 模型"失忆"变相引发异常输出）
git diff 1e8baf9 实证：DAG 化之前 turnInput.recall = await recallAsync(...)（完整 RecallResult，含 injectedBlock）；DAG 化之后 recall 工具返回 data: { hits, raw } 包装对象，session.ts:396 的 turnInput.recall?.injectedBlock 拿到的是 undefined → 每轮记忆块都是空的。检索10条只是 hits 长度能读，injectedBlock 丢了。同样形状问题在 update_variable/worldbook（worldbook 靠 .activated 覆盖没被察觉）。

Bug C（重试把非法参数原样回填 → 网关 400，把失败轮彻底打挂）
错误召回重试时 toolLoopMessages 把 first.tc.arguments 原样塞回 assistant.tool_calls。首轮失败恰恰常因参数被截断/非法 JSON——把非法 JSON 转发给 OpenAI 兼容网关会直接 400（web.log 昨天的 stream 失败 HTTP 400，失败轮几乎全是 retry 路径）。于是「重试」从自救变成必死。

「窗口后生成卡住」：属感知性停滞而非死锁——一旦窗口截断触发 rollingSummarize()，每轮在正式回合前额外插入一次非流式 LLM 调用（120s 超时、期间前端只有 thinking 无任何正文）；加上 bge 语义世界书扫描（recall+worldbook 两次 embed）、错误重试等，单轮 44–63s。前端无进度提示，看着就是"挂起"。没有真正的同步死锁（用 timeout 兜底了）。