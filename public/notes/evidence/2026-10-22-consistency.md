# 2026-10-22：Cache Aside、Outbox/事务消息与 Agent 结果生命周期

本批重写 Cache Aside，保留原始 `cache-aside` 路由和 2026.10.17 写作日期；新增消息协调与结果生命周期两篇。文章中的“已运行”限定为本索引列出的实验。

## 运行环境与复现

Python 3.12.3；SQLite 3.45.1。
```text
Redis server v=7.0.15 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=d064f9f48c901a92
```

全部 Python 程序只用标准库；缓存实验另需本地 `redis-server`，并需同目录的 `redis_fixture.py`。
在仓库根目录执行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 public/notes/experiments/2026-10-22-consistency/cache_experiment.py > /tmp/cache-results.json
python3 public/notes/experiments/2026-10-22-consistency/message_experiment.py > /tmp/message-results.json
python3 public/notes/experiments/2026-10-22-consistency/artifact_experiment.py > /tmp/artifact-results.json
```

缓存实例只监听自己的临时 Unix socket，关闭 TCP 与持久化，程序退出时终止自己启动的进程。其他实验只创建临时数据库和文件。没有连接、清空或修改项目服务。
消息端是独立 SQLite 收件箱模型，**不是 RocketMQ**。没有安装或启动 RocketMQ Broker、NameServer、Proxy 或 SDK，没有模型 API 调用费用。

## 文件与实际输出

| 文件 | SHA256 |
| --- | --- |

| [artifact-results.json](/notes/experiments/2026-10-22-consistency/artifact-results.json) | `a6068b8ed570e04748a6abd7d39ddccffc099960a27817e89f4ad6dc78b9cab3` |
| [artifact_experiment.py](/notes/experiments/2026-10-22-consistency/artifact_experiment.py) | `4e4c45749cd6c98f758eb83013ead3c63abc165e2178f258e210f575927813dc` |
| [cache-results.json](/notes/experiments/2026-10-22-consistency/cache-results.json) | `8bbfc0e5e970a7729b98c474baa79470e0ad189daf734df1e759d8a845d78a28` |
| [cache_experiment.py](/notes/experiments/2026-10-22-consistency/cache_experiment.py) | `84e6ba0d8ed235535c151ad5f7eeacf4caca4ad2d8431deab936d940015fdb23` |
| [message-results.json](/notes/experiments/2026-10-22-consistency/message-results.json) | `1aff8873d253060bc50e6a1e86cee4b02fd1565a01c86cf299934158c18f294d` |
| [message_experiment.py](/notes/experiments/2026-10-22-consistency/message_experiment.py) | `66393944ac1296fe4f4fc0ec623265f61788cc7c84afb6630ec1d6d03f480123` |
| [redis_fixture.py](/notes/experiments/2026-10-22-consistency/redis_fixture.py) | `43e5ce77ff731907f3f1ffe6c0f95aea29972471594d038e0b2caebc11206f70` |

## Cache Aside：六组真实存储交错

读线程在数据库读到 version=1 后关闭连接，以 Event 通知主线程并等待。主线程提交 version=2，再执行指定 Redis 操作，最后放开读线程回填。不是随机 sleep，也没有读副本。

| 模式 | 旧回填接受 | 最终缓存版本 | watermark |
| --- | --- | --- | --- |
| plain：更新、删除、旧回填 | true | 1 | 无 |
| second_delete_before_fill：二次删除也早于旧回填 | true | 1 | 无 |
| second_delete_after_fill：旧回填后再删 | true | 无 | 无 |
| fenced：先发布门槛 2，再放开旧回填 | false | 无 | 2 |
| lost_fence：发布后主动删除门槛，再回填 | true | 1 | 无 |
| late_fence：回填后才发布门槛 | true | 无，发布前为 1 | 2 |

- 所有场景数据库最后都是 version=2；缓存为空不等于已回填 v2。
- 版本失效脚本使用 max 保持门槛单调；fenced/lost_fence 先发布 2 再发布 1。回填检查门槛与当前缓存版本，在同一个 Lua 执行中决定是否写入。
- 主动删除门槛是丢失前提的受控模拟，没有执行真实淘汰、故障切换。60 秒 TTL 只是设置值，没有等待其自然到期。
- 六组实验只检验缓存状态；R 本身已取得旧值，拒绝其回填不代表已实现新鲜响应。
- 小整数版本、单 Redis、无脚本错误、无复制延迟。不能据此声称全局强一致、线上陈旧上界或 Cluster 验证通过。

## Outbox：真实进程退出与本地收件箱

- direct 子进程在提交订单后 `os._exit(73)`：重开 SQLite 得到订单 1 行、消息 0 行。
- outbox 子进程把订单与 event-1 写在同一事务，提交后退出：待发送事件 1 行。
- 投递子进程把 event-1 持久写入独立 queue.db 后退出，未标记 sent。恢复投递再写一次，收件箱为 `[event-1,event-1]`，最终 sent=1。
- consumer.db 通过 processed(event_id) 唯一键与业务效果更新的同一事务去重，最终效果次数 1。
- 这是单投递器模型，没有真实网络 ACK、Broker 刷盘/复制或多消费者压力测试。进程退出不等于机器掉电验证。

## RocketMQ：官方协议 + 应用状态模型

脚本的 half 表模拟 HALF/READY/ROLLED_BACK，检查由测试代码手动调用。

| tx_id | 第一次检查 | 第二次检查/终态 |
| --- | --- | --- |
| tx-ok | 已有 COMMIT 记录 → COMMIT | READY |
| tx-no | 明确终止记录 → ROLLBACK | ROLLED_BACK |
| tx-pending | 暂无终态 → UNKNOWN | 本地后来提交，重查 COMMIT → READY |

成功业务与成功事务记录同事务提交；模型中的终止记录代表已确认终态，不是把“没记录”当回滚。本模型没有实现终止与原执行者的竞争协调、真正半消息、定时检查、事务超时、生产者集群检查或 SDK 回调。

正文所述半消息、第二次确认与回查流程基于官方文档；不是本次测得的 RocketMQ 行为。真实接入仍需要固定 SDK/Broker 版本、Topic、检查器和清理期限，验证这些协议假设。

## 结果产物：文件、摘要与发布

- 正常恢复得到 `answer=42`。
- 删除已引用文件：`MISSING_ARTIFACT`。
- 插入行并修改内容：朴素第 3 行变为 `item=A`，校验读取报 `INTEGRITY_ERROR`。
- 等长改写 answer=42 → answer=99：字节数保持不变，摘要校验仍报 `INTEGRITY_ERROR`，排除仅由长度校验发现变化的解释。
- 逻辑时刻 10 到期、20 恢复，年龄清理仍删除被引用对象：`MISSING_ARTIFACT`。并未等待真实定时任务。
- 先对象后引用，中途子进程退出：`NO_CHECKPOINT`，残留对象 1；先引用后对象，中途退出：`MISSING_ARTIFACT`，对象 0。
- 写入使用 flush/fsync、同目录临时文件替换和父目录 fsync，但测试仅覆盖进程退出，不覆盖断电、硬件或远端存储语义。
- 读取同一份字节做摘要校验与解析，没有重新打开路径；未实现大对象流式读取与真实模型恢复评测。

## GC 元数据模型

SQLite 事务内检查可恢复引用、pin 与 LIVE 状态。可恢复引用存在时回收影响 0 行；读者获得 pin 影响 1 行；只有 pin 时回收仍影响 0 行；都释放后回收影响 1 行进入 DELETING；此后新引用挂接影响 0 行。

只验证元数据状态条件。没有真正 GC 物理删除工作者、并发上传者、分布式读租约、崩溃 pin 回收或权限隔离测试。

## MyClaw 参考源码

下列内容只解释已有代码的证据边界；独立实验不是对此项目的集成改造。

检查时 HEAD：`db4a16bc22f7315032e91abbb88e04204fcc673a`。以下哈希对应实际工作区文件。
### myclaw/agent/loop.py

SHA256 `9a74de0599937231ef1a8c4f9fe525222e4bc888ecf2bcac53838fb6402048a4`，与 HEAD 一致。
```text
76:     )
77:     _RECOVERY_NO_LEDGER = (
78:         "Recovery note (not the original tool output): tool '{name}' call was interrupted; "
79:         "no operation ledger is configured to verify it."
80:     )
81:     _RECOVERY_NO_RECORD = (
82:         "Recovery note (not the original tool output): no operation ledger record exists for "
83:         "tool '{name}'; this cannot establish that the tool was not executed."
84:     )
85:     _RECOVERY_STATUS = {
86:         "succeeded": (
87:             "Recovery note (not the original tool output): tool '{name}' was recorded as "
88:             "succeeded before interruption; the original output is unavailable. Do not execute "
89:             "this operation again."
90:         ),
91:         "failed": (
92:             "Recovery note (not the original tool output): tool '{name}' was recorded as failed "
93:             "before interruption; the original output is unavailable. It may have caused partial "
94:             "side effects; check before retrying."
95:         ),
96:         "prepared": (
```
```text
1411:     def _recovery_tool_content(
1412:         self,
1413:         tool_call_id: str,
1414:         name: str,
1415:         function: Any,
1416:         *,
1417:         session_key: str,
1418:     ) -> str:
1419:         """Describe a pending result using the durable operation ledger only.
1420: 
1421:         Recovery must never invoke a tool or mutate the ledger.  The registry's
1422:         preparation hook is reused solely to derive the same normalized
1423:         arguments that the execution path used before hashing the operation.
1424:         """
```
### myclaw/tools/security.py

SHA256 `afd1b8952f2b99af9cd93a7bfcf2245bc0afd3beb3ae278ce503b555c430e500`，与 HEAD 一致。
```text
490:         status: str,
491:         result: Any = None,
492:         result_hash: str | None = None,
493:         result_len: int | None = None,
494:         error_type: str | None = None,
495:     ) -> bool:
496:         if result_hash is None and result is not None:
497:             result_hash, result_len = result_digest(result)
498:         with self._connect() as connection:
499:             cursor = connection.execute(
500:                 """
501:                 UPDATE operations
502:                    SET status = ?, finished_at = ?, result_hash = ?,
503:                        result_len = ?, error_type = ?
504:                  WHERE operation_id = ?
505:                 """,
506:                 (status, _timestamp(), result_hash, result_len, error_type, operation_id),
507:             )
508:             return cursor.rowcount == 1
```

## 外部依据与范围

- [Microsoft：Cache-Aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)：基础模式和一致性局限；六组交错由本次代码独立构造并运行。
- [RocketMQ 4.x：Transactional Message Sending](https://rocketmq.apache.org/docs/4.x/producer/06message5/)：半消息、确认、本地事务与回查流程。正文没有把伪代码当 SDK 可运行示例。
- [RocketMQ 5.x：Transaction Message](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)：事务消息作用范围、不可见中间态、消费业务边界与事务超时。没有引用未经验证的默认超时/检查次数。

Outbox、事务日志与 GC 的设计取舍是围绕本批故障实例作出的分析；未将方案描述为已部署项目能力。
