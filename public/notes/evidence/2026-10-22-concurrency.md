# 2026-10-22：限流、线程池与取消的实验索引

本次新增的是实际运行的局部机制实验。源码与结果均可下载；正文区分实验观测、原理推导、设计建议与尚未验证的条件。

## 环境与隔离

Python 3.12.3，SQLite 3.45.1。
```text
openjdk version "21.0.12.1" 2026-08-18
OpenJDK Runtime Environment (build 21.0.12.1+1-1-24.04.4-Ubuntu)
OpenJDK 64-Bit Server VM (build 21.0.12.1+1-1-24.04.4-Ubuntu, mixed mode, sharing)
Redis server v=7.0.15 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=d064f9f48c901a92
```

- Java 使用单文件源码运行，不产生仓库内 class 文件；CountDownLatch 控制工作任务，不用 sleep 决定实验时序。
- Redis 实验通过 subprocess 启动自己的临时实例，只监听临时目录里的 Unix socket，TCP 端口为 0，关闭 RDB 自动快照与 AOF。无 FLUSHDB，不连接现有服务，finally 终止自己的子进程。
- Redis 代理只丢弃成功响应，未关闭 Redis 进程或注入主从故障。`EOF_UNKNOWN` 是客户端可见结果；backend_reply 是代理保存的测试证据，不向应用恢复逻辑开放。
- Python 取消实验使用真实线程与 SQLite 临时数据库；文件追加在数据库事务外模拟独立副作用。没有调用远程服务。
- 数据文件包含确定性逻辑结果，不采集机器路径、凭据或私人聊天记录。

## 复现命令

在仓库根目录运行：

```sh
java public/notes/experiments/2026-10-22-concurrency/PoolExperiment.java > /tmp/pool-results.txt
python3 public/notes/experiments/2026-10-22-concurrency/redis_experiment.py > /tmp/redis-results.json
python3 public/notes/experiments/2026-10-22-concurrency/cancel_experiment.py > /tmp/cancel-results.json
```

Java 需要支持单文件源码执行的 JDK；本次使用 Java 21。Redis 驱动需要 `redis-server` 可执行文件和同目录的两份 Lua 文件，不需要 redis-py。Python 驱动仅使用标准库。下载后保持上述文件在同一目录即可运行。

正文保存的日志来自以下原始文件。Redis 结果包含服务版本；跨版本复现时不要只比较文件哈希，还应检查逻辑结果是否改变。

## 实验文件与 SHA256

| 文件 | SHA256 |
| --- | --- |

| [PoolExperiment.java](/notes/experiments/2026-10-22-concurrency/PoolExperiment.java) | `ea77a493c04f19dee4249e0b824de1e499098a8600e985fd1306685b37ae9614` |
| [cancel-results.json](/notes/experiments/2026-10-22-concurrency/cancel-results.json) | `f3da8a682695913e093a7bb84737d5a5ce8dae4e1fcc3a6bd67363c859fa2f5d` |
| [cancel_experiment.py](/notes/experiments/2026-10-22-concurrency/cancel_experiment.py) | `2998dd7894bc39982fcc421a55569a766c4992cc66a1f0801c0bbe75bed5580a` |
| [limit.lua](/notes/experiments/2026-10-22-concurrency/limit.lua) | `7190471bb4e82418e72d946b58258cfd864178b120e465ea2531efdc8d696b1c` |
| [limit_receipt.lua](/notes/experiments/2026-10-22-concurrency/limit_receipt.lua) | `7382660cf85bfa183d37159f5f6a38694c00fb70bdd18bd1326a77e5b6ecf6e8` |
| [pool-results.txt](/notes/experiments/2026-10-22-concurrency/pool-results.txt) | `ce37e25ba91b05355f92ee6e96b9514bb8f74b0f1675aa060f7a5fab7e5855cf` |
| [redis-results.json](/notes/experiments/2026-10-22-concurrency/redis-results.json) | `86fa1f764a65f3dc7433736865a0a4cf244de26dc5000d4d8a11c9b6bc29c9de` |
| [redis_experiment.py](/notes/experiments/2026-10-22-concurrency/redis_experiment.py) | `050e5d15d7d64ace7a78c4049b3135b7e7df30860a027d12f04d29f11aac8e3e` |

## Redis 实验的输入与结果

普通脚本每桶允许两次，第一次写入后设置 60000ms TTL；测试不等待过期，不跨窗口。

1. 代理收到真实 Redis 返回 `[1,1]` 后丢弃响应。应用得到 EOF。
2. 无回执重试得到 `[1,2]`，新的逻辑请求随后得到 `[0,2]`。计数针对放行的评估，拒绝不累加。
3. 回执版本保存请求摘要与原决定。R1 丢失响应后重试得到 `[1,1,"reused"]`，桶计数仍是 1；同 ID 改摘要产生 REQUEST_CONFLICT；R2 得到 `[1,2,"new"]`。
4. `INCR → 对同一字符串 LPUSH → PEXPIRE` 故意触发 WRONGTYPE。之后 GET 为字符串 `1`，PTTL=-1，证明错误前的写入没有自动回滚且未执行后续过期设置。

回执脚本是局部演示：固定专用键类型，60 秒回执保留期，仅缓存成功准入，不支持任意历史请求永久恢复。它未验证回执写入失败、内存不足、跨窗清理、持久化恢复或 Cluster。脚本内多个写入不会被其他正常命令穿插，但仍然没有运行时错误回滚。限流去重也不等于下游业务去重。

## Java 实验的输入与结果

core=2，max=4，keepAlive=60s，AbortPolicy，不预启动线程。所有启动任务被 release 屏障挂起。

| 队列 | 提交数 | 放开屏障前 worker 数 | 排队数 | 拒绝数 | 最终完成数 |
| --- | --- | --- | --- | --- | --- |
| ArrayBlockingQueue(2) | 7 | 4 | 2 | 1 | 6 |
| LinkedBlockingQueue() | 7 | 2 | 5 | 0 | 7 |
| SynchronousQueue() | 5 | 4 | 0 | 1 | 4 |

有界队列组放开前启动的任务集合为 `[1,2,5,6]`，3、4 仍排队。集合为排序后的成员，不代表线程 1/2/5/6 之间的精确启动顺序。记录提交时的池大小和队列长度，未将 max 减 poolSize 称为“实际空闲线程”。无真实吞吐、延迟或生产配置优劣评测。

## 取消实验的输入与结果

工作线程由 `asyncio.to_thread` 启动。线程 ready 后等待 release；控制协程把 RUNNING/1 改为 CANCELLED/2 并记录事件，再 cancel 等待者，确认 CancelledError；之后才放行线程追加文件并尝试提交结果。

| 条件 | 等待者取消 | 文件追加 | 迟到更新行数 | 最终状态 | 事件 |
| --- | --- | --- | --- | --- | --- |
| 仅按任务 ID 更新 | true | 1 | 1 | SUCCEEDED | CANCELLED, SUCCEEDED |
| 同时要求 RUNNING 与 epoch=1 | true | 1 | 0 | CANCELLED | CANCELLED |

更新成功时才插入 SUCCEEDED 事件，状态和事件在同一 SQLite 事务内。文件在事务之外，因此条件提交不能撤销其副作用。

重启示例为 RUNNING/1 → CANCELLED/2 → RUNNING/3。旧 worker 只检查 RUNNING，影响 1 行；加入 epoch=1 后影响 0 行；当前 epoch=3 提交影响 1 行；成功之后的条件取消影响 0 行。这里只手动安排状态竞争，没有分布式 worker、租约、网络分区或远程 API 取消实验。

## 参考项目：仅作为问题起点

下列片段在本次写作时重新读取，并与 HEAD 比较。实验没有修改或执行这些项目代码。没有把独立实验发现冒充项目已复现缺陷。

### DOVideo-AI / server/src/main/java/com/example/server/config/ThreadPoolConfig.java

HEAD `14e25339446e78e9e0b6fd375a72184814c16fa9`；文件 SHA256 `fd795b002c04aa8584b201cd89d37be111652e98f4ba4c9f056990921d1c16c9`；与 HEAD 一致。
```text
13: public class ThreadPoolConfig {
14: 
15:     @Bean("aiTaskExecutor")
16:     public Executor aiTaskExecutor() {
17:         return executor("AI-Thread-", 4, 8, 100);
18:     }
19: 
20:     @Bean("asrExecutor")
21:     public Executor asrExecutor() {
22:         return executor("ASR-Thread-", 4, 8, 50);
23:     }
24: 
25:     @Bean("ocrExecutor")
26:     public Executor ocrExecutor() {
27:         int cores = Math.min(8, Math.max(1, Runtime.getRuntime().availableProcessors() / 2));
28:         return executor("OCR-Thread-", cores, cores, 20);
29:     }
30: 
31:     private Executor executor(String prefix, int coreSize, int maxSize, int queueCapacity) {
32:         ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
33:         executor.setCorePoolSize(coreSize);
34:         executor.setMaxPoolSize(maxSize);
35:         executor.setQueueCapacity(queueCapacity);
36:         executor.setThreadNamePrefix(prefix);
37:         executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
38:         executor.setWaitForTasksToCompleteOnShutdown(true);
39:         executor.setAwaitTerminationSeconds(30);
40:         executor.initialize();
41:         return executor;
```
### myclaw / myclaw/agent/dispatcher.py

HEAD `db4a16bc22f7315032e91abbb88e04204fcc673a`；文件 SHA256 `c2bb148826fd2d4248e743cc94a0216a01f1fbaf7e2126a970a97ea144e4128d`；与 HEAD 一致。
```text
582:     async def _stop_session(self, session_key: str) -> str:
583:         task = self._active_session_tasks.get(session_key)
584:         if task is None or task.done():
585:             self._active_session_tasks.pop(session_key, None)
586:             return "No active turn to stop."
587: 
588:         self._user_stop_sessions.add(session_key)
589:         try:
590:             task.cancel()
591:             await asyncio.gather(task, return_exceptions=True)
592:         finally:
593:             self._user_stop_sessions.discard(session_key)
594:         return "Stopped current turn."
```

## 官方参考

- [Redis：Scripting with Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/)：脚本执行期间的阻塞与原子执行语义。错误不回滚的具体结果由本次 WRONGTYPE 实验提供。
- [JDK 21：ThreadPoolExecutor](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)：核心/最大线程数、排队与拒绝的语义；本次日志独立验证三组具体行为。
- [Python 3.12：Coroutines and Tasks](https://docs.python.org/3.12/library/asyncio-task.html)：Task 的协作式取消与线程执行接口；线程继续与迟到提交由本次实验直接观测。

## 选题与叙事边界

限流、线程池选题承接已有百度 AI 搜索面试讨论；取消选题从会话执行与恢复讨论延伸，不是面试官原话。例子、实验代码与结论是这次写作新增的工作。未公开私人面试原文。
