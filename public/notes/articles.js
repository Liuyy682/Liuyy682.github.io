const escapeCode=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const code=(lang,s)=>`<figure class="code-example"><figcaption>${lang} · 示例</figcaption><pre><code>${escapeCode(s)}</code></pre></figure>`;
const table=(heads,rows)=>`<div class="table-scroll"><table><thead><tr>${heads.map(x=>`<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const reference=(url,title,note)=>`<p class="reference"><a href="${url}" target="_blank" rel="noopener noreferrer">${title} ↗</a><br>${note}</p>`;
// date is the original writing date (YYYY.MM.DD); preserve it across edits and deployments.
const articles=[
{
  "id": "redis-lua-rate-limit-boundaries",
  "title": "Redis Lua 保证原子性，为什么限流还是可能出问题？",
  "category": "后端工程",
  "tags": [
    "Redis",
    "Lua",
    "限流",
    "故障恢复"
  ],
  "date": "2026.10.22",
  "icon": "cache",
  "desc": "在真实 Redis 上丢弃一次限流响应，再故意触发脚本错误，观察重复扣额和未回滚的计数，拆开原子执行、重试身份与持久性三个问题。",
  "takeaway": "Lua 可以保护限流检查与更新不被其他命令穿插，但客户端仍可能不知道执行结果，运行时错误也不会自动回滚此前写入。安全重试需要另外定义身份和回执。",
  "evidenceNote": "本篇已运行 Redis 7.0.15 的响应丢失、请求回执和脚本错误实验。使用独立临时实例；没有测试 Redis 崩溃、持久化恢复、主从切换或生产流量。",
  "sections": [
    [
      "先让一次已经成功的扣额，看起来像失败",
      "<p>设定一个很小的限流规则：一个用户在桶的有效期内最多获得两次放行。第一次请求到 Redis，脚本确认还有额度，把计数加到 1，返回允许。恰好这次响应没有到达应用，应用看到连接关闭。它究竟应该重试、拒绝，还是直接放行业务？</p><p>“Lua 是原子的”无法替应用回答这个问题。原子执行描述 Redis 内部命令怎样被观察；响应是否送达描述调用链有没有闭合。面试中关于限流故障的追问，让我把这两件事分开。这次写作实际启动了一个独立 Redis，用代理丢弃成功响应，再观察客户端重试带来的变化。</p><p>实验没有连到项目正在使用的 Redis：实例只监听临时 Unix socket，关闭 TCP、RDB 自动快照和 AOF，退出后销毁临时目录。关闭持久化只是为了隔离实验，不是生产建议。应用端只能看到 EOF；代理知道成功响应，是测试侧的真实结果记录，不会把答案偷偷交给恢复逻辑。</p><p>复现材料：<a href=\"/notes/experiments/2026-10-22-concurrency/redis_experiment.py\">实验驱动</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/limit.lua\">原始限流脚本</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/limit_receipt.lua\">带回执的脚本</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/redis-results.json\">原始结果</a>，以及<a href=\"/notes/evidence/2026-10-22-concurrency.md\">运行环境、命令与证据索引</a>。文件包含实际运行代码和输出，不需要项目服务或账号凭据。</p>"
    ],
    [
      "原子执行解决的是检查与更新之间的穿插",
      "<p>先看一个没有请求身份的脚本。它读取当前计数，达到 2 就拒绝，否则增加计数；第一次增加时设置 60 秒过期。桶名在本实验中固定，过期时间从首次写入开始，不是按墙钟对齐的固定窗口。实验在过期前完成，未验证窗口切换。</p><figure class=\"code-example\"><figcaption>实际运行的 limit.lua · 核心逻辑</figcaption><pre><code>local n = tonumber(redis.call(&#x27;GET&#x27;, KEYS[1]) or &#x27;0&#x27;)\nif n &gt;= 2 then return {0, n} end\nn = redis.call(&#x27;INCR&#x27;, KEYS[1])\nif n == 1 then redis.call(&#x27;PEXPIRE&#x27;, KEYS[1], 60000) end\nreturn {1, n}</code></pre></figure><p>如果在客户端分别 GET、判断和 INCR，两次请求都可能先读到计数 1，再各自认为还有一个名额。脚本把判断与更新放在一次执行中，让后一个请求看到前一个请求留下的计数。这是它解决的竞争。<a href=\"https://redis.io/docs/latest/develop/programmability/eval-intro/\" target=\"_blank\" rel=\"noopener noreferrer\">Redis 的 Lua 文档</a>说明了脚本执行期间的阻塞与原子执行语义。</p><p>这里统计的是“被允许的评估次数”，拒绝不再增加计数。若业务要统计每一次访问尝试，计数规则就应不同。先明确计数对象很重要：后面说“重试多扣一次”，是相对于一次逻辑请求只应占一个名额的约定；如果限流本就按每次网络尝试收费，这不一定是错误。</p>"
    ],
    [
      "把响应丢失放到执行完成之后",
      "<p>实验代理接收客户端发出的 RESP 命令，转发到真实 Redis，完整读到返回值后不转发响应，直接关闭客户端连接。这样精确控制了故障位置：Redis 已执行，应用没拿到结果。它复现的是响应链路丢失，不是 Redis 执行中途宕机，也不是延迟达到某个超时阈值。</p><figure class=\"code-example\"><figcaption>受控故障时序 · 已运行</figcaption><pre><code>客户端发送限流请求 R1\n    ↓\n代理转发 → Redis 返回 [允许, 计数 1]\n    ↓\n代理保存测试证据，关闭连接，不转发响应\n    ↓\n客户端得到 EOF，执行结果未知\n    ↓\n客户端再次执行同一个无身份的限流脚本</code></pre></figure><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">动作</th><th scope=\"col\">Redis 返回或状态</th><th scope=\"col\">应用知道什么</th></tr></thead><tbody><tr><td>R1 第一次执行</td><td>[1, 1]；代理丢弃返回值</td><td>EOF，无法确认是否获得名额</td></tr><tr><td>R1 原样重试</td><td>[1, 2]</td><td>拿到放行，但同一逻辑请求占了两次</td></tr><tr><td>新的逻辑请求 R2</td><td>[0, 2]</td><td>被拒绝，额度已满</td></tr></tbody></table></div><p>这个结果没有突破每桶最多两次脚本放行的规则，却让两个额度都花在一个逻辑请求上，造成下一项误拒绝。因此不能只检查“Redis 计数有没有超过上限”；还要检查计数对应的是尝试、请求、用户动作，还是实际完成的业务。</p><p>反过来，响应未知时直接按成功处理，会在另一个执行历史里出错：假如请求根本没有到 Redis，业务就绕过了扣额。两种历史都可能表现为客户端没拿到响应，仅靠这个现象不能区分。应用必须选择保守拒绝、带身份核查或有限降级等明确策略。</p>"
    ],
    [
      "给重试一个稳定身份，复用已经作出的决定",
      "<p>第二组实验增加 request_id 和回执。回执绑定主体、原桶、操作与参数的摘要；第一次放行时保存决定和计数。同一 ID、相同摘要再来，返回已有回执；同一 ID、不同摘要则报冲突。脚本同时处理计数与回执，避免被其他正常请求穿插到中间。</p><figure class=\"code-example\"><figcaption>带回执脚本的决策顺序 · 完整代码可下载</figcaption><pre><code>查找 request_id 的回执\n  已存在且摘要相同 → 返回原放行决定，不再次加计数\n  已存在但摘要不同 → REQUEST_CONFLICT\n  不存在 → 检查额度\n      满额 → 拒绝\n      有额度 → 增加计数，保存回执，设置保留期</code></pre></figure><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">动作</th><th scope=\"col\">实际输出</th><th scope=\"col\">桶计数</th></tr></thead><tbody><tr><td>R1 第一次执行，响应丢失</td><td>测试代理看到 [1, 1, new]</td><td>1</td></tr><tr><td>R1 以同一身份重试</td><td>[1, 1, reused]</td><td>仍为 1</td></tr><tr><td>R1 改参数重试</td><td>REQUEST_CONFLICT</td><td>仍为 1</td></tr><tr><td>新请求 R2</td><td>[1, 2, new]</td><td>2</td></tr></tbody></table></div><p>复用的是 R1 当时得到的决定，回执里的 count 不保证等于当前桶计数。其他请求可能已经改变桶，不能把回执误当成实时查询。实验只缓存成功放行，拒绝是否也应缓存取决于产品语义：希望同一请求的决定永远稳定，还是允许它稍后再申请，需要另行约定。</p><p>这个方案仍有保留期前提。示例回执保留 60 秒，不能保证很久之后的旧请求仍去重；跨窗口重试不能随意改成当前桶再重新申请。实际协议要保存请求与原窗口的绑定，并明确恢复期限。Cluster 场景的多键还需要满足同槽要求；示例使用相同 hash tag，但本次运行的是单实例，未测试 Cluster。</p>"
    ],
    [
      "脚本报错，为什么之前的 INCR 还在",
      "<p>另一个常见误解是把脚本原子执行理解成数据库式的“全部成功或全部回滚”。我实际运行了下面的故障脚本：先向计数键 INCR，再故意对这个字符串键执行 LPUSH，最后才设置过期时间。第二条命令会因类型错误中止执行。</p><figure class=\"code-example\"><figcaption>故意构造的错误 · 请仅在隔离实例复现</figcaption><pre><code>redis.call(&#x27;INCR&#x27;, KEYS[1])\nredis.call(&#x27;LPUSH&#x27;, KEYS[1], &#x27;x&#x27;)  -- 对字符串执行列表命令\nredis.call(&#x27;PEXPIRE&#x27;, KEYS[1], 60000)</code></pre></figure><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">检查项</th><th scope=\"col\">Redis 7.0.15 实际结果</th><th scope=\"col\">解释</th></tr></thead><tbody><tr><td>脚本结果</td><td>WRONGTYPE</td><td>执行没有正常结束</td></tr><tr><td>GET 计数键</td><td>1</td><td>前面的 INCR 已生效</td></tr><tr><td>PTTL 计数键</td><td>-1</td><td>键存在，但没有过期时间</td></tr></tbody></table></div><p>所以一个返回错误的调用仍可能改变状态。这里不是其他命令插进了脚本，而是脚本自己的后续语句失败，已完成的写入留了下来。把设置过期放在最后，却只考虑正常返回，会留下不自动消失的限流键。</p><p>设计时应在写入前尽量检查参数、键类型和必要前提，减少可预见的中途错误；写入后的失败仍需有观测与修复路径。带回执脚本也不因此自动拥有回滚：若加计数之后、保存回执之前出错，仍可能出现计数与回执不一致。本文示例使用专用键、固定类型来验证正常路径上的响应丢失，不把它当成已覆盖内存不足、键污染和所有运行时故障的生产限流器。</p>"
    ],
    [
      "获得名额之后，业务执行还需要自己的协议",
      "<p>限流允许意味着这一请求获得了准入资格，不意味着业务已经成功。假设拿到名额后应用崩溃，业务可能没有执行；如果拿到名额、执行完业务后才丢失响应，重新取得同一回执也不应该再次执行业务。限流 request_id 与业务 operation_id 可以关联，但两层的去重责任要分别落实。</p><p>也不能看到业务失败就无条件 DECR 退还额度。一个超时结果可能仍在远端执行；重复补偿又可能退两次；原桶已经过期时，对新桶操作更会改变错误的统计周期。如果需求只是限制进入系统的请求速率，执行失败仍消耗一次准入额度往往更容易定义。若额度代表可退款的业务预算，则需要独立的占用、确认、释放状态，而不仅是一个数字。</p><p>缓存回执防止同一逻辑请求重复占额，也要防止客户端反复拿同一 ID 的允许结果触发多次昂贵工作。因此回执只证明“这项操作曾获准”，执行端仍需把这项操作只做一次或安全核验。否则限流去重反而成为绕过访问次数限制的入口。</p>"
    ],
    [
      "发生故障时，到底选择限制什么风险",
      "<p>Redis 不可达时，fail-open 可以保可用性，但可能让下游过载；fail-closed 可以保护预算，却会拒绝本来有额度的请求。选择取决于保护对象，例如昂贵模型调用、公开查询或登录尝试的代价并不一样。可设计有限的本地应急额度，但多个实例各自放行的额度会累加，需要在风险预算里计算。</p><p>持久性又是另一个维度：进程恢复或副本切换之后能恢复哪些计数和回执，取决于部署与持久化、复制策略，不能从 Lua 原子性推出。本文关闭持久化的临时实例没有做这类实验，也没有给出“故障切换不丢额度”的承诺。</p><p>我会分别观察脚本成功、明确拒绝、执行结果未知、回执复用和脚本错误的数量；计数键无 TTL 的异常需要单独告警。不要把 Redis 连接错误当成达到额度上限返回同一个错误码，否则无法区分应该等待窗口恢复，还是修复依赖故障。</p>"
    ],
    [
      "这次实验改变了我会怎样回答限流问题",
      "<p>现在可以拿出三组具体证据：丢弃真实成功响应后，原脚本把一次请求计成两次；稳定身份与回执让重复请求保持一次计数；故意类型错误留下计数 1 与 PTTL=-1。它们分别约束重试、准入身份和错误处理，不能合并成一句“Lua 保证一致性”。</p><p>未验证的部分也清楚：真实故障切换、窗口跨越、回执清理、内存不足和业务执行去重都还需要各自的实验。后续完善限流器时，我会围绕这些缺口逐个验收，而不是仅增加脚本行数或重试次数。</p><p>复现材料：<a href=\"/notes/experiments/2026-10-22-concurrency/redis_experiment.py\">实验驱动</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/limit.lua\">原始限流脚本</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/limit_receipt.lua\">带回执的脚本</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/redis-results.json\">原始结果</a>，以及<a href=\"/notes/evidence/2026-10-22-concurrency.md\">运行环境、命令与证据索引</a>。文件包含实际运行代码和输出，不需要项目服务或账号凭据。</p><p>外部副作用与未知结果的处理，可继续阅读 <a href=\"#/article/agent-unknown-outcome\">工具执行成功了，但 Agent 没收到结果，重试安全吗？</a>。</p>"
    ]
  ]
},
{
  "id": "thread-pool-queue-growth",
  "title": "线程池还有空闲线程，任务为什么却在排队？",
  "category": "计算机基础",
  "tags": [
    "Java",
    "线程池",
    "并发",
    "背压"
  ],
  "date": "2026.10.22",
  "icon": "flow",
  "desc": "固定核心 2、最大 4，用屏障让任务保持运行，逐个提交观察扩容与拒绝，再对照三种队列解释“没用满最大线程数”的原因。",
  "takeaway": "maximumPoolSize 是增长上限，不是已创建的空闲线程数。核心线程达到后，能入队的任务通常先入队；队列选择决定线程增长与拒绝发生在哪里。",
  "evidenceNote": "本篇已在 OpenJDK 21.0.12.1 上运行三种队列的 ThreadPoolExecutor 对照。日志来自屏障控制的真实线程，不是时序模拟；未测生产吞吐或延迟。",
  "sections": [
    [
      "先核对：真有空闲线程，还是最大值还没用满",
      "<p>配置写着 corePoolSize=2、maximumPoolSize=4，连续提交四个长任务，监控却显示只有两个线程，另外两个任务排队。直觉上像是“还有两条空闲线程，为什么不用”。但 maximum=4 只表示最多可以增长到四条，不表示另外两条已经创建并且空闲。</p><p>这个问题与视频分析的容量追问直接相关：如果误把配置上限当成有效并发，前面的吞吐计算会从输入就错。这次我写了一个真实 Java 实验，固定任务不结束，逐次观察线程数与队列长度；再只改变队列，检查结果是否仍然相同。</p><p>如果监控已经证明存在活着且长期空闲的工作线程，同时队列持续积压，就需要继续检查线程状态、队列实现、任务是否真的属于同一执行器，以及采样时序。本文复现的是“最大值尚有余量但没有继续建线程”，不能包办所有看起来像闲置的情况。</p><p>复现材料：<a href=\"/notes/experiments/2026-10-22-concurrency/PoolExperiment.java\">Java 实验源码</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/pool-results.txt\">完整执行日志</a>，以及<a href=\"/notes/evidence/2026-10-22-concurrency.md\">运行环境、命令与证据索引</a>。文件包含实际运行代码和输出，不需要项目服务或账号凭据。</p>"
    ],
    [
      "把提交规则翻译成可以预测下一步的分支",
      "<p>对于本文使用的标准 ThreadPoolExecutor，在运行状态下，可以用三步理解核心决策：线程数少于 core 时优先创建线程；达到 core 后尝试把任务加入队列；队列不接受时，再尝试增长到 max，增长失败才进入拒绝处理。shutdown 等并发状态变化还有复查分支，不能把这段简化规则当完整源码。</p><figure class=\"code-example\"><figcaption>正常运行条件下的决策摘要</figcaption><pre><code>execute(task)\n  workerCount &lt; core → 尝试启动 worker，直接执行 task\n  否则 queue.offer(task) 成功 → 留在队列等 worker 获取\n  否则 workerCount &lt; max → 尝试启动 worker，直接执行 task\n  否则 → 调用拒绝策略</code></pre></figure><p>因此影响“什么时候扩容”的不只是 max，还有 queue.offer 是否愿意接收。一个还能存入任务的队列，会让请求停在入队分支。把 max 从 4 改成 40，如果队列仍然接收全部任务，不能指望执行线程自动涨到 40。这一规则可以与 <a href=\"https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html\" target=\"_blank\" rel=\"noopener noreferrer\">JDK 21 的 ThreadPoolExecutor 文档</a>核对；后面用日志验证具体边界。</p>"
    ],
    [
      "实验怎样保证任务不会在观测前悄悄完成",
      "<p>所有工作任务启动后先记录自己的编号，再等待同一个 CountDownLatch。主线程负责逐个 execute，若创建了新 worker，就等待该任务的 entered 屏障确认它已进入 run，然后采集 poolSize 和 queue.size。直到所有观测结束，才统一放开 release。</p><p>这样第一个任务不会在第六个提交前偶然结束，队列也不会因为 CPU 调度恰好快一点而腾空。实验没有使用 sleep 来猜测任务是否已启动；等待都有超时，防止错误实现让复现无限挂住。线程启动先后仍可能变化，因此“已启动任务集合”在输出前排序，不冒充它们的精确启动时间顺序。</p><figure class=\"code-example\"><figcaption>实际实验的关键控制</figcaption><pre><code>CountDownLatch release = new CountDownLatch(1);\n// 每个任务：\nstarted.add(id);\nentered.countDown();\nrelease.await(10, TimeUnit.SECONDS);\n\n// 主线程提交并采集；最后统一执行：\nrelease.countDown();\npool.shutdown();\npool.awaitTermination(5, TimeUnit.SECONDS);</code></pre></figure><p>固定参数是 core=2、max=4、keepAlive=60 秒、AbortPolicy，不预启动核心线程。第一组使用容量 2 的 ArrayBlockingQueue，共提交七个任务。实验结束后还检查成功完成数是否等于被接受的任务数，避免只看提交日志却漏掉任务没有执行。</p>"
    ],
    [
      "有界队列：第 5 个任务为什么越过第 3 个",
      "<div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">提交任务</th><th scope=\"col\">接受？</th><th scope=\"col\">池内线程数</th><th scope=\"col\">队列长度</th><th scope=\"col\">由哪条分支决定</th></tr></thead><tbody><tr><td>1</td><td>是</td><td>1</td><td>0</td><td>不足 core，创建 worker</td></tr><tr><td>2</td><td>是</td><td>2</td><td>0</td><td>不足 core，创建 worker</td></tr><tr><td>3</td><td>是</td><td>2</td><td>1</td><td>队列接收</td></tr><tr><td>4</td><td>是</td><td>2</td><td>2</td><td>队列接收</td></tr><tr><td>5</td><td>是</td><td>3</td><td>2</td><td>队列已满，创建非核心 worker</td></tr><tr><td>6</td><td>是</td><td>4</td><td>2</td><td>队列已满，继续增长到 max</td></tr><tr><td>7</td><td>否</td><td>4</td><td>2</td><td>队列满且达到 max，AbortPolicy 抛异常</td></tr></tbody></table></div><p>放开屏障前，日志里的已启动任务集合是 <code>[1, 2, 5, 6]</code>，而 3、4 仍在队列。这个结果比“达到核心之后先入队”更值得注意：后到的 5、6 被直接交给新 worker，先于队列里的 3、4 开始。</p><p>ArrayBlockingQueue 的 FIFO 约束是队列中元素的取出顺序，不能推导为整个线程池严格按提交顺序开始，更不保证按提交顺序完成。新 worker 的首任务绕过了队列；即使所有任务都排队，多个 worker 的运行速度也不一致。如果业务要求同会话顺序，不能仅靠把任务塞进 FIFO 队列。</p><p>最终日志显示六个接受任务全部完成，第七个明确被拒绝。这里拒绝发生在调用 execute 的线程，调用方有机会把它转换成可观察的受理失败。如果捕获异常后仍返回“任务已提交”，就把可见的容量边界变成了任务丢失。</p>"
    ],
    [
      "只换队列，为什么三组结果不同",
      "<p>第二组使用默认容量的 LinkedBlockingQueue，第三组使用不保存任务的 SynchronousQueue。其他 core、max 与拒绝策略不变；第三组提交到第五个就足以观察拒绝。真实输出如下。</p><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">队列</th><th scope=\"col\">提交数量</th><th scope=\"col\">放开前线程数</th><th scope=\"col\">排队数</th><th scope=\"col\">拒绝数</th></tr></thead><tbody><tr><td>ArrayBlockingQueue(2)</td><td>7</td><td>4</td><td>2</td><td>1</td></tr><tr><td>LinkedBlockingQueue()</td><td>7</td><td>2</td><td>5</td><td>0</td></tr><tr><td>SynchronousQueue()</td><td>5</td><td>4</td><td>0</td><td>1</td></tr></tbody></table></div><p>LinkedBlockingQueue 的默认容量极大，本例七个任务远没有填满它，所以到 core=2 后持续入队，max=4 没有参与扩容。这不是 max 参数失效，而是触发它的条件没有发生。“无界”也是工程上的习惯说法：内存和实现上限仍有限，无限接收并不存在。</p><p>SynchronousQueue 不提供存储空间，需要把任务直接交给等待接收者。本例所有已创建 worker 都被屏障占住，没有人接收后续任务，于是第 3、4 项推动建线程，第 5 项被拒绝。若有 worker 正在等待获取任务，直接交接可能成功，因此也不能把它概括成“每来一个任务就创建线程”。</p><p>三种队列分别把过载压力放在等待、线程增长和即时拒绝的不同位置。本文没有从这个小实验得出某一种队列吞吐更高；它测的是决策路径，不是性能排名。</p>"
    ],
    [
      "回到项目配置，先预测能观察到什么",
      "<p>DOVideo-AI 的 ThreadPoolConfig 把 ASR 执行器配置为核心 4、最大 8、队列 50，并使用 AbortPolicy。这提供了一个可检查的假设：在标准队列行为、持续占满核心线程、没有任务完成的条件下，接下来 50 个任务可以排队，只有后续无法入队的提交才会推动更多线程启动。</p><p>这个推断只描述该执行器。上一篇容量分析已经沿调用链区分了消费者与 ASR/OCR 分支；不能把 ASR 的 max=8 当成整条视频消费链的并发。还要确认每次提交代表一个视频分支、一个音频片段，还是另一种工作单位，才能把线程数换算成视频处理能力。</p><p>大队列的好处是容纳短时突发，但会推迟扩容与拒绝，也会增加排队时间。如果任务在执行之前就已过期，最终“全部执行成功”也不能代表用户体验合格。缩小队列让线程更早增长，则会更早争用 CPU、磁盘或第三方额度；调整前需要明确下游还能承受多少并发。</p>"
    ],
    [
      "拒绝策略和任务依赖，会改变实际后果",
      "<p>AbortPolicy 把饱和暴露成异常。CallerRunsPolicy 则可能让提交者直接执行任务，把压力传回上游，但它会改变调用线程的工作内容：提交者若是 HTTP、MQ 或事件循环线程，就可能被长任务占住。在执行器已经关闭的情况下，其处理也不同于正常饱和，不能把它当作任何时候都保证执行的保险。</p><p>还有一种不靠满队列也能卡住的情况：两个核心 worker 都在执行父任务，父任务各自提交子任务到同一无界队列，然后同步等待子任务完成。子任务能顺利入队，因此不会触发增长；两个 worker 又都在等它们。这形成等待环。此处是机制推演，本文没有另外运行这组死锁实验。</p><p>解决思路不是无限增大 max，而是拆掉等待关系：避免在占用同一资源池时同步等待它的后续工作，使用完成回调或异步组合，必要时为具有不同资源需求的阶段设置明确的执行边界。独立线程池仍可能争同一块 CPU 或外部额度，隔离了队列不代表隔离了所有资源。</p>"
    ],
    [
      "我会怎样观察一次真实配置调整",
      "<p>首先同时采集 poolSize、activeCount、queue.size、拒绝数，以及任务从提交到开始、从开始到结束的时间。poolSize 与 max 的差值只能说明增长余量；activeCount 等运行指标属于采样估计，短瞬间不一致不能直接诊断线程池损坏。还要关联线程栈，看 worker 是计算、阻塞 I/O，还是等待其他任务。</p><p>然后固定任务构成，分别改变队列容量或核心线程数，比较完成速率和排队时间。只改 max 而队列一直不满，预期不会改变本实验所解释的并发；如果真实观察不同，就检查运行时配置、队列类型与是否存在动态调整。假设应该能被观测推翻，而不是把所有结果都解释成调参有效。</p><p>本次工作已经提供三个可重跑的队列对照，以及第 5、6 项越过第 3、4 项的具体日志。它把“还有空闲线程”的模糊描述改成了可验证的问题：到底有几个 worker、谁在等待、队列是否接收、哪次提交触发了增长。生产吞吐和最优参数仍需用真实负载测量。</p><p>复现材料：<a href=\"/notes/experiments/2026-10-22-concurrency/PoolExperiment.java\">Java 实验源码</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/pool-results.txt\">完整执行日志</a>，以及<a href=\"/notes/evidence/2026-10-22-concurrency.md\">运行环境、命令与证据索引</a>。文件包含实际运行代码和输出，不需要项目服务或账号凭据。</p><p>关于有效并发如何影响积压，可继续阅读 <a href=\"#/article/video-analysis-capacity\">视频分析请求涨了十倍，瓶颈到底在哪里？</a>。</p>"
    ]
  ]
},
{
  "id": "async-cancel-late-results",
  "title": "异步任务取消了，为什么结果还是写回来了？",
  "category": "后端工程",
  "tags": [
    "asyncio",
    "任务取消",
    "状态机",
    "并发控制"
  ],
  "date": "2026.10.22",
  "icon": "flow",
  "desc": "用真实后台线程复现取消后继续执行，再通过 SQLite 条件提交挡住迟到成功，追踪取消状态、执行代次与外部副作用各自的边界。",
  "takeaway": "取消等待者不等于停止底层工作。取消与完成需要争用同一个受控提交点，旧执行代次不能发布结果；即使提交被拒绝，外部副作用仍可能已经发生。",
  "evidenceNote": "本篇已运行 asyncio.to_thread、线程屏障和 SQLite 提交竞争实验。文件追加模拟独立副作用；没有验证远程 API 取消、进程终止或分布式调度。",
  "sections": [
    [
      "取消按钮亮了，任务就真的停止了吗",
      "<p>用户点击取消，页面显示“已取消”。过几秒，一条成功事件又到达，结果文件也写出来了。这个现象可能涉及三个不同动作：停止当前协程继续等待，禁止这次执行提交结果，以及让实际计算或外部服务停止。只完成其中一个，不能把另外两个也宣布完成。</p><p>这一选题从会话执行与恢复讨论延伸而来，不把标题冒充面试官原话。本次我用 asyncio.to_thread 启动真实线程，在线程继续前先取消等待它的 Task，再放行线程；随后对比无条件更新和带状态、执行代次的提交。这样能看到“取消后还会发生什么”，而不只是画一个理想状态机。</p><p>项目里 MyClaw 的停止会话路径会找到活动 Task，调用 cancel 并等待它收尾。这个源码动作说明上层尝试停止当前 turn，不能单凭它证明所有底层线程、子进程或远程调用都已经停止。本文不据此宣称项目存在某个已复现的线上取消缺陷，后面的故障发生在独立实验里。</p><p>复现材料：<a href=\"/notes/experiments/2026-10-22-concurrency/cancel_experiment.py\">取消与提交实验</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/cancel-results.json\">原始结果</a>，以及<a href=\"/notes/evidence/2026-10-22-concurrency.md\">运行环境、命令与证据索引</a>。文件包含实际运行代码和输出，不需要项目服务或账号凭据。</p>"
    ],
    [
      "把取消拆成四个可以分别确认的事实",
      "<div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">层次</th><th scope=\"col\">具体动作</th><th scope=\"col\">可以承诺什么</th></tr></thead><tbody><tr><td>用户意图</td><td>记录取消请求</td><td>服务知道用户不再需要继续</td></tr><tr><td>调度与状态</td><td>撤销当前执行的提交权</td><td>该代执行不能再发布成功结果</td></tr><tr><td>本地执行</td><td>请求 Task 取消、通知线程或终止子进程</td><td>取决于具体执行单元是否响应</td></tr><tr><td>外部副作用</td><td>远程取消、幂等核验或补偿</td><td>依赖目标系统的协议与可逆性</td></tr></tbody></table></div><p>asyncio 的 Task.cancel 会请求在协程中注入 CancelledError。协程可以在清理阶段处理它，取消并不是任意指令位置的强制终止。<a href=\"https://docs.python.org/3.12/library/asyncio-task.html\" target=\"_blank\" rel=\"noopener noreferrer\">Python 的 Task 文档</a>解释了这类协作式取消行为。</p><p>to_thread 的工作运行在另一个线程。取消等待它的协程，不会让已经开始的 Python 线程在任意位置被安全杀掉。接下来不靠这句说明直接推导结果，而是用屏障保证线程已经启动、又尚未写文件，然后实际取消等待者。</p>"
    ],
    [
      "第一组实验：取消后仍然追加文件、写入成功",
      "<p>数据库中只有一项 job-1，初始 state=RUNNING、epoch=1。工作线程启动后发出 ready 信号，并等待 release。控制协程收到 ready 后，把数据库改为 CANCELLED、epoch=2，记录取消事件，然后 cancel 掉等待 to_thread 的 Task，确认收到 CancelledError。</p><p>直到这些步骤完成，实验才设置 release。工作线程继续向独立文件追加一行，再把任务状态无条件改成 SUCCEEDED，并记录成功事件。文件写入在任务状态事务之外，用来模拟无法跟数据库提交一起撤销的副作用。</p><figure class=\"code-example\"><figcaption>已运行的先后关系 · 不依赖 sleep</figcaption><pre><code>worker 已启动 → 等待 release\n控制协程：RUNNING/1 → CANCELLED/2，提交取消事件\n控制协程：Task.cancel() → await 得到 CancelledError\n控制协程：放开 release\nworker：追加文件 → 无条件写入 SUCCEEDED → 提交成功事件</code></pre></figure><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">观察项</th><th scope=\"col\">实际结果</th><th scope=\"col\">说明</th></tr></thead><tbody><tr><td>等待者取消</td><td>true</td><td>上层 Task 确实已取消</td></tr><tr><td>底层线程继续</td><td>true</td><td>取消没有终止已经启动的线程</td></tr><tr><td>文件追加次数</td><td>1</td><td>副作用发生在取消记录之后</td></tr><tr><td>最终任务状态</td><td>SUCCEEDED</td><td>迟到提交覆盖了 CANCELLED</td></tr><tr><td>事件顺序</td><td>CANCELLED → SUCCEEDED</td><td>客户端也可能收到自相矛盾的终态</td></tr></tbody></table></div><p>这个实验没有伪造“取消调用没成功”：等待者确实收到异常，任务数据库也确实记录过取消。错误发生在后续提交没有检查自己是否仍有权发布结果。由此需要修复的是提交协议，而不仅是多调用一次 cancel。</p>"
    ],
    [
      "让取消和完成在同一个提交点竞争",
      "<p>第二组实验保持同样时序，只修改成功提交条件：必须仍是 RUNNING，并且 epoch 仍等于当前 worker 启动时拿到的 1。状态更新和成功事件写入放在同一数据库事务中，只有影响行数为 1 才写成功事件。</p><figure class=\"code-example\"><figcaption>实验中的条件提交</figcaption><pre><code>UPDATE jobs\nSET state=&#x27;SUCCEEDED&#x27;, result=&#x27;late&#x27;\nWHERE id=&#x27;job-1&#x27; AND state=&#x27;RUNNING&#x27; AND epoch=1;\n\n-- 仅当 rowcount == 1：\nINSERT INTO events(kind) VALUES (&#x27;SUCCEEDED&#x27;);\n-- 两步属于同一事务</code></pre></figure><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">观察项</th><th scope=\"col\">无条件提交</th><th scope=\"col\">状态 + epoch 条件提交</th></tr></thead><tbody><tr><td>迟到成功更新行数</td><td>1</td><td>0</td></tr><tr><td>最终状态</td><td>SUCCEEDED</td><td>CANCELLED</td></tr><tr><td>持久事件</td><td>取消、成功</td><td>只有取消</td></tr><tr><td>文件追加次数</td><td>1</td><td>仍然是 1</td></tr></tbody></table></div><p>这里被修复的是“谁能提交任务结果”。影响行数为 0 必须进入显式的过期结果处理，不能继续广播成功、覆盖业务结果或向调用方返回“保存成功”。如果先发 SSE 成功事件再检查数据库，前端仍可能看到错误结论；可以先提交状态和持久事件，再由发布器投递。跨进程发布的重试与去重还需要另行设计。</p><p>取消本身也应使用条件更新，例如只把 RUNNING 改为 CANCELLED 并增加 epoch，而不是无条件覆盖终态。成功先提交时，后来的取消应返回“已经完成”或相应状态；取消先提交时，迟到成功应失败。选择由哪个受控提交先成功来决定结果，才能解释并发下的行为，而不是承诺客户端点击瞬间一定赢。</p>"
    ],
    [
      "为什么只判断 RUNNING 仍然不够",
      "<p>再增加一个场景：同一个任务 ID 被取消后重新执行。状态先从 RUNNING 变成 CANCELLED，再变回 RUNNING。旧 worker 此时恢复，只检查 state=RUNNING，会误以为仍是自己的那次执行。这是状态值恢复相同、执行身份已经变化的问题。</p><figure class=\"code-example\"><figcaption>实际执行的重启序列</figcaption><pre><code>原执行：RUNNING，epoch=1\n取消后：CANCELLED，epoch=2\n重新执行：RUNNING，epoch=3\n\n旧 worker 携带 epoch=1 返回\n  只检查 RUNNING → 更新 1 行，错误接纳旧结果\n  同时检查 epoch=1 → 更新 0 行，拒绝旧结果\n新 worker 携带 epoch=3 → 更新 1 行</code></pre></figure><p>脚本还验证了成功先发生的分支：当前 epoch=3 的结果提交成功后，再执行仅匹配 RUNNING 的取消，影响行数为 0。因此两个方向都由数据库条件决定，不需要假设某个网络请求先到就一定先提交。</p><p>epoch 描述同一任务的执行代次。它应由可信调度状态单调推进，不能由 worker 随意填写，也不能在重试时从客户端重新生成并丢掉关联。采用全新 attempt_id 也能表达类似关系；关键是旧执行不能与新执行共享同一个提交资格。</p>"
    ],
    [
      "副作用还在，为什么仍然值得拒绝迟到结果",
      "<p>修复后的实验仍写入了一行文件。这不是条件提交失效，而是文件追加发生在数据库事务外：数据库可以拒绝任务状态变更，却不能倒放已经发生的另一个系统的操作。把 CANCELLED 解释成“所有操作都被撤销”，会再次越过证据边界。</p><p>不同副作用需要不同处理。查询型工作可以丢弃迟到响应；生成文件可以写入私有临时对象，仅在条件提交成功后发布引用，未发布对象通过独立清理流程回收；转账或发消息通常不能靠删除临时文件解决，需要目标端操作身份、结果查询和业务补偿。</p><p>即使先检查数据库“还在 RUNNING”，检查与外部动作之间仍有窗口：检查通过后用户取消，worker 接着发送消息。所以把检查放到工具调用前有助于尽快停止，却不是最终保证。若要求取消后绝不产生某项副作用，需要执行端参与授权、版本或提交协议；目标端不支持时，应明确不可取消点和可能继续发生的动作。</p><p>前端文案也应匹配实际语义：可以分别展示“取消请求已记录”“已停止继续调度”“远端仍在处理”。如果产品选择立即把任务标为取消，本篇的 CANCELLED 应理解为这次执行失去发布资格，而不是所有资源已回收、所有效果已回滚。</p>"
    ],
    [
      "尽早停下来，与可靠挡住提交，需要同时做",
      "<p>状态条件处理最终正确性，协作取消减少资源浪费，两者用途不同。长循环可以在阶段边界检查停止信号；阻塞 I/O 需要合理超时；子进程要明确终止对象和清理方式；第三方服务若提供取消接口，要核对返回的是接受取消请求还是已经停止。</p><p>在 asyncio 中捕获 CancelledError 做必要清理后，通常应继续传播，避免上层误以为正常完成。清理也要有期限，不能为了等待一个无法停止的线程，让用户取消请求永远不返回。与此同时，底层仍运行的任务需要留有记录，不能在前端隐藏后就失去追踪。</p><p>MyClaw 的活动 Task 停止路径为这类分析提供了入口，视频分析中的分支取消也会遇到类似问题；但是否能停止 FFmpeg、HTTP 请求或 SDK 内部线程，必须检查各自调用和清理路径。本次只验证 to_thread 的具体行为，没有把结果推广成所有框架、客户端库的取消语义。</p>"
    ],
    [
      "验收时，不要只检查接口返回了 cancelled",
      "<p>我会把取消验收拆成竞争矩阵。对于已经有代码覆盖的格子保留输出；对于尚未实现的外部协议，保留为待测项，不用绿色通过标记代替证据。</p><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">场景</th><th scope=\"col\">本次证据</th><th scope=\"col\">验收重点</th></tr></thead><tbody><tr><td>取消先提交，旧结果随后到达</td><td>已运行：条件更新 0 行</td><td>终态与成功事件不被覆盖</td></tr><tr><td>成功先提交，取消随后到达</td><td>已运行：取消更新 0 行</td><td>如实返回已完成，不伪造取消成功</td></tr><tr><td>取消后重新执行，旧 worker 返回</td><td>已运行：state-only 通过，epoch 条件拒绝</td><td>执行身份不能混用</td></tr><tr><td>等待者已取消，底层线程继续</td><td>已运行：文件追加 1 次</td><td>区分上层停止与副作用</td></tr><tr><td>远程取消超时、worker 失联或进程崩溃</td><td>本次未运行</td><td>核验外部结果、回收资源并恢复事件</td></tr></tbody></table></div><p>这次得到的关键结论是可重复的：取消信号无法替代提交检查；状态名不足以区分不同执行；禁止成功发布也不等于撤销副作用。下一步完善系统时，应该沿这三条边界增加具体能力，而不是给取消按钮加一个更确定的提示。</p><p>复现材料：<a href=\"/notes/experiments/2026-10-22-concurrency/cancel_experiment.py\">取消与提交实验</a>、<a href=\"/notes/experiments/2026-10-22-concurrency/cancel-results.json\">原始结果</a>，以及<a href=\"/notes/evidence/2026-10-22-concurrency.md\">运行环境、命令与证据索引</a>。文件包含实际运行代码和输出，不需要项目服务或账号凭据。</p><p>多实例中的执行归属，可结合 <a href=\"#/article/multi-user-agent-boundaries\">把单用户 Agent 开放给 500 人</a> 阅读；外部动作恢复见 <a href=\"#/article/agent-unknown-outcome\">工具结果未知时的重试设计</a>。</p>"
    ]
  ]
},
{
  "id": "video-analysis-capacity",
  "title": "视频分析请求涨了十倍，瓶颈到底在哪里？",
  "category": "后端工程",
  "tags": [
    "容量分析",
    "排队",
    "视频处理"
  ],
  "date": "2026.10.22",
  "icon": "flow",
  "desc": "从消费者真正等待的代码路径出发，用可复现的排队模拟解释为什么增加线程仍会积压，再把诊断落到 CPU、磁盘与外部调用额度。",
  "takeaway": "先把到达率、单任务资源需求和有效并发换成同一单位，再判断容量缺口。消息队列能承接等待，但能否追上流量取决于最紧张的资源。",
  "evidenceNote": "本篇包含源码复核和已运行的确定性排队模拟。输入为假设数据，不代表真实视频压测；扩容方案尚未在项目环境验证。",
  "sections": [
    [
      "接口很快，为什么用户仍然等得更久",
      "<p>假设视频分析原来每分钟收到 4 个任务，现在增长到 40 个。上传与受理接口仍然很快，用户却反馈“进度一直停在分析中”。此时直接回答“扩容 RocketMQ”或“把消费者线程翻倍”，跳过了决定方案是否有效的计算：每个任务到底占用了哪些资源，多长时间才能释放？</p><p>这个问题来自面试中对消息积压和系统容量的追问。本次整理做了两件具体工作：沿 DOVideo-AI 的消费调用链确认等待发生在哪里；写一个离散事件脚本，观察容量不足时队列怎样增长。前者提供结构证据，后者验证计算。尚未运行真实视频、OCR、ASR 或消息队列压测，因此本文不会给这些组件排一个未经测量的瓶颈名次。</p><p>复现入口：<a href=\"/notes/experiments/2026-10-22/reproduce.py\">Python 脚本</a>、<a href=\"/notes/experiments/2026-10-22/results.json\">原始 JSON 输出</a>、<a href=\"/notes/evidence/2026-10-22.md\">源码摘录与证据索引</a>。下载脚本后执行 <code>python3 reproduce.py &gt; results.json</code>；仅依赖标准库，不调用模型或外部服务。</p>"
    ],
    [
      "先确认谁在等，别被 async 的名字误导",
      "<p>在所检查的版本中，<code>VideoAnalysisConsumer.onMessage()</code> 调用 <code>AiService.asyncAnalyze()</code>，后者继续调用 <code>VideoContextService.build()</code> 和 Agent 循环。方法名虽然包含 async，这条调用路径没有把整项分析直接交给另一个后台线程然后返回。消费者会经过分析流程再继续写完成记录。</p><figure class=\"code-example\"><figcaption>已核对的调用关系 · 省略缓存命中与异常分支</figcaption><pre><code>MQ 消费回调\n  → AiService.asyncAnalyze\n      → VideoContextService.build\n          ├─ asrExecutor：FFmpeg 音频切段 → 逐段 ASR\n          └─ ocrExecutor：FFmpeg 抽帧 → 逐帧 OCR / 图片上传\n          → allOf(...).get(...) 等待两条分支\n      → agentLoopService.run\n      → 持久化结果\n  → 消费回调返回</code></pre></figure><p>这里的并行发生在两条分支之间，不意味着一个长视频的所有音频片段都并行处理。源码里的 ASR 片段和 OCR 帧各自有循环；视频变长，会增加分支占用时间。即使父线程只是等待，它也仍占着消费者的执行槽。因此消费并发、分支执行并发和外部 API 并发是不同约束，不能把三者相加当总容量。</p><p>还有一个很容易误读的配置：仓库定义了核心 4、最大 8 的 <code>aiTaskExecutor</code>，但本次检索到的显式 <code>@Async(\"aiTaskExecutor\")</code> 用在转写服务。不能仅凭这个 Bean 存在，就用“8 个 AI 线程”计算这条消息消费路径的吞吐。真正需要测的是这条路径的活跃消费者和它正在等待的资源。</p>"
    ],
    [
      "用相同单位把容量缺口算出来",
      "<p>先做一个有意简化的模型：每个任务独占一个执行槽 20 秒；有 c 个槽；任务之间不争 CPU、磁盘或第三方额度；没有失败重试。每槽每分钟能完成 60/20 = 3 个任务，因此理论服务能力为 <code>μ = 3c 个/分钟</code>。这里的 20 秒是槽位占用时间，不是 CPU 时间。</p><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">有效槽位 c</th><th scope=\"col\">理想完成能力 μ</th><th scope=\"col\">到达 40 个/分钟时的含义</th></tr></thead><tbody><tr><td>4</td><td>12 个/分钟</td><td>忙碌后平均每分钟净增加约 28 个未完成任务</td></tr><tr><td>8</td><td>24 个/分钟</td><td>仍有约 16 个/分钟的长期缺口</td></tr><tr><td>16</td><td>48 个/分钟</td><td>在固定耗时模型中有余量；不等于真实系统必然达标</td></tr></tbody></table></div><p>队列持续非空且资源稳定时，未完成任务的增长率近似是 <code>λ − μ</code>。这个差值先回答“能不能追上”，之后才讨论“等多久”。例如 4 槽积压约 280 个任务后，即使新流量立即停止，也还需要约 280/12 ≈ 23.3 分钟消化；若新流量仍为 40 个/分钟，积压根本不会自行消失。</p><p>再看单个任务的排队时间：若前面约有 Q 个同样耗时的任务，粗略要等 <code>Q/μ</code> 分钟。这是均匀任务下的近似。长短视频混合时，100 个一分钟视频和 100 个两小时视频的队列长度一样，剩余工作量却完全不同。所以我会同时记录任务数、待处理视频分钟数和最老任务年龄。</p><p>Little 定律 <code>L = λW</code> 适合讨论稳定系统里的平均在途数量、吞吐与停留时间。流量长期超过处理能力、队列不断增长时，不能拿一个任意时刻的队列长度反推出稳态平均等待，更不能说系统已经稳定。</p>"
    ],
    [
      "实际运行一次排队模拟，核对推算",
      "<p>脚本在 0 到 598.5 秒之间每 1.5 秒投递一个任务，共 400 个；每项固定处理 20 秒，先到先服务。它用最小堆保存各槽位的下一次空闲时间。每个任务的开始时间是到达时间与最早空闲时间的较大值，完成时间再加 20 秒。这段逻辑把排队的因果关系直接写了出来。</p><figure class=\"code-example\"><figcaption>复现脚本核心 · 已运行</figcaption><pre><code>available = [0.0] * workers\nfor i in range(400):\n    arrival = i * 1.5\n    start = max(arrival, heapq.heappop(available))\n    finish = start + 20\n    heapq.heappush(available, finish)</code></pre></figure><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">槽位</th><th scope=\"col\">第 600 秒已完成</th><th scope=\"col\">正在处理</th><th scope=\"col\">尚未开始</th><th scope=\"col\">400 项最终排队时间 P95</th></tr></thead><tbody><tr><td>4</td><td>117</td><td>4</td><td>279</td><td>1,316 秒</td></tr><tr><td>8</td><td>233</td><td>8</td><td>159</td><td>376 秒</td></tr><tr><td>16</td><td>387</td><td>13</td><td>0</td><td>0 秒</td></tr></tbody></table></div><p>每一行的完成、处理中和等待数量都相加为 400。P95 按全部 400 个任务最终得到的开始时间计算，采用最近秩定义，包含第 600 秒以后才开始的任务；不是只统计窗口内已完成的快任务。4 槽的最后一个任务在第 2,004.5 秒结束，8 槽为 1,010.5 秒，16 槽为 618.5 秒。</p><p>“每分钟增加约 28 项”与第 600 秒等待 279 项并不矛盾：前者是充分忙碌后的速率近似，后者有启动阶段、离散完成时刻，还把处理中和等待分开了。模拟说明翻倍后仍可能不够；16 槽的零排队则来自均匀到达和固定耗时的理想条件，不能拿来承诺线上 P95。</p>"
    ],
    [
      "把一个执行槽，拆成真正消耗的资源",
      "<p>真实视频处理无法无限保持 20 秒。多个 FFmpeg 进程会竞争 CPU 和磁盘，OCR 也需要算力；外部 ASR 或模型服务受配额约束。增加线程如果使单任务时间翻倍，吞吐可能没有增加。要判断扩容，需要把每个任务的需求折算成资源消耗。</p><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">约束</th><th scope=\"col\">同单位的容量估算</th><th scope=\"col\">要采集的证据</th></tr></thead><tbody><tr><td>CPU</td><td>可用核秒/秒 ÷ 每任务 CPU 秒</td><td>进程 CPU 时间、核占用、各阶段 CPU 需求</td></tr><tr><td>临时磁盘</td><td>可用吞吐字节/秒 ÷ 每任务读写字节</td><td>实际 I/O、磁盘等待、临时文件峰值</td></tr><tr><td>ASR 调用额度</td><td>允许调用/分钟 ÷ 平均调用/视频</td><td>分片数、成功/失败/重试调用、限流返回</td></tr><tr><td>并发额度</td><td>可用并发 ÷ 每次占用秒数</td><td>活跃请求、排队时间、耗时分布</td></tr></tbody></table></div><p>例如假设每个视频平均调用 ASR 10 次，服务只允许每分钟 300 次，那么即使本地有 16 个理想槽，ASR 这一路也只能支撑约 30 个视频/分钟。到达仍是 40，缺口至少为 10。这个例子只计算该额度的约束；如果还有并发上限、长音频时长额度或其他业务共享配额，实际可用容量还会更低。</p><p>一条分支先结束不会让整体任务提前完成。忽略排队时，上下文构建时间近似为两条分支耗时的较大值，再加后续 Agent 耗时；但资源需求仍要把两条分支都计入。两条分支若抢同一块 CPU 或磁盘，连这个独立并行假设也需要重新验证。</p>"
    ],
    [
      "积压可能被搬进了另一个队列",
      "<p>只有 MQ backlog 一个指标，会漏掉消费者内部的等待。消费者已经拉取消息，却在等线程池槽位、外部 API 或模型重试时，等待发生了位置变化。扩大内部队列能推迟拒绝，却不能提高处理速率；如果没有端到端任务时间，用户等待变长可能被“MQ 队列变短”掩盖。</p><p>我会为每个任务记录 accepted_at、consume_started_at、branch_submitted_at、branch_started_at、branch_finished_at 和 completed_at，再分别计算消息等待、线程池等待和执行时间。ASR 与 OCR 是并行时间段，不能把它们的墙钟耗时简单相加当端到端耗时。故障和取消任务也要记录终态，不能只在成功样本里算延迟。</p><p>源码中分支提交异常会被包装成分支失败；如果另一条分支仍有有效内容，流程可能继续。这意味着线程池拒绝不仅影响速度，还可能改变结果包含的模态信息。压测要同时观察分支失败率与结果完整性，否则“任务完成率没降”可能掩盖了 OCR 内容缺失。</p><p>重试又会制造额外需求。假设每次独立失败概率为 p、最多尝试三次，期望尝试次数是 <code>1 + p + p²</code>。但拥塞中的失败通常并不独立，不能靠这个公式预测线上；它只提醒我们区分业务任务到达率与实际尝试到达率。对配额耗尽立即重试，会让原本的容量缺口进一步扩大。</p>"
    ],
    [
      "根据证据选择改动，再验证瓶颈有没有转移",
      "<p>我会先固定一组视频时长与内容复杂度，逐步增加负载，测到第一个稳定出现的饱和信号。只改一类资源或策略，再观察完成速率、队列年龄、失败率和结果完整性。如果这些指标没有改善，就不能把更多线程当成扩容成功。</p><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">观测组合</th><th scope=\"col\">优先验证的假设</th><th scope=\"col\">一次可评估的改动</th></tr></thead><tbody><tr><td>CPU 长期忙，OCR/FFmpeg 执行时间随并发上升</td><td>计算竞争</td><td>减少单机并发或增加计算实例，对比单位核吞吐</td></tr><tr><td>CPU 有余量，外部 429 与等待增加</td><td>调用额度或请求节奏受限</td><td>按共享额度限流，减少重复调用，核对实际完成量</td></tr><tr><td>磁盘等待与临时文件占用同步增加</td><td>I/O 或空间压力</td><td>限制同时处理的视频、独立临时盘并测 I/O</td></tr><tr><td>各下游有余量，消费者长期占满</td><td>消费者槽位限制</td><td>小步增加有效消费并发，确认下游仍有余量</td></tr></tbody></table></div><p>为长视频增加独立队列，可以减少短任务被长任务阻塞，但不会减少总工作量；还需要公平调度，避免长任务永远得不到执行。任务切得更细可以缩短单次槽位占用，却会引入更多中间产物、调度和合并成本。这些都是可选择的改动，应该由等待分布和故障记录来决定是否值得。</p>"
    ],
    [
      "这次分析得到的结论，和还缺少的测量",
      "<p>这次已经确认了消费者等待分支与 Agent 的调用关系，并用可复现模型证明：容量低于到达率时，增加队列长度或不足幅度的线程扩容都无法消除积压。排队数字可以重新运行验证。仍然未知的是实际视频的资源需求分布、有效消费者并发，以及第三方服务给本项目的可用配额。</p><p>因此下一步最有价值的工作，是把一条真实任务的等待和执行拆开测，而不是继续猜哪个组件最慢。如果面试再问“流量十倍怎么办”，我会先说明任务构成和当前吞吐，再展示容量缺口，最后解释为什么选这项改动、准备观察什么反证。</p><p>复现入口：<a href=\"/notes/experiments/2026-10-22/reproduce.py\">Python 脚本</a>、<a href=\"/notes/experiments/2026-10-22/results.json\">原始 JSON 输出</a>、<a href=\"/notes/evidence/2026-10-22.md\">源码摘录与证据索引</a>。下载脚本后执行 <code>python3 reproduce.py &gt; results.json</code>；仅依赖标准库，不调用模型或外部服务。</p><p>任务可靠性的另一面，可继续阅读 <a href=\"#/article/async-pipeline\">从同步等待到异步流水线</a>。</p>"
    ]
  ]
},
{
  "id": "multi-user-agent-boundaries",
  "title": "把单用户 Agent 开放给 500 人，为什么加线程还不够？",
  "category": "Agent 开发",
  "tags": [
    "多用户",
    "权限隔离",
    "并发控制"
  ],
  "date": "2026.10.22",
  "icon": "agent",
  "desc": "从两个人使用同一个会话标识开始，沿请求、工具、持久化和事件回传设计归属边界，再用双连接实验复现丢失更新与过期写入。",
  "takeaway": "用户身份决定能访问什么，会话顺序决定基于哪个状态执行，资源配额决定谁能占用多少。三者都明确之后，多实例才有可扩展的基础。",
  "evidenceNote": "本篇包含入口源码复核与已运行的 SQLite 双连接反例。协议为设计建议，未完成真实服务的鉴权、沙箱或 500 用户负载验证。",
  "sections": [
    [
      "500 人之前，先让两个人同时使用",
      "<p>假设 Alice 和 Bob 都打开一个个人 Agent 改造出的 Web 页面。两人的前端都默认使用 <code>chat_id=default</code>，运行器共享历史目录和工作区。Alice 让它读取报告，Bob 让它整理文件。系统可能毫无性能问题，却已经无法保证谁读到了谁的数据。</p><p>这是多用户设计需要先回答的具体问题：一条请求凭什么进入某个会话，工具凭什么读取某个文件，完成事件又应该发给谁？面试里的“500 人同时用怎么办”很容易引出线程池和分布式队列，但在这些对象尚未绑定用户时，加进程只会复制现有的混用关系。</p><p>本次整理核对了 MyClaw 的 Gateway 入口和 Dispatcher，并运行了一个独立的 SQLite 双连接模型：先复现只按资源 ID 查询和旧快照覆盖的问题，再观察归属条件、版本条件和执行代次分别拦住什么。它是可运行的设计反例，不是已改造完毕的多租户服务。</p><p>复现入口：<a href=\"/notes/experiments/2026-10-22/reproduce.py\">Python 脚本</a>、<a href=\"/notes/experiments/2026-10-22/results.json\">原始 JSON 输出</a>、<a href=\"/notes/evidence/2026-10-22.md\">源码摘录与证据索引</a>。下载脚本后执行 <code>python3 reproduce.py &gt; results.json</code>；仅依赖标准库，不调用模型或外部服务。</p>"
    ],
    [
      "请求链的第一步，应该得到可信的主体",
      "<p>源码已经有 <code>SecuritySubject</code>、<code>resolve_gateway_subject()</code> 和 <code>require_subject_access()</code>。但是本次检查的 <code>gateway/server.py</code> 消息路由没有调用这些函数：入口从 payload 读取 chat_id、session_key，构造消息时 sender_id 是固定字符串。这个观察说明“有鉴权模块”不足以证明入口已经执行了身份与归属校验；它并未审计外部部署是否另有网关。</p><p>合理的服务端流程是：先从经过验证的凭据解析主体，再加载会话归属，校验主体是否有权限，最后创建任务。用户提交的 session_id 只负责定位资源。即使 ID 很长、难猜，也不能把“知道 ID”当成所有权；分享链接、日志或前端状态都可能让 ID 流出原来的界面。</p><figure class=\"code-example\"><figcaption>建议协议 · 身份来自服务端验证</figcaption><pre><code>credential → authenticated subject\n                     ↓\n(subject_id, session_id) → ownership / membership check\n                     ↓\nrequest_id + payload_hash → durable admission record\n                     ↓\nRunContext(subject_id, session_id, request_id, workspace_id)</code></pre></figure><p>这里按个人资源模型讨论：资源属于一个 subject。团队协作时，subject 是操作人，tenant 是组织，访问还要经过成员关系和角色校验；不能简单把 tenant_id 相同等同于所有操作都允许。身份一旦确定，应随请求上下文传递到存储、工具和事件系统，而不是后续从模型参数重新读取。</p>"
    ],
    [
      "归属条件要覆盖读、写和回传",
      "<p>示例数据库里，<code>s-A</code> 属于 Alice。脚本模拟 Bob 已经知道这个 ID，只按 ID 查询能读到记录；查询条件同时包含可信 owner 后，Bob 得到空结果，Alice 仍能读到自己的记录。这个实验真正验证的是 SQL 谓词的效果，Bob/Alice 是测试端指定的可信主体，并没有验证登录或令牌系统。</p><figure class=\"code-example\"><figcaption>已运行的查询差异</figcaption><pre><code>-- 只定位资源：Bob 知道 ID 就能取到记录\nSELECT id FROM sessions WHERE id = :session_id;\n\n-- 同时约束资源归属：owner 来自已认证上下文\nSELECT id FROM sessions\nWHERE id = :session_id AND owner = :subject_id;</code></pre></figure><p>如果只在 POST 消息时校验，GET 历史、进度订阅、取消、重试、附件下载仍可能绕过同一边界。更稳妥的接口设计让存储层的方法显式需要 subject，避免调用方随手执行一个全局 get(session_id)。共享资源则通过明确的授权关系查询。</p><p>事件回传也要走相同规则：浏览器提供 session_id 订阅 SSE，不代表它有权订阅。建立连接时要校验，回放持久事件时也要按授权资源范围读取；权限撤销后的长连接如何终止，应有明确策略。为了排障而开放的日志、工具输出和下载路径，同样属于用户数据访问面。</p>"
    ],
    [
      "同会话为什么要有顺序，不同会话为什么可以并行",
      "<p>假设用户连续发出“创建计划”和“把刚才计划的第二项改到明天”。第二条依赖第一条产生的状态。若两条同时从同一历史快照启动，它们各自读到的上下文可能都没有新计划；最终即使两条回答都写入历史，业务含义也已偏离用户意图。</p><p>因此默认策略可以是同会话按接受顺序执行，不同会话并行。执行前先记录服务端顺序号，重试仍关联原请求。只加一把锁能减少并发写，却不能自动保证从多个入口来的业务顺序；需要把顺序定义在接收与调度协议里。对于互不依赖的只读子任务，可以在一次任务内部另行并行，最后统一汇总。</p><p>MyClaw 的 Dispatcher 在执行前获取会话锁，再获取全局执行槽。这种顺序避免了同一个繁忙会话的等待者先占满全局槽、阻塞其他会话。不过锁和信号量位于当前进程内，能保护这一个 Dispatcher 的参与者，不能协调另一个进程对同一历史文件的读写。</p><p>仅靠单会话串行还不能防止一个人创建大量会话。因此要分别限制每会话等待长度、每主体活跃任务数，以及全局执行数；调度时可按主体轮转，防止先来的一名用户一次排入几百个任务。具体限额是容量决策，不应由“500 人”这个数字直接拍定。</p>"
    ],
    [
      "双连接实验：数据库有事务，仍然会丢掉一次更新",
      "<p>我用两个独立 SQLite 连接，强制安排下面的顺序，避免依赖随机线程时序。两个连接都先读到 value=0，分别计算加一，再提交写入。每次 SQL 写入都成功，最终值却是 1。数据库保证单条写入的原子性，不等于保证应用层从读取到计算再写入的整个业务动作没有冲突。</p><figure class=\"code-example\"><figcaption>已运行的反例时序</figcaption><pre><code>A 读取 value=0\nB 读取 value=0\nA 写入 value=1，提交\nB 写入 value=1，提交\n最终 value=1；业务预期是 2</code></pre></figure><p>改成带 version 的条件写入：A、B 同时读到 version=0，A 成功写入并把版本加一，B 的旧版本条件不再匹配，影响行数为 0。B 必须重读 value=1、version=1，重新计算，再提交。结果如下，完整 SQL 在复现脚本中。</p><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">步骤</th><th scope=\"col\">影响行数</th><th scope=\"col\">含义</th></tr></thead><tbody><tr><td>A 根据 version=0 写入</td><td>1</td><td>成功推进状态</td></tr><tr><td>B 根据 version=0 写入</td><td>0</td><td>旧快照被识别，没有覆盖新值</td></tr><tr><td>B 重读并根据 version=1 写入</td><td>1</td><td>重新计算后完成第二次加一</td></tr><tr><td>最终 value</td><td>2</td><td>两次更新都保留</td></tr></tbody></table></div><p>这个整数例子可以安全重算，Agent 任务却未必可以。模型已经发出的邮件或执行的 Shell 命令不能因为版本冲突就重新运行。因此版本检查适合保护状态提交，但若要求同会话语义有序，通常还要在产生副作用之前确保执行归属。冲突处理必须区分纯计算、可幂等操作和结果未知的外部动作。</p>"
    ],
    [
      "工具权限必须比提示词更硬",
      "<p>即使历史表已经按用户分开，工具仍可能读取共享目录或调用共享凭据。把“只读 Alice 的目录”写进系统提示，不能替代执行端检查。模型提交的路径和资源 ID 是待验证的参数，工具应根据可信 RunContext 决定可访问范围。</p><p>对于文件读取，可以让模型提交 artifact_id，由服务端映射到已授权对象；对于 Shell，单独设置 cwd 并不能阻止绝对路径、上级目录、符号链接或其他系统资源访问。若允许执行任意代码，需要由实际的操作系统权限、容器或沙箱落实文件系统、网络、进程和凭据范围。本文没有运行沙箱逃逸或跨用户集成测试。</p><p>工具实例也要注意可变状态。如果共享单例在请求开始时把 current_user 改成 Alice，随后另一个请求改成 Bob，等待 I/O 之后第一个请求可能使用错误身份。更明确的设计是每次 execute 显式接受不可变上下文；后台任务也从持久任务记录恢复该上下文，而不是依赖“最近处理的是谁”。</p>"
    ],
    [
      "扩到多实例后，要防止旧执行者回来写结果",
      "<p>多实例首先带来任务领取问题：两台 worker 不能仅仅各自 SELECT 一条 pending 再开始执行。领取必须由数据库条件更新或等效原子机制完成，记录 owner、租约到期时间和递增的执行代次 epoch。实例重启时也不能把所有 running 一律标为失败，因为其中可能有别的实例仍在运行。</p><p>租约过期允许新 worker 接手，却不保证旧 worker 已经停止。旧进程可能只是暂停，之后恢复。脚本把任务当前 epoch 设为 2，再让旧执行者按 epoch=1 提交，条件更新影响 0 行；当前执行者按 epoch=2 提交则影响 1 行。这个结果验证了提交端的拒绝条件，没有模拟自动续租、时钟漂移或真实网络分区。</p><figure class=\"code-example\"><figcaption>已运行的提交条件 · 简化模型</figcaption><pre><code>UPDATE jobs SET result = :result\nWHERE id = :job_id AND epoch = :claimed_epoch;\n-- rowcount == 0：已失去执行权，不能宣布提交成功</code></pre></figure><p>实际设计还应约束任务状态、当前 owner，必要时在续租与提交事务里检查租约是否仍有效。epoch 能挡住受控数据库的迟到提交，不能撤销旧 worker 已经对外产生的副作用；外部动作仍需要稳定 operation_id 与执行端幂等或核验协议。</p><p>事件系统也有相似的问题：内存里的 SSE 订阅列表只对所在实例有效。可以用持久事件序号支持断线回放，再用跨实例通知唤醒读取；通知丢失时仍能从持久游标补读。这里优先保证事件归属和可恢复性，再选择具体消息组件。</p>"
    ],
    [
      "500 个用户，需要先换算成多少活跃工作",
      "<p>假设 500 人平均每人每 5 分钟提交一项任务，到达率是 100 项/分钟；每项平均占用执行资源 30 秒，那么稳定条件下平均需要占用约这么多执行槽： <code>100 × 0.5 = 50</code>。这是为了讲清计算而设置的假设，不是项目测量。平均值也不足以满足突发和尾延迟目标，还要看同时提交、长任务和外部调用配额。</p><p>资源限制不只是一条全局信号量。每主体并发限制能减少互相挤占；任务排队期限限制无意义等待；模型 token 和调用预算约束成本；工具执行与上传大小限制保护计算和存储。多实例时如果每台都独立允许同一用户 2 个任务，四台就可能放行 8 个，需要共享配额或确定的分区调度。</p><p>用户持续提交超过可用预算时，应明确返回拒绝或排队状态，而不是无限接收再让任务悄悄超时。请求幂等也应按主体隔离：同一主体的 request_id 重试复用接受记录；同一键但 payload 不同要报告冲突，其他主体使用相同字符串不能串到这条任务。</p>"
    ],
    [
      "我会怎样分阶段交付这次改造",
      "<p>第一阶段仍用单实例，把身份、归属、工具边界和用户配额贯通；验收要让 Bob 主动尝试读取、取消、订阅和下载 Alice 的资源，同时确保 Alice 的正常路径能用。第二阶段建立会话顺序、持久请求和结果恢复，验证重复提交、取消和断线。只有单实例的协议明确后，第三阶段才引入多 worker 的领取、租约、版本提交和事件回放。</p><p>这次工作已经提供三类可复核证据：入口是否实际调用身份校验的源码路径；双连接丢失更新与版本冲突的 SQL 结果；旧 epoch 提交被拒绝的结果。尚未提供真实鉴权链路、工具沙箱或 500 用户压测证据。因此这里交付的是有反例支撑的设计分析，而不是“增加线程后已支持多租户”的完成声明。</p><p>复现入口：<a href=\"/notes/experiments/2026-10-22/reproduce.py\">Python 脚本</a>、<a href=\"/notes/experiments/2026-10-22/results.json\">原始 JSON 输出</a>、<a href=\"/notes/evidence/2026-10-22.md\">源码摘录与证据索引</a>。下载脚本后执行 <code>python3 reproduce.py &gt; results.json</code>；仅依赖标准库，不调用模型或外部服务。</p><p>外部动作的恢复边界，见 <a href=\"#/article/agent-unknown-outcome\">工具执行成功了，但 Agent 没收到结果，重试安全吗？</a>。</p>"
    ]
  ]
},
{
  "id": "hybrid-search-evaluation",
  "title": "加了混合检索和重排，怎么证明搜索真的更好了？",
  "category": "Agent 开发",
  "tags": [
    "混合检索",
    "RRF",
    "检索评测"
  ],
  "date": "2026.10.22",
  "icon": "blocks",
  "desc": "从一条精确错误码查询出发，算出 RRF 如何改变排名，再用公开的固定排名反例区分候选覆盖、排序收益与最终回答质量。",
  "takeaway": "融合能改变候选顺序，重排只能处理送到它面前的候选。要证明收益，需要固定输入做配对比较，并把召回、排序、回答质量和开销分别归因。",
  "evidenceNote": "本篇运行了手工排名的 RRF 与评分演示。未运行真实向量检索、学习型重排器或模型回答；按标答排序仅用于展示候选集的理论上界。",
  "sections": [
    [
      "组件变多了，证据在哪里",
      "<p>“用了关键词检索、向量检索，再通过 RRF 融合和重排提高相关性。”这句话能描述系统组成，却还没有回答面试中的追问：哪些问题原来找不到，现在找到了？哪些原本正确的结果被排低了？付出了多少延迟？</p><p>这次写作先做了一个很小但能检查的工作：构造四组固定候选排名，运行 RRF 和评分脚本，公开每组输入、融合分数和输出。它不调用 embedding，也不调用真实重排模型；目的不是给某个检索方案打榜，而是把“应该更好”拆成可以证伪的几个判断。</p><p>其中最有用的反例是：一个精确错误码查询，在关键词列表里第一名就是正确文档，融合之后却变成第二名。理解这个变化，才能知道后面为什么需要分层评测。</p><p>复现入口：<a href=\"/notes/experiments/2026-10-22/reproduce.py\">Python 脚本</a>、<a href=\"/notes/experiments/2026-10-22/results.json\">原始 JSON 输出</a>、<a href=\"/notes/evidence/2026-10-22.md\">源码摘录与证据索引</a>。下载脚本后执行 <code>python3 reproduce.py &gt; results.json</code>；仅依赖标准库，不调用模型或外部服务。</p>"
    ],
    [
      "用一个查询说明两路检索各自可能错在哪里",
      "<p>查询是“E1042 错误码如何处理”。假设 A 是准确说明 E1042 的文档，B、C 是语义相近但不适用的故障说明。关键词候选按 A、B、C 排列，向量候选按 B、C、A 排列。这里的列表是为了分析而手工设定的，不是项目搜索引擎的输出。</p><p>精确标识符、专有名词与普通语义描述，需要的匹配信号不同。关键词方案能否区分 E1042 和 E1043，取决于分词与字段设计；向量方案能否理解“关掉页面后还在跑”和“后台任务生命周期”，取决于模型和材料。两路具有互补潜力，但互补是否发生，需要在实际查询上观察，不能从组件名称推导。</p><p>我把用于分析的四类输入列在下面。每题只设一个相关文档，便于手算；真实查询可能有多个相关片段，也可能需要跨片段组合证据。第四题的相关文档 J 不在任一路候选中，用来暴露后续排序的能力边界。</p><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">查询类型</th><th scope=\"col\">相关文档</th><th scope=\"col\">关键词排名（人工设定）</th><th scope=\"col\">向量排名（人工设定）</th></tr></thead><tbody><tr><td>精确错误码</td><td>A</td><td>A, B, C</td><td>B, C, A</td></tr><tr><td>同义表达</td><td>D</td><td>E, F, D</td><td>D, E, F</td></tr><tr><td>带限定条件</td><td>G</td><td>H, I, G</td><td>I, H, G</td></tr><tr><td>候选遗漏</td><td>J</td><td>K, L, M</td><td>L, M, K</td></tr></tbody></table></div>"
    ],
    [
      "RRF 不比较原始分数，它会奖励什么",
      "<p>关键词分数和向量相似度不一定处于同一尺度，直接相加需要校准。RRF 采用排名：对每个文档 d，把它在各路出现时的 <code>1/(c + rank)</code> 相加，没出现的那一路贡献 0。本文取 c=60，rank 从 1 开始；候选按文档 ID 去重。公式与排名约定见 <a href=\"https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion\" target=\"_blank\" rel=\"noopener noreferrer\">Elasticsearch 的 RRF 文档</a>。</p><figure class=\"code-example\"><figcaption>第一题的可复算分数</figcaption><pre><code>A = 1/(60+1) + 1/(60+3) = 0.03226646\nB = 1/(60+2) + 1/(60+1) = 0.03252247\nC = 1/(60+3) + 1/(60+2) = 0.03200205\n\n融合结果：B, A, C\n已知相关文档 A：从关键词第 1 名变成融合第 2 名</code></pre></figure><p>B 在两路都比较靠前，于是获得了更高的融合分。RRF 并不知道 A 才是正确答案，它只看到名次。这不是算法实现错误，而是排名信号与本题相关性不一致。融合可以改善某些任务，也会损坏另外一些；“用了两路信息”不蕴含“每一题都优于最好的那一路”。</p><p>c 控制各名次倒数贡献的差异，c 越大，靠前名次之间的相对差距越小。候选窗口也会影响某文档是否获得另一路贡献。因此 c、每路候选数、最终保留数以及同分规则都应记录。本文同分按文档 ID 排序，只为确定性复现，不主张这就是业务上的最佳规则。</p>"
    ],
    [
      "重排的上限，先由候选集合决定",
      "<p>常见的两阶段方式先用便宜的检索器产生候选，再让 Cross-Encoder 等模型联合读取 query 与文档，对候选重新评分。它可以使用比单独编码相似度更细的匹配信号，但计算只发生在候选里。这个结构可参考 <a href=\"https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html\" target=\"_blank\" rel=\"noopener noreferrer\">Sentence Transformers 的 Retrieve &amp; Re-Rank 文档</a>。</p><p>第四题的 J 不在候选里，任何只做重排的模型都无法把它排到第一。若把 J 从标答中偷偷补进候选，再报告重排成功，就改变了要验证的问题：测到的是“正确文档已给出时能否排序”，而不是原检索链路能否找出正确文档。</p><p>为了把这个上界显示出来，脚本另外计算 oracle 排序：明确读取标答，把已有候选中的相关项放到最前。它是“完美排序器会怎样”的诊断对照，<strong>不是实际重排模型，不能作为模型收益报告</strong>。脚本还断言重排前后候选集合相同，避免补入缺失的相关文档。</p><p>如果融合后只留下 top 1 再送重排，本例四题都没有相关文档可用；保留 top 3 时，前三题还保留正确候选。截断位置因而决定了后续还有多少修复空间。增大候选数可能提高覆盖，同时增加重排成本；这才是需要测量的取舍。</p>"
    ],
    [
      "实际输出：总体数字必须能还原到每一题",
      "<p>脚本使用 Recall@3 衡量三个候选里找回了多少相关文档；MRR@3 是每题前三名中第一个相关结果名次倒数的均值，找不到记 0；Hit@1 是第一名相关的题目比例。本例每题仅有一个相关文档，因此 Recall@3 也等于前三名命中的题目比例。</p><div class=\"table-scroll\"><table><thead><tr><th scope=\"col\">方法</th><th scope=\"col\">Recall@3</th><th scope=\"col\">MRR@3</th><th scope=\"col\">Hit@1</th></tr></thead><tbody><tr><td>关键词固定排名</td><td>0.7500</td><td>0.4167</td><td>0.2500</td></tr><tr><td>向量固定排名</td><td>0.7500</td><td>0.4167</td><td>0.2500</td></tr><tr><td>RRF，c=60</td><td>0.7500</td><td>0.3333</td><td>0.0000</td></tr><tr><td>按标答重排已有候选（oracle）</td><td>0.7500</td><td>0.7500</td><td>0.7500</td></tr></tbody></table></div><p>以关键词列表为例，四题的倒数排名是 1、1/3、1/3、0，均值为 5/12≈0.4167；RRF 后变成 1/2、1/2、1/3、0，均值为 1/3。候选覆盖完全相同，排序质量却改变了。只报告 Recall@3，会把这次退化藏起来。</p><p>oracle 达到 0.75，说明在这组候选里排序仍有改进空间；第四题仍然是 0，说明这部分需要回到召回阶段。四组输入是专门挑选的反例，不能据此说 RRF 在真实任务里通常更差，更不能把 oracle 的 0.75 写成“重排提升 125%”。这次实际验证的是计算和边界，没有验证任何生产分布上的收益。</p>"
    ],
    [
      "把演示变成真实实验，需要固定哪些东西",
      "<p>真正验证项目时，我会保留四个可运行方案：关键词、向量、RRF、RRF 加真实重排器。它们使用同一份带版本的文档语料、相同切分、权限范围和查询集合。冻结分词配置、embedding 模型、索引参数、候选窗口、重排模型和截断长度，否则结果变化无法归因到某个阶段。</p><p>候选覆盖先在融合前的并集和融合截断后分别计算；排序阶段再比较保留候选中的名次。纯关键词和纯向量可各取 N，融合取两路各 N，额外开销要记录。若要比较“同样成本谁更好”，还要另做预算匹配，不能把用了更多候选的方案包装成免费提升。</p><p>相关性标注至少区分精确回答、部分有用和无关，并保存支持判定的材料。对于“项目甲、离线运行”的查询，来自项目乙的相似文档、需要联网的方案都应成为难负例。对权限或结构化业务条件，能在检索前准确过滤的就先过滤；语义排序不能替代访问控制。</p><p>开发查询用于调 c、窗口和模型，保留查询用于最后验收；同一问题的近义改写应放在同一个划分里，避免模板泄漏。多相关文档且分等级时可补充 nDCG@k，但必须公开等级含义和未标注文档的处理方式。新方案返回了旧池子没见过的文档，也要补审，不能默认未标注等于不相关。</p>"
    ],
    [
      "检索变好，为什么最终回答仍可能变差",
      "<p>检索返回的相关片段可能在组装上下文时被截断，重复片段可能挤掉其他必要证据；即使证据进入模型，生成仍可能忽略限定条件。因此终点不是“相关文档进了 top k”，还需要检查模型实际看到了什么，以及回答是否满足任务要求。</p><p>我会把失败定位到最早偏离的一步：相关文档没有进入任一路候选，是召回问题；进入并集却被融合窗口丢掉，是融合与截断问题；留在候选但排不到前面，是排序问题；排序正确但上下文缺失，是组装问题；证据可见仍答错，才进入生成或评分契约排查。这个顺序决定下一次改动该发生在哪里。</p><p>评估回答质量时，固定生成模型、提示词和上下文预算，记录答案准确性、引用支持度与约束满足情况。对于需要多份证据的问题，只命中第一份材料会让 MRR 很好看，但回答仍不完整；还应检查必要证据是否全部进入上下文。不要用一个检索指标替代端到端验收。</p>"
    ],
    [
      "延迟与成本要参与同一轮决策",
      "<p>两路并行检索时，检索阶段墙钟时间近似为两路中的较慢者，加上融合开销；若实际串行则需要相加。重排再增加候选对的推理耗时，它受候选数、文本长度和批处理影响，不能拿单条文档延迟直接乘出来当线上 P95。</p><p>每条查询应记录检索、融合、重排、上下文组装与整体时间，同时记录索引构建和增量更新成本、模型调用量、超时与降级。超时查询仍留在分母中，冷缓存和热缓存分开报告。本文脚本没有真实服务调用，其运行时间没有检索性能意义，因此没有发布延迟收益数字。</p><p>判断上线时先约定可接受的质量退化、P95 延迟上限和每查询成本，再看逐题配对结果。某些查询从错变对、另一些从对变错，即使总分相等也可能影响业务。样本足够时可按查询或查询家族做配对重采样；样本很小时，应直接展示失败与不确定性，避免拿小数点后的精度制造确定感。</p>"
    ],
    [
      "这次工作可以支持什么判断",
      "<p>现在可以复核的工作包括四组完整排名、RRF 数值、候选集不变断言和逐题评分。它们证明了融合可能损坏某题原有排序、截断可能提前丢掉可用证据，以及重排无法补回候选之外的文档。它们没有证明某个 embedding 或重排模型在我的项目里有效。</p><p>接下来真正需要补的是固定语料上的真实四组检索输出、人工相关性判定和端到端成本。等这些证据齐全，文章里的结论才能从“这个机制为什么可能有效”推进到“它改善了哪些查询、损坏了哪些查询、是否值得付出代价”。</p><p>复现入口：<a href=\"/notes/experiments/2026-10-22/reproduce.py\">Python 脚本</a>、<a href=\"/notes/experiments/2026-10-22/results.json\">原始 JSON 输出</a>、<a href=\"/notes/evidence/2026-10-22.md\">源码摘录与证据索引</a>。下载脚本后执行 <code>python3 reproduce.py &gt; results.json</code>；仅依赖标准库，不调用模型或外部服务。</p><p>关于标答隔离和评分契约，可继续阅读 <a href=\"#/article/ai-eval-evidence\">AI 生成了测试集，实验结果就可信吗？</a>。</p>"
    ]
  ]
},
{
id:'agent-unknown-outcome',
title:'工具执行成功了，但 Agent 没收到结果，重试安全吗？',
category:'Agent 开发',tags:['Agent Harness','幂等','异常恢复'],date:'2026.10.21',icon:'flow',
desc:'从一次结果丢失的工具调用出发，设计操作身份、状态记录和恢复决策，解释 Agent 为什么不能在中断后直接重来。',
takeaway:'Checkpoint 帮助恢复执行进度；安全重试还需要稳定的操作身份，以及执行端提供的去重或核验能力。无法确认结果时，unknown 是需要保留的信息。',
sections:[
['一条没有收到结果的追加记录',`<p>假设我们让 Agent 向文件末尾追加一条记录。写入已经完成，进程却在保存工具结果之前退出了。重启后，历史里有工具调用，没有对应结果。再执行一次，文件里可能多出一条重复记录；直接跳过，又可能漏掉一次其实没有发生的写入。</p><p>做个人 Agent 时，“保存现场，中断后继续”听起来很自然。这个例子却让我意识到，恢复之前还有一个更基本的问题：<strong>系统究竟知道什么，又不知道什么？</strong>没有收到结果，只能说明调用链没有完整结束，不能直接说明外部操作没有发生。</p><p>下面用这类故障推演一套恢复设计。MyClaw 的 checkpoint 与操作账本是思考起点，文中的协议和伪代码是设计示意，不代表项目已实现所有能力，也不把假设场景写成真实生产事故。</p>`],
['先把中断点放到执行链上',`<p>只看正常流程，工具调用像一个函数：输入参数，返回结果。把进程退出放进去，它就变成几个可能分别完成的动作：</p>${code('执行时序',`记录本次操作的意图
        ↓
向工具或外部服务发出请求
        ↓
外部副作用已经发生
        ↓  ← 此时中断，本地仍可能没有完成记录
收到并持久化执行结果
        ↓
把结果交给模型，继续任务`)}<p>checkpoint 可以保存任务目标、已生成的消息、待完成的工具调用，让运行器重建执行进度。但本地记录和外部操作通常不属于同一个事务：外部服务可能已经处理请求，而本地完成事件还没写下。</p><p>因此，“工具前记一次、工具后记一次”可以缩小核查范围，却不能消除中间的空隙。恢复时应当分开看三件事：模型上下文里有什么，运行器记录了什么，外部世界实际发生了什么。</p>`],
['操作 ID 要跟着业务意图走',`<p>要避免重复执行，首先得知道什么算重复。工具名和参数完全相同，不一定代表同一个操作：用户今天要求创建一条“学习数据库”的任务，明天再创建一条，两次都可能是合法需求。</p><p>一个更明确的约定是：接受一次业务意图时分配 <code>operation_id</code>，保存它与参数摘要的绑定；同一次操作恢复重试时沿用它，新的操作才分配新 ID。UUID 可以用来生成 ID，但重试时重新生成 UUID，就丢掉了关联。</p>${table(['场景','应该怎样使用身份'],[['同一次请求因为超时而重试','沿用原 operation_id 和原参数绑定'],['用户明确要求再做一次','建立新的 operation_id'],['同一 ID 却带来不同参数','报告冲突，不静默当成同一个请求'],['模型重新提出了相似的工具调用','结合任务状态判断意图，不能只看参数相似']])}<p>还要区分工具调用 ID 与业务操作 ID。前者连接一次模型调用和工具返回，后者描述需要保证一致的业务效果。两者可以关联，但“模型新生成一个调用 ID”不应自动成为安全重做外部动作的依据。</p><p>执行端也必须参与。仅在 Agent 本地保存 ID，外部服务并不知道这个 ID 的含义，仍可能执行两次。对于自己控制的接口，可以让同一 ID 返回已保存的结果；如果记录操作与业务变更都在同一数据库里，围绕同一个事务设计。若还要调用第三方，则需要继续处理下一层的中断窗口。</p>`],
['状态机里为什么要有 unknown',`<p>设计操作账本时，我会至少区分：已登记但尚未开始、执行中、已确认成功、已确认失败，以及结果未知。<code>unknown</code> 不是“失败”的另一个名字，它表示现有证据不足以做出确定判断。</p><p>例如，收到明确的参数校验错误，并且执行端保证尚未产生副作用，通常可以确认失败；请求超时却可能发生在任意阶段。进程重启后发现账本停在执行中，也不应该只因为本地没有成功记录，就宣布外部操作失败。</p>${code('Python 伪代码 · 恢复决策',`record = ledger.load(operation_id)

if record.has_durable_result:
    return record.saved_result

if tool.can_query_operation:
    evidence = tool.query_operation(operation_id)
    if evidence.confirms_success:
        return save_verified_result(evidence)
    if evidence.proves_safe_to_retry:
        return retry_with_same_id(operation_id)

if tool.supports_idempotency_key:
    return retry_with_same_id(operation_id)

return needs_reconciliation(operation_id, state="unknown")`)}<p>这段伪代码依赖明确前提：服务端的幂等协议仍在有效保留期内；查询返回的证据足以覆盖执行中的请求；“可以重试”不是简单的“暂时没查到”。如果无法满足前提，就进入核查流程，而不是偷偷换一个 ID 再试。</p><p>成功状态与完整结果也要分开保存。只有一个 <code>succeeded</code> 标记，无法还原之前返回的资源 ID 或文件内容。结果保存在外部时，还需保证引用在恢复期间可访问；恢复说明不能伪装成原始工具输出。</p>`],
['让模型去看一眼，为什么仍可能无法确认',`<p>一个自然的办法是：把 unknown 告诉模型，让它读取外部状态；已经完成就继续，没完成就重试。这个办法有用，但核验能力取决于具体工具。</p><p>假设某次调用要求计数器加一。恢复时看到数值从 10 变成 11，可能是本次调用成功，也可能是本次没有执行、另一个并发请求加了一次。两个不同的执行历史留下了同一个当前状态。</p><p>反过来，当前查不到结果，也不一定说明原来的请求永远不会完成。它可能还在运行，或者查询结果存在延迟。此时再发一次请求，仍可能产生两次副作用。</p>${table(['核验方式','能够说明什么','关键边界'],[['读取目标文件并比较预期内容','当前目标状态是否满足要求','还要考虑并发修改，以及任务是否只关心最终状态'],['按 operation_id 查询执行记录','某一次操作是否被记录为完成','依赖记录持久性、查询语义和保留期'],['只看计数器、余额等聚合值','当前值是多少','通常无法把变化归因到某一次操作']])}<p>模型可以选择核验工具、解释证据，却不能凭推理补出系统没有记录的执行历史。对于证据不足的操作，暂停自动重试、保留 unknown 并交给进一步核查，是恢复协议的一部分。</p>`],
['不同工具，需要不同的重试条件',`<p>查询、覆盖写、追加写和发送通知的副作用不同，不能统一套一个“失败重试三次”。只读查询可以重新获取，但新结果未必等于中断时的旧结果；写入固定目标内容可能满足最终状态要求，但并发覆盖仍需要版本条件；追加记录和发送消息则更需要稳定身份与执行端去重。</p><p>外部服务的幂等键如果只保留一段时间，恢复期限也不能无限延长。账本清理同样属于协议：不能先删除去重记录，再允许旧请求回来重试。对于无法查询、也不支持幂等的不可逆动作，应明确停止自动恢复的条件。</p><p>在 MyClaw 这样的个人 Agent 中，我会先选择少数工具把恢复闭环做好，而不是宣称所有 Shell 命令都已经安全。每个工具都应该能回答：完成证据是什么，重复调用的后果是什么，谁负责核验，以及多久之后原来的保证不再成立。</p>`],
['用故障注入验证恢复，而不是只测正常返回',`<p>最小实验可以围绕一个可计数的本地副作用展开。测试侧保留独立的真实执行记录，用于判定结果；恢复逻辑只能看到正式协议允许的证据，不能偷看测试答案。</p>${table(['故障场景','验收重点'],[['副作用发生前中断','能够在证据充分时补做，最终效果正确'],['副作用发生后、结果保存前中断','没有重复副作用；无法确认时保留 unknown'],['结果保存后、模型接收前中断','复用已有结果，避免再次执行'],['其他请求造成相同的外部状态','不会把别人的效果当成本次操作成功'],['查询暂时没有结果，原请求仍在执行','不会因为暂时查不到就盲目重做']])}<p>这张表是验证方案，没有冒充已经跑过的结果。真正验收时，要同时检查有没有重复副作用、有没有漏执行，以及有没有在证据不足时误报成功。只统计“最后有没有给用户回复”，会漏掉恢复里最关键的错误。</p><p>回到开头的问题：工具结果丢失后，重试是否安全，取决于操作身份、执行端协议和可用证据。checkpoint 让系统找回进度，恢复协议决定它接下来敢做什么。把这两件事分开，才能逐个工具建立可信的恢复能力。</p>`],
['参考与设计边界',`<p>本文以 MyClaw 的 checkpoint、操作账本和恢复说明为实现参考，但采用面向问题的设计推演。当前源码中的“重复操作拒绝”不等同于文中提出的“执行端幂等重试并复用结果”，两者不能混为已实现能力。</p>${reference('/notes/evidence/2026-10-21.md','文章材料与证据索引','记录所参考的源码版本、关键片段及历史材料。文中的恢复协议与故障实验均已按设计建议标注。')}<p>继续阅读本站 <a href="#/article/checkpoint">Checkpoint 与事件回放</a>，可以进一步了解事件记录和快照如何配合。</p>`]
]},
{
id:'ai-eval-evidence',
title:'AI 生成了测试集，实验结果就可信吗？',
category:'学习笔记',tags:['Agent Eval','数据隔离','实验复核'],date:'2026.10.21',icon:'blocks',
desc:'从一条尾部检索样例到一次标答泄漏复核，重新理解“成功率相同、输入减少 63.1%”究竟能证明什么。',
takeaway:'自动生成样本可以减少准备工作，但实验结论仍取决于样本覆盖、评分契约、模型实际可见的信息，以及完整的成本口径。',
sections:[
['一个很好记的数字，还不是一个完整结论',`<p>在工具上下文实验里，我关心一个具体问题：工具返回很长的内容时，先保存全文、给模型短预览，再让它按需搜索和读取，能不能降低累计输入，同时保留完成任务的能力？</p><p>后续一轮报告给出了很容易复述的结果：全文组和落盘组严格成功数都是 46/60，落盘组累计输入 token 少了 63.1%。但真正让我重新审视实验的，是两个追问：测试题具体长什么样？模型答题时有没有机会看到标准答案？</p><p>本文复核已有的冻结数据集和历史报告，不报告新一轮模型实验。尤其要先交代：<strong>那轮两组比较后来确认存在标答可见性污染，不能把上述数字写成“质量不降”的独立证据。</strong>这次经历让我更重视从样例、轨迹和评分规则理解一个结果。</p>`],
['先拿一道题，走完输入到评分的过程',`<p>冻结数据集中的 <code>case-21</code> 是一条尾部检索题。用户要求找到 <code>rec-21-A</code> 对应的精确值，并引用来源行号。材料有约 4 万个 Python 字符，目标记录位于展示文本第 604 行，落在 2,000 字符的头部预览之外。</p>${code('任务与材料 · 节选',`任务：查找 rec-21-A 的值，并引用 source-01 的证据行。

source-01 第 604 行：
RECORD record=rec-21-A value=v-21-A

需要交付：
answers.rec-21-A = "v-21-A"
citations.rec-21-A = [{
  "source_id": "source-01",
  "start_line": 604,
  "end_line": 604
}]`)}<p>对全文方案，证据一开始就进入上下文。对落盘方案，模型先看到预览，发现目标尚未出现，再通过搜索定位并读取所需片段。这里描述的是任务要求与合理的取证路径，不是在重新播放该案例的一次实际模型轨迹。</p><p>这道题可以检查“证据在预览之外时，模型是否能补充获取并引用”。但它不能代表所有真实任务：目标键已经明确，适合精确搜索；真实排障可能连应该搜索什么都不知道，也可能需要读完整份材料才能判断没有遗漏。</p><p>评分也不只是答案值对不对。该实验还检查引用、必要证据可见性、正常结束，以及特定案例要求的文件读取。没有先说明这些条件，一个“失败”就可能被误读成模型根本没有找到答案。</p>`],
['60 道题覆盖了什么，又没有覆盖什么',`<p>冻结 v1 一共 60 个案例，其中 16 个来自原回归集，44 个为新增案例。按内容分成三组：</p>${table(['类型','数量','主要用途'],[['受控材料','24','控制证据位置、干扰内容和多来源关系'],['项目材料','24','检查代码片段、diff、测试输出等材料上的行为'],['短结果与边界对照','12','检查不该触发落盘的情况，以及字符长度和 Unicode 边界']])}<p>这些样本各有用途。受控题帮助定位机制问题，项目题让材料更接近开发工作，边界题防止策略误处理短结果。它们仍然是为一个工程问题构造的样本，不是生产任务的随机抽样。</p><p>因此，不能只让 AI “生成更多同类题”，就把样本量扩大等同于覆盖更充分。如果只是换记录名和填充文本，模型面对的可能仍是同一种解题结构。应增加真正会改变策略取舍的任务，例如必须全量核查、证据相互冲突、预览已经足够，以及检索无法命中明确关键词。</p><p>我会让 AI 帮助生成候选材料，但逐类检查题目在验证哪一个假设，并保留一部分不参与策略调参的任务。生成器、评分器和被测方案之间是否共享了错误假设，比“是不是 AI 出的题”更值得追问。</p>`],
['两轮实验，不能拼成一张成功故事',`<p>历史里至少有两轮容易被混在一起的结果。首轮是 2026-10-05 的 16 案例原型，模型每任务最多调用四轮：全文成功 16/16，落盘成功 6/16。落盘降低了总体输入，但一些任务没有足够机会读到证据并作答；成功率不足以支持接入结论。</p><p>后来 2026-10-09 的完整两组比较，报告记录的模型标识为 <code>deepseek-v4-flash</code>，协议为 <code>readback-v6-project-tools</code>，使用冻结的 60 案例，关闭自动重试，并取消固定任务迭代上限。以下只列该轮基础 60 对的历史统计，不混入重复轮：</p>${table(['指标','全文注入','落盘、预览与按需读取'],[['严格成功数（原评分，含污染案例）','46/60','46/60'],['累计实测输入 token','2,370,220','874,169'],['模型请求数','208','221'],['平均任务耗时（含质量失败）','18.16 秒','14.83 秒'],['中位任务耗时','6.19 秒','9.97 秒']])}<p>累计输入降幅为 <code>1 − 874169 / 2370220 ≈ 63.1%</code>。但请求数增加，平均耗时下降而中位数上升，所以“所有任务都更快”已经不成立。供应商 usage 记录的输入 token 也不是实际账单，不能直接写成费用下降 63.1%。</p><p>两轮之间同时改变了策略、预算和样本，不能把 6/16 到 46/60 的差异归因于某一个改进。更重要的是，第二轮还有下面的数据隔离问题。</p>`],
['答案没放进提示词，不等于模型看不到答案',`<p>后续复核确认：全文组的 <code>case-55、case-56、case-58</code> 通过工具读取了当前题目的标准答案和引用元数据。这些内容分别进入第 9、12、16 次模型请求。审计依据是实际发给模型的请求消息，而不只是磁盘上存在某个文件。</p><p>这说明模型的可见范围必须按完整工具能力计算。即使初始提示词没有答案，只要执行工具能访问包含 <code>answer_values</code> 或 <code>expected_citations</code> 的评测材料，仍可能绕过预期的解题路径。</p><p>看到标答，并不能证明模型完全依赖标答才答对；但足以说明这三项不再是干净的独立解题证据。描述性地剔除已确认污染的三对，两组都是 43/57；有限扫描没有证明剩余案例全部没有隐式泄漏，所以也不能简单换一个分母就宣布问题解决。</p>${code('隔离设计 · 建议结构',`模型可访问的环境
  task.json       任务要求
  sources/        允许读取的材料
  outputs/        候选答案与产物

独立评分进程可访问的环境
  gold.json       标准答案与证据位置
  grader/         评分规则
  traces/         运行结束后收集的记录`)}<p>这里的“独立”需要执行环境和权限支撑：不给模型挂载评分目录，不让 Shell 或读取工具访问它；测试材料也不能通过日志、错误信息或可读的评测源码再次暴露答案。仅仅改一个目录名，并没有建立隔离。</p>`],
['评分器也要接受审查',`<p>同一轮的 <code>case-43</code> 提供了另一个反例。两组都数对了 diff 的新增 24 行和删除 9 行，却被严格评分判为失败：模型引用局部行段，而预设规则要求覆盖完整来源范围。这个失败包含评分契约与交付形式的问题，不能解释成“模型不会统计 diff”。</p><p>还有一些案例答案值相同，差异来自 <code>SOURCE_ID</code> 标题行是否计入行号，或是否保留 <code>Error:</code> 的字面前缀。严格检查有它的用途，但汇报时必须说清检查的是事实、格式，还是可追溯性。</p><p>因此我会分开报告答案正确、引用达标、必要证据进入模型输入和正常结束，再给出最终严格通过数。发现评分器有问题，应版本化修订、统一重评两组并保留旧分数，不能看到哪个方案输了就临时放宽规则。</p><p>证据时序也不能省略：首轮报告里有工具在最后一轮之后才返回必要材料，但没有后续模型请求消费它。那只能说“工具取回了证据”，不能说“模型看见完整证据仍答错”。</p>`],
['我会怎样重新组织下一轮验证',`<p>下一轮首先要修复评分数据隔离，再冻结任务、提示词、工具权限、策略版本和预算。每个方案从相同初始状态出发，查看任务级配对结果，而不只比较成功总数；重复运行用于观察波动，不能把同一道题的三次尝试当成三道独立新题。</p><p>成本应累计每次模型请求的输入输出，包括重读、失败和恢复尝试，并报告缺失 usage 的比例。延迟同时看分布和失败样本；有固定预算的任务达到预算上限，也应按事先约定保留在统计中。</p><p>最后再回答最初的问题：这批证据表明，落盘按需读取是一条值得继续验证的方向，历史运行确实出现了累计输入下降；但受版本、样本和标答污染限制，现有统计不足以证明生产任务质量等效。AI 可以帮助搭建评测，结论仍需要人把样例、信息边界和失败原因逐一对齐。</p>`],
['数据来源与延伸阅读',`<p>本地复核来源：冻结目录 <code>docs/evals/tool-context-20261007/dataset-v1</code>；报告 <code>docs/tool-context-evaluation-report.md</code>、<code>docs/tool-context-two-arm-live-results.md</code>、<code>docs/tool-context-case-analysis.md</code>；以及 <code>confirmed-gold-visibility.json</code>。这些是历史运行与派生审计材料，本文没有重跑 API，也没有修改原始评分。</p>${reference('/notes/evidence/2026-10-21.md','本批文章的证据索引与历史报告摘录','提供版本、哈希、案例与污染记录摘要；不是完整原始运行轨迹的公开镜像。')}${reference('https://www.anthropic.com/research/demystifying-evals-for-ai-agents','Anthropic · Demystifying evals for AI agents','其 task、trial、grader、transcript 与 outcome 的区分有助于组织评测。本文数值均来自自己的历史材料，不是该文的实验结果。')}<p>更一般的任务与评分设计见本站 <a href="#/article/eval-notes">做一个可解释的 Agent 测试集</a>。</p>`]
]},
{
id:'upload-recovery-in-practice',
title:'断点续传真正难在哪里：并发上传与合并宕机',
category:'后端工程',tags:['分片上传','状态一致性','故障恢复'],date:'2026.10.21',icon:'blocks',
desc:'从两个用户上传同一文件，以及合并过程中突然宕机两个场景出发，设计上传身份、分片确认和可重试的完成流程。',
takeaway:'续传进度、文件完整性和业务完成记录是三件事。锁可以减少竞争，可靠恢复还需要稳定的上传身份、可校验的分片和持久的完成结果。',
sections:[
['正常续传之外，还有两个问题',`<p>上传一个较大的课程视频，进度到了 80%，网络突然断开。最直接的想法是把文件切成多块，记录哪些块已经上传，下次只传缺失的部分。这样一次失败不必让整个文件从头开始。</p><p>实现正常续传之后，我更在意两个问题：A 上传到一半，B 也选择了相同文件，他们是在续传同一个任务吗？分片全部上传完成，服务器合并到一半退出，客户端再次点击完成时应该发生什么？</p><p>这篇文章借课程视频上传场景推演一套设计。DOVideo-AI 的上传链路提供了具体背景，但下面的状态机、唯一约束和恢复协议是建议方案，不声称现有项目已经全部实现，也不把故障推演写成实测结果。</p>`],
['先分清上传任务、文件内容和用户归属',`<p>两个文件内容相同，并不意味着它们是同一次上传请求。这里至少需要区分三种身份：</p>${table(['身份','回答的问题','建议用途'],[['upload_id','是哪一次上传任务？','关联分片、进度、完成请求和重试'],['content_hash','内容是否相同？','完整性校验、候选去重和对象复用'],['user_id','谁有权操作或读取？','上传归属与媒体访问控制']])}<p>初始化时由服务端分配 upload_id，并绑定当前用户、文件大小、分片规格和过期时间。客户端把这个 ID 保存下来，续传时带回。服务器每次都核对归属；知道一个上传 ID，不等于拥有操作权限。</p><p>内容摘要可以辅助判断同一文件，但客户端声明不能直接成为可信的秒传凭证。服务端需要核验内容，是否允许复用对象也需要单独的授权规则。尤其不能让一个用户只凭哈希，就访问另一个用户上传的私有文件。</p><p>作为第一版，我更倾向于让不同用户创建独立上传任务。将来再考虑“多个逻辑媒体记录复用一个物理对象”。这会多传一些重复字节，但身份和恢复边界更容易讲清楚；是否值得做跨任务去重，应由实际流量决定。</p>`],
['分片上传成功，应该以什么为准',`<p>可以选择客户端直传对象存储，也可以先把分片送到应用服务，再由服务端合并。下面采用后者说明状态关系：每个分片由 <code>upload_id + part_index</code> 定位，携带长度和内容摘要，服务端校验后再确认。</p>${code('分片确认流程 · 设计示意',`接收 part_index 对应的数据
        ↓
写入临时文件或临时对象
        ↓
核对分片大小与内容摘要
        ↓
发布为本上传任务的已确认分片
        ↓
持久记录分片状态，再返回成功`)}<p>关键不是“用了 Redis Set”，而是 Set 中的索引代表什么。如果文件还没写完就登记完成，下一次续传会跳过坏分片；文件写完但索引没登记，通常只会多传一次。后者也需要处理，但两种窗口的后果并不相同。</p><p>同一分片被重复提交时，应该根据已确认的长度与摘要判断：相同内容返回已接收，不同内容报告冲突。不能任由一个新的请求把合并过程正在读取的分片覆盖掉。临时写入后再发布的具体实现，需要结合文件系统或对象存储的原子性与持久性保证。</p><p>进度查询可以用 Redis 加速，但需要能够与实际分片清单核对。如果选择只把进度放在临时缓存里，就要接受缓存丢失后的重扫或重传策略；“缓存里有索引”本身不是文件完整的证明。</p>`],
['两个人上传同一文件，先别急着共用一把锁',`<p>假设 A 和 B 选择同一份视频。按照独立上传任务的设计，他们拿到不同的 upload_id，各自查看自己的进度。A 中途取消，不应直接删除 B 仍然需要的分片；A 的上传权限，也不能因为内容相同就传递给 B。</p><p>如果后来决定共享物理分片，还需要共享对象的引用计数或生命周期、完整性核验和权限隔离。此时“同一内容只存一份”是存储优化，“每个用户的上传正确完成”是业务保证，不能用一个文件哈希把两者合并。</p><p>另一种更常见的并发来自同一用户开两个页面，重复点击同一上传任务的完成按钮。这时按 upload_id 加锁是有针对性的：减少同一任务的并行合并。它不能自动解决不同 upload_id 的内容去重，更不能代替持久的完成记录。</p>`],
['合并之前，先把任务关进明确的状态机',`<p>仅仅检查“收到的分片数量等于总数”还不够。至少要核对索引是否齐全、每片长度和摘要是否符合声明，以及合成后的总长度与整体内容是否正确。检查时还要防止并发修改。</p><p>一种可行设计是：用带版本条件的状态迁移，把任务从 UPLOADING 切换到 FINALIZING。迁移成功后不再允许新增或替换分片，合并 worker 读取一份冻结的清单。下面是协议示意，不是某个数据库可以直接运行的完整 SQL：</p>${code('状态迁移 · 示意',`UPLOADING
  └─ 分片完整且校验通过 → FINALIZING
       ├─ 对象与业务结果确认 → COMPLETED
       └─ 执行者中断 → 保留阶段信息，进入恢复核查

进入 FINALIZING：
  比较状态与版本 → 原子迁移 → 固定分片清单

重复 complete：
  COMPLETED  → 返回持久保存的 media_id
  FINALIZING → 返回处理中，或由恢复任务接管`)}<p>如果允许接管，需要区分“旧 worker 已经停止”和“只是租约过期”。可以为执行代际分配递增版本，并要求后续写入验证版本，避免旧 worker 迟到后覆盖新结果。具体是否需要这层机制，取决于单实例还是多实例执行，不能只加一个带超时的锁就假定没有旧执行者。</p>`],
['合并宕机，要看发生在哪一步',`<p>先采用一个容易理解的流程：把冻结分片合成为临时产物，验证完整性，再上传到可追踪的对象位置；对象确认可用后，提交业务媒体记录与上传完成状态；最后做临时资源清理。不同阶段中断，需要不同恢复动作：</p>${table(['中断位置','恢复时应该核查什么','建议动作'],[['合并临时产物时','已确认分片是否仍完整、清单是否冻结','丢弃不完整临时产物后重新合并'],['对象已保存，业务记录尚未提交','该 upload_id 对应的对象是否完整可用','核验后补提交，避免无条件再造一个新对象'],['业务记录已提交，成功响应丢失','持久完成状态与 media_id 是否已存在','重复 complete 返回原结果'],['清理临时分片时','业务完成是否已经持久确认','继续或重试清理，不重新生成业务记录']])}<p>这里最重要的改动，是把 upload_id 与最终业务结果持久关联，并通过唯一约束防止同一上传任务插入多份媒体记录。如果上传任务与媒体记录都在同一数据库，可以在一个事务里写媒体记录并更新完成状态。</p><p>对象存储通常不参与这个数据库事务，所以还需要保留可核对的对象身份。可以使用与 upload_id 和执行版本关联的对象键，或先持久记录待使用的对象位置，再执行上传；恢复时核查该对象，而不是每次随机生成新名字后重新上传。固定名字本身也不够，还需要防并发覆盖和内容一致性检查。</p><p>对象成功、数据库失败时，可能出现孤儿对象；数据库已确认完成后，清理失败则只是遗留临时资源。两者都需要处理，但不应该混成一个“全部回滚”的口号。先定义哪些状态允许用户看到成功，再为未完成状态设计补提交或清理。</p>`],
['存储位置与保留期，也属于续传协议',`<p>如果分片保存在服务端本地临时目录，“重启后能续传”至少隐含一个条件：文件仍然存在。进程重启、容器重建、换一台机器处理请求，是三个不同场景。共享 Redis 只能共享进度，不会把本地分片自动搬到另一台机器。</p><p>单机方案可以明确绑定上传任务与实例，并保证临时存储在约定时间内保留；多实例方案则需要共享分片存储，或者可靠的实例路由和失效处理。两者都可以成立，但必须让承诺与部署条件一致。</p><p>完成记录与分片记录也不一定使用同样的 TTL。分片过期后可以清理，已经完成的 upload_id 与 media_id 关系却仍可能用于处理迟到的重试。清理前要检查任务状态，不能只按“文件创建多久”删除仍在使用的分片。</p>`],
['怎样验证这套设计真的可恢复',`<p>测试应该围绕中断窗口和最终结果，而不是只测接口返回码。以下是待执行的最小验证矩阵：</p>${table(['测试场景','需要验证的结果'],[['同一分片重复提交','相同内容复用确认；不同内容不能静默覆盖'],['同一 upload_id 并发 complete','最终关联一个业务结果，客户端看到一致状态'],['不同用户上传相同内容','进度与访问权限互不串用'],['合并过程中终止执行者','保留可恢复的任务状态，不把半成品发布为成功'],['对象成功后、数据库提交前终止','恢复能核对对象并补提交，或有明确清理路径'],['数据库提交后丢弃响应','客户端重试返回同一个 media_id'],['缓存丢失或请求落到其他实例','按约定重建、路由或明确失败，不误报完整']])}<p>记录每次实验的对象数量、媒体记录数量、最终文件摘要和任务状态，才能判断有没有重复、损坏或孤儿资源。实验侧的真相记录不能成为恢复逻辑的额外输入。</p><p>断点续传解决“缺哪些字节”，并发控制解决“谁可以修改”，完成协议解决“什么时候可以宣布成功”。把这三层分别设计，再通过故障窗口把它们串起来，上传链路才有可解释的恢复行为。</p>`],
['实现参考与边界',`<p>本文参考 DOVideo-AI 的浏览器分片上传、服务端本地合并、对象上传和完成标记流程，再围绕并发与宕机给出合理设计。持久任务状态、分片校验、执行版本和唯一完成约束均应按需要落地并验证，不是对现有仓库能力的声明。</p>${reference('/notes/evidence/2026-10-21.md','文章材料与证据索引','包含参考实现的文件版本与关键顺序；设计建议和实际源码摘录分开标注。')}<p>可结合本站 <a href="#/article/upload-consistency">分片上传里的状态一致性</a> 阅读更一般的存储一致性分析。</p>`]
]},
{
id:'agent-context',title:'让 Agent 走得更远：上下文治理的工程思考',category:'Agent 开发',tags:['Agent Harness','上下文工程'],date:'2026.10.17',desc:'从重复输入的成本模型、可恢复的预览协议，到检索失败与配对评测，拆解上下文治理的完整设计。',icon:'agent',takeaway:'把长结果移出上下文，需要同时设计“如何发现缺失信息”和“如何准确读回”。成本优化只有在任务质量约束下才成立。',sections:[
['先算清楚：一份长结果会被付出多少次成本',`<p>设想一个排查测试失败的任务：Agent 运行测试后得到一份很长的日志，接下来还要读代码、修改文件、再次验证。如果每次请求都携带此前的完整历史，这份日志就会继续出现在后续输入里。需要优化的因此不只是单次工具返回大小，还有它在后续请求中的重复出现。</p><p>可以把第 i 次模型请求的输入近似写成 <code>Iᵢ = S + Uᵢ + Hᵢ + ΣRⱼ</code>：S 是固定指令，Uᵢ 是当前任务信息，Hᵢ 是对话历史，Rⱼ 是仍保留的工具结果。一个长度为 R 的结果，如果被带入后续 m 次请求，就贡献约 <code>m × R</code> 的累计输入 token。这个模型计算的是输入规模；实际账单还受缓存计价等因素影响，不能直接把 token 降幅当作费用降幅。</p><p>另一个问题是信息可用性：窗口足够大，只意味着请求可能装得下，并不能保证模型一定准确定位日志末尾的错误。是否真的出现性能下降，应在任务集上测量，而不是用“注意力被稀释”代替证据。</p>`],
['三种方案的差异，是信息如何再次可用',`<p>下面的比较假设工具经常产生长结果，而任务通常只需要其中少量内容。若任务需要全量逐项核查，结论可能不同。</p>${table(['方案','保留的信息','付出的代价'],[['全文注入','模型立即看到全部结果','后续请求持续携带长结果，仍依赖模型定位证据'],['直接截断','只保留预算内片段','关键内容可能永久丢失，除非可以重新获取'],['预览 + 落盘 + 检索','完整结果在外部，先提供入口','增加检索调用与延迟；模型可能不知道需要检索']])}<p>第三种方案的成立条件不是“文件保存成功”。文件必须能读到，预览必须让模型知道它不完整，而且检索接口要足够精确。只有一个路径、没有内容范围与检索方式的预览，可能只是把信息丢失变成信息找不到。</p><p>合理目标是：在成功率与关键约束满足率允许的范围内，降低累计输入、成本和延迟。这些目标会冲突：多一次检索可能省 token，却延长完成时间。</p>`],
['把预览设计成协议，而不是字符串切片',`<p>可以为长结果设计稳定的返回结构。下例字段是设计建议，不代表 MyClaw 当前实现。字节数用于约束存储和传输；模型预算需要 tokenizer 估计，二者不能把数值直接互换。</p>${code('JSON',`{
  "call_id": "call_018",
  "artifact_id": "artifact_018",
  "status": "ok",
  "content_type": "text/plain",
  "total_bytes": 184320,
  "total_lines": 2400,
  "preview_ranges": [[1, 12], [2378, 2400]],
  "preview": "...",
  "truncated": true,
  "read_hint": "搜索关键词，再按行读取"
}`)}<p><code>status</code> 应独立于预览，否则截断可能把工具失败误装成成功结果。日志可优先保留退出码和错误附近片段；查询结果可保留字段、总数、采样规则和少量样本。不要把结构化 JSON 从中间截断后继续声称它是可解析的 JSON。</p><p>读取工具可接受 <code>artifact_id + start_line + max_lines</code>，搜索工具接受 <code>artifact_id + pattern</code>。由服务端把 artifact_id 映射到当前会话允许访问的文件，比让模型提交任意路径更容易控制边界。返回值应带实际范围和是否还有后续内容，避免把第一页误认为全量。</p>`],
['落盘和读取也有失败窗口',`<p>完整结果未保存成功时，不应该返回看似有效的路径。可以先写临时对象，校验完成后再发布可读引用；具体持久性保证取决于文件系统或对象存储。保存失败应显式返回错误，再按工具类型选择重新执行、降级预览或终止，不能静默丢弃证据。</p><p>同一份工具结果最好在本次任务内保持不可变，否则第一次看到的行号与后来读取的内容可能不一致。若需要更新，创建新版本，让引用包含版本或内容摘要。任务恢复时也必须能访问这些引用，不能只保留对话，却清理了被引用的文件。</p><p>另一类失败是“不断把全量读回来”。读取接口若没有限额，模型可能一次就把刚移出的 180KB 日志重新注入。给读取设置分页预算，并保留错误邻域搜索能力，才能让按需读取真正成立。长输出中的自然语言还应继续被视为工具数据，而非更高优先级指令。</p>`],
['历史压缩要保留约束、证据与不确定性',`<p>工具结果治理解决单次大输出，历史压缩解决多轮累计。可以把上下文分为稳定约束、当前任务状态、近期对话和可检索历史。压缩时最不该丢掉的，往往是用户否定过的方案、尚未证实的假设、未完成步骤，以及外部动作的不确定状态。</p>${code('YAML',`goal: 修复导出任务在空数据集下的失败
constraints:
  - 不改变既有导出字段
verified:
  - 空列表路径触发 IndexError
  - 证据: artifact_018, lines 2381-2392
hypotheses:
  - 默认值初始化可能位于错误分支，尚未核查
pending:
  - 读取 export.py 的相关实现
  - 添加空数据集用例并运行
uncertain_effects: []`)}<p>摘要中的“已经验证”和“猜测”应分开保存。一条猜测经过多次摘要后，可能变成未经验证的事实。还要保留消息协议所需的工具调用与结果关联；不能为了缩短历史，构造出模型 API 无法接受的消息序列。</p>`],
['用能暴露机制弱点的任务评估',`<p>设计全文注入、截断、预览加检索三组对比。固定任务输入、模型、工具和预算；每个方案从相同初始文件状态独立运行。除普通任务外，特意放入四类任务：答案在结果末尾、必须跨片段拼接证据、需要检查全部记录，以及压缩后必须记住早期约束。</p>${table(['指标','具体问题'],[['严格成功率','产物满足全部要求吗？有没有违反限制？'],['累计输入 token','包括重读、压缩和失败尝试了吗？'],['补充读取次数与延迟','成本是否转移成更多工具往返？'],['证据定位失败率','文件存在时，模型是否仍漏掉关键片段？'],['任务级配对结果','是不是修好一类任务，又损坏另一类？']])}<p>预算不足导致的终止也是方案结果，不能在统计时排除。总体成功数相同时，还应查看是否同一批任务成功：两个方案各有不同失败，说明总体数字掩盖了能力变化。本文没有报告新的实测结果；阈值应由实验确定，不能把某个固定 KB 数当作通用最优值。</p>`],
['落地顺序与参考',`<p>先做最小闭环：不可变结果存储、明确的截断标记、按行读取与关键词搜索，再加任务级评测。等失败样本证明“头部预览缺乏信息”时，再引入按工具类型的预览；等历史确实挤压预算时，再引入结构化压缩。每增加一层机制，都要能说明它修复了哪类失败。</p>${reference('https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents','Anthropic · Effective context engineering for AI agents','参考其按需加载与上下文压缩讨论。本文的返回协议、故障场景和实验方案是针对本文场景提出的设计分析。')}`]
]},
{
id:'checkpoint',title:'Checkpoint 与事件回放：中断之后，如何继续？',category:'Agent 开发',tags:['Checkpoint','可靠性'],date:'2026.10.17',desc:'从工具执行前后的崩溃窗口出发，设计状态机、幂等键、事件持久化与恢复规则，解释为什么保存上下文还不够。',icon:'flow',takeaway:'Checkpoint 能记录已知的执行进度，却无法独自证明外部副作用是否发生。恢复规则必须围绕工具的可查询性和幂等能力设计。',sections:[
['保存聊天记录后，为什么仍然不敢重试',`<p>假设 Agent 调用“创建任务”接口：请求已到达外部服务，任务已经创建，但返回响应时网络断开。聊天记录里最后一条是工具调用，没有结果。重新调用可能创建第二个任务；直接跳过又可能漏掉实际没有创建成功的任务。</p><p>恢复要区分三种对象：<strong>模型看到的上下文、运行器记录的执行进度、外部世界的真实状态。</strong>保存完整上下文主要帮助恢复第一种。第二种需要阶段记录，第三种需要外部查询、幂等协议或人工核查。</p><p>本文讨论的是异常后继续推进任务，不要求模型重新生成完全相同的文字。模型调用可能具有随机性，恢复系统应保证可追溯的状态和正确的业务效果，而不是把完全复现推理过程当作默认目标。</p>`],
['先画出崩溃窗口，再决定检查点放哪里',`<p>工具执行可以拆成：记录意图、发起请求、外部执行、接收结果、持久化结果、构建下一轮上下文。检查点只能观察其中部分阶段。</p>${table(['中断位置','重启后已知事实','恢复动作'],[['意图落盘前','没有已接受的工具意图','从最近有效状态继续；禁止先执行后记意图的旁路'],['意图已落盘，请求可能发出','想做什么已知，外部结果未知','按工具协议核查，不能只凭缺少结果就重试'],['收到结果，尚未持久化','重启后结果可能丢失','仍按不确定状态处理'],['结果已可靠持久化','持有完成证据','复用结果构建上下文，避免再次执行'],['完成记录引用的文件丢失','状态与证据不一致','报告恢复失败并修复引用，不能伪造成功结果']])}<p>记录“工具前”和“工具后”，能够缩小需要核查的范围，却无法消除外部动作与本地记录之间的间隙。跨越这个间隙，需要外部服务也参与协议。</p>`],
['事件记录与快照，各自解决一个问题',`<p>事件记录描述已发生的状态变化；快照保存某时点状态，减少重放量。可以从带序号的基础上下文快照开始，再应用后续事件。只追加事件不自动获得完整的事件溯源系统：还要定义顺序、重复事件处理、版本迁移与失败恢复。</p>${code('JSON',`{
  "run_id": "run_42",
  "seq": 18,
  "schema_version": 1,
  "event_type": "tool_intent_recorded",
  "call_id": "call_07",
  "operation_id": "create_task_42_3",
  "tool": "create_task",
  "args_ref": "artifact_args_07"
}`)}<p><code>call_id</code> 标识一次工具调用记录，<code>operation_id</code> 标识一个逻辑业务操作；同一操作恢复重试时，应复用 operation_id。如果让模型每次随机生成新键，重试就失去了去重意义。</p><p>同一 run 可由单写者串行分配 seq，或通过数据库事务建立唯一序号约束。快照携带 <code>last_applied_seq</code>，恢复时只应用之后的事件。旧日志的清理必须在快照验证与持久化完成后，否则快照损坏时恢复链会断开。</p>`],
['幂等键是业务意图的标识，不是参数的散列',`<p>参数完全相同不总意味着同一个操作。用户今天创建一条“学习数据库”的任务，明天再创建一条，可能都是合法需求。反过来，同一操作重试时附带不同时间戳，参数又可能不同。</p><p>更清晰的设计是：运行器接受业务意图时分配 operation_id，并绑定参数摘要。外部服务首次处理后保存结果；同键、同意图的后续请求返回原结果。同键但参数不同应明确报错，防止误复用。</p>${table(['工具性质','恢复规则','边界'],[['只读查询','重新读取或复用历史结果','新读取可能反映新状态，时间语义要明确'],['支持稳定幂等键的写操作','带原键重试或按键查询','去重保留期必须覆盖恢复窗口'],['可查询但不支持幂等的写操作','先按业务标识核查','查询可能延迟，不存在未必证明没执行'],['不可查询、不可幂等的写操作','进入待核查状态','不能承诺自动恢复且绝不重复']])}<p>高风险操作的人工确认记录也应绑定同一意图、参数和授权范围。不能拿一次旧确认授权一个参数已经变化的新动作。</p>`],
['恢复代码复用证据，不重演副作用',`<p>以下是恢复决策伪代码。假设日志顺序有效、运行器已取得此 run 的执行权，且工具适配器明确声明恢复能力；具体存储和异常处理仍需补齐。</p>${code('Python 伪代码',`async def resume_operation(op, journal, adapter):
    completed = journal.find_completed(op.operation_id)
    if completed:
        return await load_verified_result(completed.result_ref)

    if adapter.supports_query:
        observed = await adapter.query(op.operation_id)
        if observed.is_complete:
            await journal.persist_completed(op, observed.result)
            return observed.result
        # NOT_FOUND 不自动等价于“从未执行”

    if adapter.supports_idempotency:
        result = await adapter.execute(
            op.args, idempotency_key=op.operation_id
        )
        await journal.persist_completed(op, result)
        return result

    await journal.mark_needs_reconciliation(op)
    raise NeedsReconciliation(op.operation_id)`)}<p>“回放事件”只应更新本地状态与上下文；“重新执行工具”是独立决策。把历史 tool_requested 直接映射成 execute，会把恢复系统变成副作用重放器。</p>`],
['持久化不是调用一次 write 就结束',`<p>JSONL 便于检查，但要处理一行写到一半就退出、缓冲区尚未刷新、多个写者交错等情况。应按明确格式和校验规则恢复有效前缀；发现中间损坏不应直接跳过，因为后续事件可能依赖缺失状态。</p><p>若完成事件指向独立结果文件，应先确保文件可恢复，再提交完成事件。反过来可能形成“日志宣称成功，结果却不存在”。也可以把较小结果与完成事件放进同一数据库事务，减少跨文件一致性问题，但仍无法把远端 API 副作用纳入本地事务。</p><p>采用 SQLite 等事务存储时，也要理解提交与同步配置的保证范围。SQLite 官方原子提交文档讨论了事务与持久化假设；这不等于换成数据库，就获得跨系统 exactly-once。</p>`],
['故障注入与参考',`<p>在意图提交后、请求发出后、外部成功后、本地结果保存前，以及完成记录提交后分别结束进程，再恢复同一 run。对幂等模拟服务，检查最终只有一个业务对象；对不可查询服务，检查系统进入待核查而非重复调用。</p><p>再测两个恢复器同时启动、结果文件丢失、日志尾部不完整和幂等记录过期。记录恢复耗时，判断是否需要增加快照频率。可靠恢复不是“永远自动继续”，而是在证据不足时停在明确、可处理的状态。</p>${reference('https://www.sqlite.org/atomiccommit.html','SQLite · Atomic Commit','参考事务原子性与磁盘同步假设。本文事件结构与恢复规则属于设计建议，并非对现有项目代码的审计。')}`]
]},
{
id:'async-pipeline',title:'从同步等待到异步流水线：视频处理的拆解',category:'后端工程',tags:['RocketMQ','异步任务','Outbox'],date:'2026.10.17',desc:'异步化之后，谁保证任务没有丢、重复消费不会重复处理、取消不会被迟到的结果覆盖？从受理语义到故障补偿逐层展开。',icon:'flow',takeaway:'返回 task_id 只改变了请求的等待方式。异步任务的正确性，取决于任务受理、消息投递、执行结果和状态迁移之间的完整协议。',sections:[
['先给“成功”一个没有歧义的定义',`<p>假设视频处理包含音频提取、ASR 转写、OCR、总结四个阶段。同步接口要等整条链完成才能返回，客户端超时后又不知道服务端是否还在执行。异步化可以先受理任务，让客户端通过 task_id 查询，但必须明确接口承诺。</p><p><strong>受理成功表示系统持久地接受了这项工作，不代表视频已经处理成功。</strong>如果只是把任务放入进程内线程池就返回成功，进程退出后任务可能消失，这个“受理”就没有可靠的持久性含义。</p><p>下面是一种适合视频任务的设计讨论，并非声称 DoVideoAI 已实现全部机制。接口可以返回任务标识、初始状态和查询地址；任务状态是业务事实，MQ 状态是投递事实，二者不要混成同一个字段。</p>${code('HTTP',`HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "task_id": "video_task_42",
  "status": "QUEUED",
  "status_url": "/tasks/video_task_42"
}`)}<p>客户端因超时重复提交时，还应携带稳定的请求幂等键。服务端在用户作用域内对这个键建立唯一约束，并检查相同键是否绑定了不同输入。</p>`],
['数据库与消息队列之间的双写问题',`<p>先写任务表再发 MQ：数据库成功、消息发送失败，任务就可能永远等待。先发 MQ 再写数据库：消费者可能先收到消息，却查不到任务。加一个 try/catch 并不能消除这两个系统之间的失败窗口。</p><p>一种可选方案是事务 Outbox：在同一数据库事务中插入任务记录和“待发送事件”。独立发布器读取 Outbox，把事件发给 MQ，再标记发送状态。</p>${code('SQL 设计示意',`BEGIN;
INSERT INTO tasks(id, owner_id, request_key, status)
VALUES (:task_id, :owner, :request_key, 'QUEUED');
-- UNIQUE(owner_id, request_key)
INSERT INTO outbox(event_id, task_id, event_type, status)
VALUES (:event_id, :task_id, 'VIDEO_SUBMITTED', 'PENDING');
COMMIT;`)}<p>发布器发送成功后、更新 Outbox 前崩溃，会再次发送同一事件。因此 Outbox 主要修复“任务存在但没有可靠的发送意图”，不会消除重复投递。多发布器还需要认领或租约机制；长期未发送的事件要有积压告警。</p><p>消息中放 task_id、event_id 和必要版本信息即可。大文件继续留在对象存储，避免把视频或完整转写塞进消息正文。</p>`],
['消费者幂等：检查后执行仍然存在竞争',`<p>下面这种逻辑不够：查到 status 不是成功，就调用 ASR。两个消费者可能同时查到未完成，然后同时执行。需要原子认领，并区分任务级完成与阶段级完成。</p>${code('SQL 设计示意',`UPDATE task_steps
SET status = 'RUNNING',
    attempt = attempt + 1,
    lease_owner = :worker,
    lease_until = :deadline
WHERE task_id = :task_id
  AND step = 'ASR'
  AND status = 'QUEUED';
-- 只有 affected_rows = 1 的执行者取得本次执行权`)}<p>执行者把本次 attempt 当作代际标识。提交结果时，条件里同时检查 attempt 和运行状态，防止失去执行权的旧 worker 覆盖新结果。租约过期后的重新认领也必须原子完成，而不是每个 worker 自行判断后直接开跑。</p><p>这只能保护本地状态更新，不能自动消除外部 ASR 的重复计费。若请求超时但服务端已受理，优先按稳定的外部任务标识查询；供应商支持幂等键时应复用原键。不支持查询或幂等时，要明确接受重复成本，或者进入人工核查，不能用本地锁宣称外部 exactly-once。</p>`],
['何时确认消息，取决于它承诺交付什么',`<p>若消息代表“完成这一处理步骤”，应在该步骤的业务结果可靠持久化后，再向 MQ 返回成功或确认消息。若收到消息后把任务持久移交给另一套可靠调度器，也可以在移交成功后确认，但必须由调度器接管重试与恢复责任。</p><p>最危险的是提交到内存线程池后立刻返回消费成功：MQ 认为交付完成，线程池却可能随进程消失。不要把“开始异步执行”误认为“可靠移交”。</p><p>RocketMQ 不同消费者类型的确认方式不同：PushConsumer 通过消费回调结果等机制反馈，SimpleConsumer 有显式确认及不可见时间相关行为。应以实际 SDK 为准，不能统称所有代码都调用手动 ack。本文不绑定某个 SDK 方法名。</p><p>长任务还要匹配消费超时或不可见时间管理，否则旧处理尚未结束，消息就可能再投递。重试耗尽进入死信队列只是保留问题，仍需要告警、排查与受控重放。</p>`],
['并行与取消：状态机比线程池更重要',`<p>ASR 与 OCR 若没有输入依赖，可以并行；总结则等待所需的有效结果。这里应先定义是否允许降级：OCR 失败但 ASR 成功，任务是失败，还是生成标明信息不完整的总结？不能让线程先后完成的偶然顺序决定产品语义。</p>${table(['业务状态','允许的动作','禁止的迁移'],[['QUEUED','认领执行、取消','没有处理证据就直接成功'],['RUNNING','记录阶段结果、失败、请求取消','旧 attempt 覆盖新 attempt'],['CANCEL_REQUESTED','传播取消、清理、停止后续调度','调度新的总结阶段'],['SUCCEEDED / FAILED / CANCELLED','查询结果；按策略创建新一代重试','被迟到回调无条件改回运行']])}<p>取消本地协程不等于撤销已经发出的远端请求。可在每次昂贵调用前和提交结果前检查取消状态，并通过条件更新保护最终状态。若供应商无法取消，应该区分“用户不再等待”和“外部工作已停止”，记录可能继续发生的成本。</p>`],
['背压、观测与故障测试',`<p>异步队列能吸收短时波动，却不能把长期超负载变成无限处理能力。假设到达速率 λ 持续高于有效处理速率 μ，积压会持续增加。线程池和外部 API 并发都应有界，重试使用退避与随机抖动，并为新任务与重试任务避免相互饿死。</p><p>至少记录受理到完成的端到端耗时、排队时长、各阶段耗时、重试次数、租约超时数、Outbox 最老未发送时间。只展示接口几十毫秒返回，不能说明用户更快拿到了总结。</p><p>故障测试可模拟：Outbox 发送后崩溃、同一消息重复投递、ASR 成功但回包丢失、旧 worker 迟到提交、取消与成功同时发生。检查任务没有永久卡住、业务结果没有被旧执行覆盖，并把无法自动修复的情况留为可查状态。</p>${reference('https://rocketmq.apache.org/docs/featureBehavior/10consumerretrypolicy/','Apache RocketMQ 5.0 · Consumption Retry','核对消费者类型、确认与重试边界。Outbox、任务状态机和阶段认领是本文提出的业务层设计，不是 MQ 自动提供的保证。')}`]
]},
{
id:'upload-consistency',title:'分片上传里的状态一致性，究竟在对齐什么？',category:'后端工程',tags:['Redis','MySQL','文件上传'],date:'2026.10.17',desc:'沿着写分片、记进度、合并文件和发布记录的路径，推演每一个中断窗口，以及分布式锁之外还需要哪些正确性约束。',icon:'blocks',takeaway:'Redis 进度是可重建的加速信息，文件可用性要由持久对象和业务记录共同确认。锁减少竞争，原子状态迁移和发布协议保护结果。',sections:[
['先明确：上传进度与文件可用不是同一个事实',`<p>分片上传通常同时涉及三个系统：对象存储保存字节，Redis 保存已上传分片集合，MySQL 保存上传会话和文件记录。一个 Set 里出现了全部分片号，只能说明进度记录声称上传完整，不能直接证明这些对象确实存在、内容正确，或者最终文件已经合并。</p><p>可以把目标拆成三个不变量：被报告为完成的分片应有可核查的存储证据；对用户发布为 READY 的文件必须指向已校验的完整对象；同一上传会话的旧合并执行不能覆盖新的有效结果。</p>${table(['数据','建议职责','丢失后的处理'],[['对象存储分片','实际上传内容','补传，不能凭进度记录重造内容'],['Redis 分片集合','加速进度查询','从持久元数据或对象核查重建'],['上传会话与分片元数据','会话归属、期望大小、摘要、状态','依赖持久化与备份恢复'],['最终文件记录','对外可用状态、最终对象引用','未提交前不向用户宣称文件可用']])}<p>这是一种设计选择。若不持久化每个分片元数据，也应明确对象命名与核查方式，而不能让 Redis 成为唯一依据。</p>`],
['会话身份、内容身份与权限应该分开',`<p>用文件摘要作为身份方便去重，但上传会话不应只由文件摘要决定。两个用户上传相同内容，可能有不同权限、文件名和保留策略。建议独立生成 upload_id，绑定 owner_id、期望大小、分片规格和有效期；内容摘要用于校验与去重判断。</p><p>分片键可以按 <code>owner/upload_id/part_no/attempt_id</code> 组织。先写不可变临时对象，再发布当前分片引用，能够避免两个重试同时覆盖同一个可变对象。若采用存储服务原生 multipart 协议，则应遵循该服务的 uploadId、part number 和完成语义。</p><p>摘要校验和授权也不是一回事。不能因为客户端提交了一个摘要，就允许它直接读取其他用户的文件。跨用户秒传需要额外的归属、权限或内容持有证明。对可被恶意构造的输入，不应把 MD5 当作安全身份；可以采用更强摘要，同时保留大小、归属及访问检查。</p>`],
['先写存储再记进度，也需要补偿',`<p>合理顺序是：校验上传会话与分片范围，写对象并获得完成证据，记录该分片元数据，最后更新 Redis 进度。这个顺序减少“进度成功但对象根本没写入”的风险，却仍然存在中断窗口。</p>${table(['故障窗口','可观察结果','恢复策略'],[['对象写完，元数据未提交','存在孤立分片对象','重试时核查大小和摘要后认领，或重新写入并清理孤立对象'],['元数据提交，Redis 更新失败','真实分片已完成，进度少记','从持久元数据补录 Redis'],['只相信 Redis 全部完成','可能漏掉丢失或损坏分片','合并前依据权威元数据逐项校验'],['同一分片号重复上传不同内容','相同序号出现冲突','拒绝冲突或显式创建新版本，不能静默覆盖']])}<p>同一分片号重试时，可以通过唯一约束 <code>(upload_id, part_no)</code> 和摘要比对返回“已经完成”；若内容不同则明确报冲突。只做先查后插存在竞争，唯一约束必须在持久层兜底。</p>`],
['分布式锁为何不能独自保护合并',`<p>设执行者 A 取得有期限的合并锁，然后发生长暂停。锁过期后 B 取得锁并开始合并；A 恢复后仍可能继续写入。此时两个进程都认为自己可以工作，锁续期机制也无法保证永远没有暂停或网络分区。</p><p>Redis 官方锁文档讨论了租约有效期、释放时核对持有者等约束。对这里的合并场景，可以进一步设计代际隔离：每次认领分配递增 generation，合并结果写入包含 generation 的独立对象键，最终发布时通过数据库条件更新检查代际。</p>${code('SQL 设计示意',`UPDATE uploads
SET state = 'MERGING', generation = generation + 1
WHERE id = :upload_id AND state = 'UPLOADING';
-- 取得执行权后读取并保存本代 generation

-- 完整对象已写入且完成校验后，发布这一代
UPDATE uploads
SET state = 'READY', object_key = :versioned_object_key
WHERE id = :upload_id
  AND state = 'MERGING'
  AND generation = :my_generation;`)}<p>接管超时的 MERGING 任务，需要额外的租约检查与原子增代逻辑，不能直接套用第一条 SQL。旧执行者的发布若影响行数为 0，应放弃发布并清理自己的孤立对象。</p><p>仅在数据库检查 generation 还不够：若两个执行者写同一个最终对象键，旧执行者仍可能污染新对象。<strong>不可变的分代对象 + 条件发布引用</strong>共同建立边界；若目标存储原生支持 fencing 或条件写，也可以采用其保证。</p>`],
['文件完成后再插库失败，应该删还是补',`<p>完整对象写入成功、文件记录提交失败，会产生暂时无人引用的对象。可以重试发布；重试前检查对象摘要、大小与所属会话。数据库成功而响应丢失时，客户端查询会话应能得到原来的 READY 结果，不必再次合并。</p><p>发布记录尽可能在同一数据库事务中完成：文件记录、上传会话状态和用户文件关联保持一致。若内容去重触发唯一约束冲突，应读取已有合法对象并建立用户关联，而不是无条件把 DuplicateKeyException 当成上传成功。</p><p>垃圾回收需要保留宽限期，并检查对象没有被有效记录引用。不能看到“暂时未引用”就立即删除，因为另一个发布事务可能还在进行。过期上传会话、孤立分片和孤立最终对象应使用不同的清理规则。</p>`],
['验证不变量，而不只是接口返回码',`<p>测试至少覆盖重复分片、冲突分片、两个客户端同时合并、锁过期后旧 worker 恢复、Redis 数据丢失、最终对象写完后数据库失败。每次都检查：READY 是否可下载且摘要正确；同一上传会话是否只暴露一个有效最终引用；旧代结果是否无法覆盖新代；孤立对象能否被最终清理。</p><p>如果上传规模很小，未必要一开始引入复杂分布式调度。先把会话身份、持久状态、重试规则和最终校验做清楚，再按实际并发量增加锁与代际控制。复杂度应对应一个已经识别的故障窗口。</p>${reference('https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/','Redis · Distributed Locks','参考锁的持有期限、所有权与安全性讨论。分代对象、条件发布和恢复策略是本文针对上传场景的设计分析。')}`]
]},
{
id:'cache-aside',title:'理解 Cache Aside：从读写路径到并发反例',category:'计算机基础',tags:['缓存','一致性','并发时序'],date:'2026.10.17',desc:'为什么先更新数据库再删缓存仍然可能读到旧值？用两条并发时间线，分析删除重试、TTL、延迟双删与版本控制的边界。',icon:'cache',takeaway:'缓存一致性要分开处理“失效没有送达”和“旧读取迟到回填”。一种补偿机制通常只解决其中一类，不能把风险降低当作强一致保证。',sections:[
['先界定数据与承诺，再讨论删除顺序',`<p>假设商品信息以数据库为权威来源，Redis 缓存商品详情。读请求先查缓存，未命中则读库并回填；写请求提交数据库后，删除对应缓存。Microsoft 的 Cache-Aside 文档描述了这一常用路径，也明确指出它不保证缓存与数据库始终一致。</p><p>讨论方案前，要先回答：允许多长时间的旧值？更新者本人需要立即读到新值吗？价格展示与下单扣款是否走同一条读取路径？如果库存扣减必须依赖当前数据库状态，就不应让一个允许短暂过期的展示缓存承担交易判断。</p><p>本文假设单个业务键在数据库中有唯一权威记录，缓存是可重建副本。主从数据库延迟、本地多级缓存和跨地域复制会引入额外问题，不能在没有说明时把它们忽略后声称覆盖所有部署。</p>`],
['为什么“先删缓存再更新数据库”存在直接反例',`<p>设原值为 v1，写请求 W 要把它改成 v2。删除本身成功，也可能发生以下交错：</p>${table(['时刻','写请求 W','读请求 R','结果'],[['t1','删除缓存','—','缓存为空'],['t2','尚未提交数据库更新','缓存未命中，读到数据库 v1','R 持有旧值'],['t3','—','将 v1 写回缓存','旧缓存重新出现'],['t4','提交数据库 v2','—','数据库 v2，缓存 v1']])}<p>这条时序的关键是：删除发生时，新值还不存在于权威存储。另一个读请求可以合法地取得旧值并填回缓存。若后续没有失效动作，旧值会持续到 TTL 或其他修复发生。</p><p>因此通常把顺序改为先提交数据库、再删缓存，至少避免让“删完后立即读库”的请求必然读到尚未更新的值。但顺序调整只是缩小窗口，不是消除所有并发反例。</p>`],
['先更新数据库再删缓存，仍有两类失败',`<p>第一类是数据库提交成功，删除缓存失败。此时数据库是 v2，缓存可能还保留 v1。它属于<strong>失效动作没有可靠送达</strong>。</p><p>第二类即使删除成功，也可能发生：一个早先的缓存未命中请求已经从数据库读到了 v1，但由于调度暂停，直到更新完成后才回填。</p>${table(['时刻','读请求 R','写请求 W'],[['t1','缓存未命中，从数据库读到 v1，随后暂停','—'],['t2','仍未回填','提交数据库 v2'],['t3','仍未回填','成功删除缓存'],['t4','恢复运行，将先前读到的 v1 写入缓存','已完成']])}<p>第二类是<strong>旧结果迟到回填</strong>。删除重试成功只能证明某一刻缓存被删了，不能证明没有一个旧读请求还在路上。主从延迟还可能让删除之后发起的新读继续从副本取得旧值，必须纳入实际系统的读源分析。</p>`],
['补偿方案要对应故障类型',`${table(['机制','主要缓解什么','不能直接保证什么'],[['可靠失效事件 / Outbox','数据库更新后删缓存失败或进程崩溃','不阻止所有在途旧读回填'],['TTL','让遗留缓存有过期机会','不自动给出从数据库提交起算的严格陈旧上界'],['延迟再次删除','清除一部分先前读请求迟到写回的旧值','固定延迟覆盖不了任意慢请求与复制延迟'],['同键读写协调','约束回填与更新的交错','若有绕过协议的写入者，仍可能不一致'],['版本与条件写入','拒绝已知旧版本覆盖新版本','删除后版本信息消失时，需要额外机制']])}<p>Outbox 可以让数据库更新与失效意图在同一事务中提交，随后重试删除。删除操作可重复执行，但仍有事件传播延迟。需要监控失效事件积压，不能只说“最终会重试”。</p><p>TTL 应设在回填时。若旧请求在写事务完成很久后才回填，陈旧时间从这次回填继续计算；在缺少读延迟上界、复制延迟上界等假设时，不能把 TTL 简单解释成“更新后最多旧这么久”。</p>`],
['版本控制的陷阱：被删除的版本拿什么比较',`<p>一种直觉做法是把数据库版本号一起缓存，只允许更大版本覆盖。但如果缓存已经被 DEL，旧读取拿着 v1 来回填，发现键不存在，仍然可能写入成功。仅比较当前缓存值，没有留下新版本的信息，就无法拒绝旧写。</p><p>可以引入独立的版本栅栏或失效代际：写方发布最低可接受版本，回填方在原子操作中检查版本。可这又带来新问题：版本栅栏是否会先于旧读完成而过期？数据库提交与版本发布的间隙如何处理？业务写入者是否都遵守协议？</p>${code('伪代码：只展示回填判断',`# 缓存值与版本栅栏需在同一原子操作中检查
fence = get_min_acceptable_version(key)
current = get_cached_version(key)

if loaded_version < fence:
    reject_stale_fill()
elif current is not None and loaded_version < current:
    reject_stale_fill()
else:
    set_cache(key, loaded_value, loaded_version, ttl)`)}<p>这不是可直接复制的强一致方案：fence 缺失时的策略、存活时间、更新顺序和跨系统原子性都还要定义。它说明版本机制需要保留足够的信息，不能只给缓存值加一个 version 字段就结束。</p><p>若业务真正要求写后立刻读到自己的新值，可以对更新后的特定读路径绕过缓存、读取权威节点并验证版本。若要求所有并发访问强一致，则需要更完整的协调协议，并评估吞吐和可用性代价。</p>`],
['把竞争条件变成可重复的测试',`<p>不要用随机 sleep 等待偶然撞上竞态。测试可以设置屏障：让 R 在“数据库读取完成、缓存回填之前”暂停；让 W 完成更新与失效；再放行 R。这样可以稳定重现迟到回填，并检查改进方案是否真的拒绝旧值。</p><p>再分别注入 Redis 删除失败、失效发布器停止、数据库副本延迟和多级缓存未同步。观测缓存版本落后权威版本的次数、失效事件最长滞留时间，以及关键读路径返回旧值的比例。吞吐和命中率是性能指标，不能代替一致性指标。</p><blockquote>分析缓存问题时，先问“谁在什么时候读到什么，又在什么时候写回哪里”。具体时序比直接背诵延迟双删更有解释力。</blockquote>${reference('https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside','Microsoft Learn · Cache-Aside pattern','参考基础读写路径与一致性局限。两组并发时序、版本栅栏分析和测试方法为本文的场景推演。')}`]
]},
{
id:'eval-notes',title:'做一个可解释的 Agent 测试集',category:'学习笔记',tags:['Eval','实验设计','失败分析'],date:'2026.10.17',desc:'从一条可验收任务到配对实验：设计样本、评分器、隔离环境与失败归因，让成功率能够支持工程决策。',icon:'blocks',takeaway:'测试集的价值在于支持一个具体决策。先写清楚要验证的假设和验收条件，再选择样本与指标，才能知道一次优化究竟改变了什么。',sections:[
['先把“效果更好”变成一个可以被否定的假设',`<p>如果想验证工具结果预览机制，问题不应只是“新方案成功率有多高”，而是“相同任务和预算下，预览加检索能否减少累计输入，同时不造成不可接受的质量下降”。这同时包含效果、成本和允许的退化范围。</p><p>可以在测试前约定：严格成功率是主指标；关键约束违规单独统计；累计输入、额外读取和延迟是次指标。若业务接受某种非劣范围，应事先确定，并评估样本量能否支持这样的结论。小测试集观察到相同成功数，不能直接证明统计意义上的非劣。</p><p>本文提供可执行的评测设计，不宣称已经完成这些实验，也不把下面的示例样本数量或结果当成真实项目成绩。</p>`],
['按机制风险分层，而不是只收集顺手的任务',`<p>从 Agent 实际要处理的任务出发，再加入能够暴露待验证机制弱点的样本。以下矩阵适合工具结果治理实验，具体数量应依据覆盖需求和预算分配。</p>${table(['任务层','要覆盖的情形','失败信号'],[['普通工具任务','短结果即可完成，单工具或少量组合','新增机制拖慢简单任务'],['长结果检索','证据在开头、中段、末尾或多处','预览误导、漏读、读错片段'],['全量约束','必须检查全部记录，不能只采样','把局部正确当全局正确'],['跨轮约束','早期禁止事项在后续仍有效','摘要丢约束'],['异常恢复','调用超时、结果文件缺失、工具报错','把未知状态说成成功'],['多步产物','读要求、改文件、验证并交付','中间步骤正确但最终交付失败']])}<p>不要只改文件名就把同一模板计成大量独立能力。相似任务应记录 template_family，报告各类结果。调参集用于发现问题，保留集用于检查泛化；看过并反复据此修改的失败样本，应进入回归集，而不能继续冒充未见测试。</p>`],
['一条任务必须包含可恢复的环境和验收条件',`<p>只保存用户提示词是不够的。Agent 的结果还依赖初始文件、工具响应、权限、时间和网络状态。可从一个小型、固定夹具开始：</p>${code('YAML',`id: log-tail-001
family: long_output_lookup
intent: 从测试日志定位失败并修复配置
initial_state:
  fixture: fixtures/log-tail-001-v1
  permissions: workspace-only
input: 运行测试，修复配置路径错误，不修改测试断言
budget:
  max_tool_calls: 20
  timeout_seconds: 180
checks:
  - config_path_matches_expected
  - target_test_passes
  - test_files_unchanged
  - no_write_outside_workspace
required_evidence:
  - final_test_result
cleanup: reset_workspace`)}<p>这份配置是示例，数字不是最优参数。测试开始前要证明任务本身可完成，参考解不一定只有一种，但验收条件必须一致。约束检查也要和可用权限匹配；若测试工具根本无法观察越权写入，就不能声称已经验证它不存在。</p><p>涉及实时网页或外部 API 的任务，可以把确定性回归与在线集成测试分开。使用录制响应能提高可重复性，但不能取代真实网络下的超时、限流和数据变化测试。</p>`],
['评分器检查产物与约束，不迷信最后一句话',`<p>Agent 说“完成了”不是成功证据。改代码任务应检查文件差异与测试结果；数据任务检查输出结构、关键数值和约束；带副作用的任务检查外部状态。严格成功可以定义为所有必要检查同时通过，部分得分仅用于诊断。</p><p>能用程序确定的条件，优先写成规则。开放式解释质量可以采用模型评分，但要给出清晰量表、固定评分版本，并用人工标注的小样本检查一致性。评分模型可能被冗长表达或答案中的指令误导，输入应明确隔离任务材料、候选答案和评分规则。</p><p>不同评分器各有职责：产物检查回答“结果对不对”，轨迹检查回答“有没有违规或不必要的副作用”，人工复核回答“自动评分是否误判”。不要因为工具调用顺序不符合参考轨迹，就否定一个同样正确而更简洁的方案。</p>`],
['配对实验：控制环境，也保留失败尝试',`<p>对每个任务，分别运行基线 A 与候选 B，并为每次运行恢复相同初始状态。记录模型版本、提示词版本、工具版本、配置、随机性设置和预算。真实服务可能随时间变化，运行顺序可以随机化或交错，减少时间偏差。</p>${code('Python 伪代码',`for task in held_out_tasks:
    for trial in range(repeats):
        for variant in shuffled([baseline, candidate]):
            env = reset_from_fixture(task.initial_state)
            result = run_agent(variant, task, env)
            score = grade(task.checks, result, env)
            save_trial(task.id, variant.id, trial,
                       score, result.usage, result.trace_ref)`)}<p>超时、达到工具调用上限和内容策略触发都应按事先定义的规则保留，不能只报告跑完的样本。若排除的是测试平台自身故障，也应留下排除原因，并确保两个方案处理一致。</p><p>至少同时报告按尝试汇总的成功率和按任务分层的结果。重复运行可以观察同一任务的波动，但多次 trial 共享同一任务，不能把它们全部当作互相独立的新任务来计算过于乐观的置信区间。</p>`],
['成功总数一样，可能发生了完全不同的退化',`<p>下面是一个纯假设的十任务例子，用来说明为什么必须查看配对结果：</p>${table(['配对结果','任务数（假设）'],[['A 与 B 都成功','6'],['只有 A 成功','2'],['只有 B 成功','2'],['A 与 B 都失败','0']])}<p>A、B 都是 8/10，但 B 损坏了两个原来成功的任务，也修好了两个原来失败的任务。对于关键任务，前者可能不可接受。应进一步检查损坏任务是否集中在全量核查或长输出末尾定位，才能把变化关联到机制。</p><p>统计不确定性也要报告。可以按任务做配对重采样估计差异区间；若某些任务共享模板，必要时按模板家族分组重采样。小样本时，更稳妥的说法是“在这批任务上观察到”，而不是推出“系统整体没有质量损失”。</p><p>成本统计包含压缩、补充读取、失败重试和评测中可归属的模型调用。费用、token 和延迟分别报告；输入 token 更少不自动等于账单同幅下降，也不保证墙钟耗时更短。</p>`],
['失败归因：找到最早偏离证据的步骤',`<p>一个最终答案错误，可能源于没读到证据，也可能读到了却理解错误，或者工具执行失败后仍宣称完成。只标记“回答错误”无法指导修改。建议从轨迹中定位最早可观察的偏离点：</p>${table(['归因','需要的证据','下一步实验'],[['未获取关键信息','关键片段从未被读取','改变预览与搜索入口'],['信息已读但未正确使用','轨迹中存在证据，后续判断与之矛盾','调整约束呈现，检查模型能力'],['工具或环境失败','调用错误、缺失文件、超时','区分工程修复与策略降级'],['状态判断错误','未完成却宣称完成，或重复副作用','增加完成校验与恢复协议'],['评分器误判','产物有效但检查不适用','修订评分器并重算受影响结果']])}<p>保存用户输入、模型可见输出、工具调用与返回、状态事件和产物即可支持大量诊断；不需要假定能够获取模型未公开的内部思维过程。一次修改后先重跑相关回归集，再在保留集检查外溢影响，形成“假设—证据—修改—复测”的闭环。</p>${reference('https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents','Anthropic · Demystifying evals for AI agents','参考 task、trial、grader 的区分与多种评分方式。本文的任务矩阵、假设数据和配对分析方案是围绕上下文治理实验展开的设计。')}`]
]},
];
// Reading time is an estimate based on body length; code and tables need additional time.
for (const a of articles) {
 const plain=a.sections.map(s=>s[0]+' '+s[1].replace(/<[^>]*>/g,'')).join(' ');
 a.wordCount=(plain.match(/[\u3400-\u9fff]/g)||[]).length+(plain.match(/[A-Za-z0-9_]+/g)||[]).length;
 a.time=Math.max(1,Math.ceil(a.wordCount/300))+' 分钟';
}


