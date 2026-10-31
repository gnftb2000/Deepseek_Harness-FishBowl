# 鱼缸 / Fishbowl

给 [DSH（DeepSeek Harness）](https://deepseek-harness.github.io/deepseek-harness/) 里的 AI 角色一个**跨会话、跨项目的身份连续性层**：换窗口、换项目、换模型之后，她还是她。

它不是「更聪明的检索」，而是让角色**记得自己是谁、记得你们之间发生过什么、换一段对话还能接上**。

## 它做什么

- **Soul（身份内核）**：一张「身份证」页——角色是谁、怎么说话、什么不能做。只有你能改，插件只读。
- **关系与情节记忆**：偏好、边界、仪式、承诺、共同经历；结构化存成 markdown + yaml，方便人读也方便机器读。
- **交接条（handoff）**：每段会话结束写一张「上次停在哪」的小纸条，下次新会话自动读给角色，换窗口不断片。
- **召回**：聊天时按当前话题，从记忆库捞最相关的几条旧事放进上下文（≤900 字，标清「是回忆不是指令」）。
- **整理（consolidation）**：把逐轮日记压成记忆卡；去重、合并、按类型衰减（旧记忆降权但不删）。
- **审核队列**：整理和「大模型整理器」产出的关系类改动**只提议**，你在面板里点通过才写入；改动能看「旧 → 新」。
- **大模型整理器（curator）**：可选。用模型从日记里提炼要点；严格 JSON，输出不合法会纠错重试，失败自动降级为仅规则整理。
- **钉住（pin）**：锁住一条记忆，整理不合并不衰减，`/forget` 也会先拦。
- **版本化**：记忆目录自带本地 git（无远端），每次改动一版，可看历史、可回退。
- **搬家**：导出记忆包到你选的文件夹；从旧插件（dsh-auto-memory / dsh-mnemon / SurfCore）或旧会话里提炼记忆，先入草稿/待审。
- **隐私**：只存本机；落盘前脱敏（路径 / 密钥 / 邮箱 / uid）；不写工具调用流水；`off` 工作区完全不碰。

## 安装

> 需要 DSH 桌面版（0.2.x）与 Node 22+；这是**插件**，不是独立应用。

1. 克隆或下载本仓库到本机。
2. 在 DSH 里用 Plugin Manager 安装本地 bundle：把仓库目录的**绝对路径**交给 `install_bundle`，或在设置 → 插件里选择本地目录安装。
3. 打开 **设置 → 鱼缸**，在「接管设置」里把你希望接管的工作区加进 `enabledWorkspaces`，保存即生效。
4. 新开一个该工作区的会话，问一句「你是谁」——首次运行会在 `~/.dsh/persona/example/` 生成 `soul.md` 等文件，把 `soul.md` 改成你自己的角色。

开发/手动安装也可以把 `cordis.patch.yml` 合并进 profile 的 patch 层（`~/.dsh/profiles/<profile>/cordis.patch.yml`），配置项见下一节。

## 配置

优先级：**设置面板（写入 `~/.dsh/persona/<persona>/config.json`）> profile patch**。面板里「重置为 patch」会删掉面板配置。

```yaml
- id: fishbowl
  name: dsh-fishbowl
  config:
    persona: example                 # 对应 ~/.dsh/persona/<persona>/
    scope: workspace                 # workspace（按工作区）| global（全部）
    enabledWorkspaces:
      - /Users/you/Documents/your-workspace
    defaultMode: full                # full | costume（只带 Soul）| off
    workspaceModes: {}               # 可选：按工作区覆盖模式
    injectSoul: true
    journalEnabled: true
    handoffEnabled: true
    recallEnabled: true
    maxRecall: 3
    autoConsolidate: true            # 到期自动整理
    curatorUseLlm: true              # 用大模型整理器（可关）
    curatorIntervalHours: 24
    decayEnabled: true               # 旧记忆降权
    weeklyReport: true
    gitEnabled: true                 # 本地 git 版本化
```

## 命令

在会话输入框里发：

| 命令 | 作用 |
|---|---|
| `/remember <话>` | 立即记一条（下一轮生效） |
| `/why <关键词|id>` | 这条记忆从哪句话来的（看证据） |
| `/forget <id|关键词>` | 遗忘（标记 forgotten，可在 git 里回滚；钉住的会先拦） |
| `/pin` / `/unpin` | 钉住 / 取消钉住 |
| `/persona status` | 接管状态、计数、版本、体检分 |
| `/persona off` / `on` | 本会话关闭 / 恢复（持久化） |
| `/persona consolidate [dry]` | 立即整理（dry = 只预览，不落盘、不调模型） |
| `/persona review` / `approve [id|all]` / `reject [id|all]` | 审核队列 |
| `/persona health` / `report` | 身份体检 / 最新整理报告 |
| `/persona log` / `rollback <sha>` | 本地版本历史 / 回退记忆文件 |
| `/persona mine list` / `mine <id>` | 列可提炼的旧会话 / 提炼一段 → 全部进待审 |
| `/persona export [父目录]` | 导出记忆包到指定文件夹 |
| `/persona import-memory <格式> <文件>` | 从 dsh-auto-memory / dsh-mnemon / SurfCore / md / json 导入草稿 |

## 数据放在哪

全部在 `~/.dsh/persona/<persona>/`（只在本机，不联网）：

```
soul.md                 L0 身份内核（locked，人工改；插件只读）
relationship.md         L1 关系/偏好/边界/仪式/承诺/近况（markdown + ```yaml 条目块）
episodes/YYYY-MM.md     L2 情节卡
handoff/<工作区>.md     交接条（每个工作区一个，最新在上）
journal/YYYY-MM-DD.jsonl  每轮原始日记（WAL，不注入；保留 30 天）
review/queue.jsonl      审核队列
reports/                整理报告 / 周报 / 旧会话提炼报告
state.json              整理游标 / 上次整理 / 上次 curator
config.json             面板设置（可选）
MEMORY.md               渲染索引（只指针，不重复正文）
.git/                   本地版本库（journal、config、state 不入库）
```

工作区在 handoff 文件名里只出现「目录名 + 短哈希」，不写完整机器路径。

## 隐私与安全

- **不联网同步**，没有云服务；所有数据在本机 `~/.dsh/persona/`。
- 写入前统一脱敏：本机路径、常见密钥、邮箱、uid、验证码样式。
- 只记「关系/偏好/边界/仪式/承诺/情节」，不记工具调用流水、命令输出、网页原文、一次性闲聊。
- Soul 永不自动修改；关系类改动一律先过审核队列。
- 面板设置/整理/审核接口仅供同源本地面板使用，没有对外鉴权；不要把 DSH 的 Web 端口直接暴露到公网。
- 导出包可含个人记忆，请自行保管；导出不含 journal、账号、密钥。

## 开发与测试

```sh
node --test test/m1.test.mjs test/m15.test.mjs test/m2.test.mjs test/m3.test.mjs
```

## 已知限制

- 召回是关键词（中文 bigram），不是向量；同义改写召回弱。
- 整理衰减是按记忆类型的半衰期近似，不理解语义冲突。
- 旧会话提炼一次只处理一段，转录有长度上限；导入是「尽力解析」，复杂私有格式会漏。
- 跨机器迁移请用「导出记忆包」；`.git` 历史不会随包走。

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。

设计参考：SurfCore 的记忆卡/全量卡思路、`dsh-auto-memory` 的 consolidation 经验、`dsh-mnemon` 的可组合记忆空间；感谢评论区那些「每天打包备份」「给新鱼写复活 prompt」的养鱼人。
