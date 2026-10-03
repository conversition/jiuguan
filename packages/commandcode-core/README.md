# @jiuguan/commandcode-core

电脑端可嵌入的 CommandCode 协议核心。该包只包含显式输入到输出的转换逻辑；
不读取 `process.env` 或配置文件，不监听端口，不访问网络，也不注册全局定时器。

当前 API 已固化终止原因、错误、usage、工具值转换，以及三段请求转换语义：

- Chat Completions 风格请求 → CommandCode wire 请求；
- Anthropic Messages 请求 → 统一 Chat 请求；
- OpenAI Responses 请求 → 统一 Chat 请求。

同时提供按请求实例化的 UTF-8 NDJSON 解码器、非流事件累积器、终态分类器，以及
OpenAI Chat、Anthropic Messages、OpenAI Responses 的非流响应构造器。Chat 与
另两种协议不同的 usage 来源和空响应判定由显式策略控制，不做隐式统一。
NDJSON decoder 构造时必须固定 text/bytes 模式和正整数缓冲上限；同一实例不能混用
两种输入。上游 usage 只接受白名单内的非负有限数值，其他字段不会进入计费结果。

三种协议也各自提供按请求实例化的 SSE translator。`pushLine()`/`pushEvent()` 只处理
完整 CommandCode 事件，`finalize()` 在确认 error、截断与空响应之后才生成唯一终态；
返回的 `hadOutputBeforeFinalize` 供宿主决定尚可返回 HTTP JSON，还是必须在已开始的
SSE 内发送错误。Chat、Anthropic 与 Responses 保留各自不同的 block、usage、序号和
finish-step 语义，不共用一个隐式巨型状态机。

Responses translator 另提供 `transportError(message)`：仅供宿主确认 SSE 已经开始后，
把 reader timeout、断流等传输异常编码成占用下一个 `sequence_number` 的顶层
`event: error`。它会锁住后续事件；再调用 `finalize()` 只返回错误决策，不重复发送帧，
也不会伪造 item done 或 `response.failed`。SSE 尚未开始时，宿主仍应返回普通 HTTP
JSON 错误，不能用这个入口替代自己的 header/write 状态判断。

Responses 宿主接入时必须区分“正常 EOF”与“reader 抛错/idle timeout”：

```text
正常 EOF:
  先把 decoder.finish() 产出的 event 全部 pushEvent()
  再调用 final = translator.finalize()
  success 时确保 SSE headers 后写 final.frames
  error 时：headers 已提交则写 final.frames，否则返回 final.decision 对应的 HTTP JSON

reader 抛错或 idle timeout:
  headers 未提交 -> 直接返回宿主映射的 HTTP JSON
  headers 已提交 -> 写 translator.transportError(message)，再 finalize() 记录决策并结束流
```

因此，“read() 正常返回 done 但上游没有 finish 事件”仍属于 clean EOF，必须走
`decoder.finish() + translator.finalize()`；这样 partial item 才会闭合并以
`response.failed` 收尾，不能把它误当成 transport exception。

设备指纹、日期、Responses 缺省 call id 与结构化告警均由宿主显式注入，因此核心包
不会读取电脑环境或制造隐式随机性。ID、完成时间与 Anthropic thinking 签名均由
宿主提供。ID 工厂必须同步返回非空字符串，thinking 签名函数必须同步返回字符串；
注入函数或帧序列化抛错时，translator 不会先消费对应的首帧、block/item index 或
Responses sequence。上游 transport、SSE header/背压/心跳/超时/断连的检测，以及
DSH Provider adapter 仍在后续独立提交中加入。

转换入口面向 HTTP JSON 数据：输入必须可 JSON 序列化且不能包含循环引用。为避免畸形
请求拖垮宿主，`messages`、`tools`、`tool_choice` 等集合为 `null` 或包含非对象
成员时会按空值处理；这不代表支持任意程序化 JavaScript 对象。SSE 输出序列化只复制
自有数据属性、跳过访问器，并屏蔽继承或自有的可调用 `toJSON`，防止原型污染改写整帧；
循环引用与 BigInt 会被明确拒绝。

`normalizeUsage()` 返回新的归一化对象，绝不原地修改参数；调用方必须使用其返回值，
不能沿用上游“调用后继续读取原对象”的写法。

此包只能由电脑端 runtime/plugin 使用；`apps/web` 与 `apps/mobile` 不得直接导入。
