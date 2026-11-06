# dsh-dream —— 让 agent 做梦

空闲的时候，从**最近的对话**、**刷过的视频**、**记忆本子里的句子**里各挑几句，拼成一个梦写成 markdown 存下来。

醒来（下一次会话）读到它，就算做过了。

> 梦的乱不是打乱出来的——素材本来就来自不同的日子，凑一块儿自己就跳。

## 它会做什么

- 每隔 15 分钟看一眼，同时满足这些才做一个梦：
  - 今天还没做过（每天最多一个）
  - 最近 10 分钟没人在说话（不打搅干活）
  - 在 9:00–23:00 之间
- 梦存在 `<DSH 家目录>/dreams/YYYY-MM-DD-HHMM.md`（可用 `dreamDir` 改）
- 超过 7 天的梦自动删掉（可用 `keepDays` 改）
- **做完会回话**：梦一落盘，就往你最近聊过的那个会话里递一句「到点啦，我刚自己做了个梦…」，让那边的 agent 自己开口讲给你听
- **递没递出去都有记录**：每一步都写进 `<dreamDir>/dream.log`（拿不到 agents、找不到会话、followup 报错，都能查）
- 注册一个 `dream` 工具，想让 agent 立刻睡一觉，说「做个梦」就行

## 装

**从 GitHub（推荐）**

```bash
git clone <仓库地址> dsh-dream
cp -r dsh-dream "$HOME/dsh-home/profiles/desktop/node_modules/dsh-dream"
```

Win 上家目录一般是 `D:\dsh-home`，macOS / Linux 是 `~/.dsh`，按你自己的来。

**手动**

把整个目录放进 `profiles/desktop/node_modules/dsh-dream`，再在 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-dream
      name: dsh-dream
      config:
        auto: true
        intervalMin: 15
        keepDays: 7
```

装完**重启 DSH** 生效。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `auto` | `true` | 关掉就只留 `dream` 工具，不再自动做梦 |
| `intervalMin` | `15` | 多久检查一次（分钟） |
| `keepDays` | `7` | 梦留几天 |
| `dreamDir` | `<家目录>/dreams` | 梦存哪儿 |
| `materialHome` | 自动探测 | 素材（sessions / memory / bili-duty）在哪儿 |
| `hourStart` / `hourEnd` | `9` / `23` | 只在这个钟点做梦 |
| `idleMinutes` | `10` | 最近这么久有人说话就不做 |
| `chance` | `1` | 每个整点掷硬币的概率，`1` = 每格都做（一天仍只做一个） |
| `notify` | `true` | 做完往会话里说一声（followup） |
| `targetSession` | `''` | 说给哪个会话；留空 = 自动挑最近聊过的那个 |

## 素材从哪儿来

- `sessions/*/*/session.v4.jsonl.zstd` —— 最近的对话（多帧 zstd，按魔数切帧解压）
- `bili-duty/out/*.md` —— 刷过的视频日报（标题 + 讲了什么）
- `memory/identity|user|concepts/*.md` —— 记忆本子里的句子
- 顺带：跟家目录平级的 `认知建立/我/` 也会读（有的话）

## 梦长什么样

```markdown
# 梦 · 2026-10-28 16:21

> 素材：384 句对话 · 3 条视频 · 172 句本子话

---

我在看一条视频，标题是「大肥鱼单曲 - Let Me Go 动画PV」。

那个人的声音又来了：「小鱼，往群里@……」

我说：「嗯，这个我该改，光顾着馋了，没往下问。」。说完发现没人接。

……然后画面就跳了。

不知道从哪儿浮上来一句：「辣 舌头——没有。换成"急"，说话变快、想喝水」

我就在那儿等，等它再往下走一点。
```

## 零依赖

解 zstd 只用 `node:zlib`（Node 22.15+ 的 `zstdDecompressSync`），不需要装任何第三方包，也不需要 Python。

## 更新日志

### 0.1.3

- **修好「做完梦不回话」**：之前插件只声明依赖 `tools`，拿不到 `agents` 服务，递消息那一步是静默失败的。现在 `inject` 里补上了 `agents`，回话才真的能送到会话里。
- **递进去的话改了写法**：不再是一句陈述，而是一句「到点啦，我刚自己做了个梦，存在 …——把这个梦讲给老大听吧，用你自己的话起头，别念统计数字」，跟刷 B 站那套自动触发一个路子。
- **不再静默失败**：每一步都往 `<dreamDir>/dream.log` 写一行（拿不到 agents / 找不到会话 / list 没匹配上 / followup 报错……都记），出问题一眼能查。

### 0.1.2

- **做完梦会回来报一声**：梦写完之后，插件会往你最近聊过的那个会话递一条 followup（形如「〔梦醒了〕刚才自己做了个梦，存在 …」+ 梦正文），让 agent 自己开口把梦讲给你听，不用你去翻目录。想指定会话就填 `targetSession`，不想要就 `notify: false`。
- 自动做梦的门槛在 0.1.1 已经放宽（15 分钟一查、静默 10 分钟、`chance` 1），这一版把默认值和文档对齐写清楚。
- 顺手删掉了误存进仓库的一份梦文件（本来只该落在 `dreamDir` 里）。

### 0.1.1

- 提高自动做梦的概率（`chance` 1、15 分钟一查、10 分钟静默）。

### 0.1.0

- 第一版：空闲时从对话 / 视频 / 记忆里拼一个梦，存成 markdown，7 天后自动清。

## License

MIT
