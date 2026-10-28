# dsh-dream —— 让 agent 做梦

空闲的时候，从**最近的对话**、**刷过的视频**、**记忆本子里的句子**里各挑几句，拼成一个梦写成 markdown 存下来。

醒来（下一次会话）读到它，就算做过了。

> 梦的乱不是打乱出来的——素材本来就来自不同的日子，凑一块儿自己就跳。

## 它会做什么

- 每隔 30 分钟看一眼，同时满足这些才做一个梦：
  - 今天还没做过（每天最多一个）
  - 最近 15 分钟没人在说话（不打搅干活）
  - 在 9:00–23:00 之间
  - 每个整点掷一次硬币，一半概率
- 梦存在 `<DSH 家目录>/dreams/YYYY-MM-DD-HHMM.md`（可用 `dreamDir` 改）
- 超过 7 天的梦自动删掉（可用 `keepDays` 改）
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
        intervalMin: 30
        keepDays: 7
```

装完**重启 DSH** 生效。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `auto` | `true` | 关掉就只留 `dream` 工具，不再自动做梦 |
| `intervalMin` | `30` | 多久检查一次（分钟） |
| `keepDays` | `7` | 梦留几天 |
| `dreamDir` | `<家目录>/dreams` | 梦存哪儿 |
| `materialHome` | 自动探测 | 素材（sessions / memory / bili-duty）在哪儿 |
| `hourStart` / `hourEnd` | `9` / `23` | 只在这个钟点做梦 |
| `idleMinutes` | `15` | 最近这么久有人说话就不做 |
| `chance` | `0.5` | 每个整点掷硬币的概率 |

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

## License

MIT
