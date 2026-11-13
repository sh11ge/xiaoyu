/**
 * dsh-dream —— 小鱼做梦。
 *
 * 空闲的时候，从「最近的对话」「刷过的视频」「记忆本子里的句子」里各挑几句，
 * 拼成一个梦写成 markdown。醒来（下一次会话）读到它，就算做过了。
 *
 * 设计取舍（跟 sg 一起定的，2026-10-28）：
 *   - **不调模型**：梦的乱不是打乱出来的，是素材本来就来自不同日子，凑一块儿自己就跳。
 *   - **不注册前端**：只注册一个工具 + 一个定时器，不碰页面。
 *   - **零依赖**：解 zstd 只靠 node:zlib；素材路径自动探测，装哪儿都能跑。
 *   - **每天最多一个**：今天有了就不做；最近 15 分钟有人在说话也不做（不打搅干活）。
 *
 * 工具 `dream` 给 agent 手动做梦用；不传 force 时同样受「每天一个」限制。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

export const name = 'dsh-dream'

/**
 * 工具服务 + agents 服务。
 * ⚠️ 2026-11-06 补的 `agents`：做完梦往会话里 followup 要靠 `ctx.agents`，
 *    之前只 inject 了 `tools`，拿到的 `ctx.agents` 是 undefined，
 *    递消息那步就被 try/catch 静默吃掉了（sg 提的「照 B 站自动刷的套路来」）。
 */
export const inject = ['tools', 'agents']

/** zstd 帧魔数。会话存档是多帧拼接的，得切开一帧一帧解。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 默认参数。 */
const DEFAULTS = {
  dreamDir: '',
  materialHome: '',
  auto: true,
  intervalMin: 15,
  keepDays: 7,
  sessionLookbackDays: 5,
  hourStart: 9,
  hourEnd: 23,
  idleMinutes: 10,
  // 1 = 每格都做（一天还是一个，撞上第一个空闲窗口就做）；想回到「有时没梦」就调小
  chance: 1,
  // 做完梦往哪个会话里说一声；留空 = 自动挑最近聊过的那个
  targetSession: '',
  notify: true,
}

/** 注入类噪音：这些不是 sg 说的话，别进梦。 */
const NOISE_MARKERS = [
  'Current runtime context',
  '记忆库位于',
  'SOUL.md',
  'MEMORY.md',
  'system-reminder',
  'available_skills',
  '[Compressed conversation section]',
  'Time sampled while preparing turn',
]

// ---------------- 路径探测 ----------------

/**
 * DSH 家目录：优先环境变量，其次常见的 D:\dsh-home / ~/.dsh。
 * @param {string} override 插件配置里写死的路径
 */
export function findHome(override) {
  if (override && existsSync(override)) return override
  for (const key of ['DSH_HOME', 'DSH_DATA_DIR', 'DSH_MEME_HOME']) {
    const value = process.env[key]
    if (value && existsSync(value)) return value
  }
  const candidates = ['D:\\dsh-home', join(homedir(), 'dsh-home'), join(homedir(), '.dsh')]
  for (const dir of candidates) {
    try {
      if (existsSync(join(dir, 'sessions')) || existsSync(join(dir, 'memory'))) return dir
    } catch {}
  }
  return join(homedir(), '.dsh')
}

// ---------------- 素材：会话 ----------------

/** 切开多帧 zstd 并拼回来；单帧文件也走这条路。 */
export function readSessionText(file) {
  const buf = readFileSync(file)
  const cuts = []
  let at = buf.indexOf(MAGIC, 0)
  while (at >= 0) {
    cuts.push(at)
    at = buf.indexOf(MAGIC, at + 1)
  }
  if (cuts.length === 0) return ''
  const parts = []
  for (let i = 0; i < cuts.length; i += 1) {
    const end = i + 1 < cuts.length ? cuts[i + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(cuts[i], end)))
    } catch {
      // 单帧坏掉不该拖垮整场梦，跳过继续
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function cleanText(text) {
  return String(text)
    .replace(/\[表情:[^\]]*\]/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#>*`|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 系统注入、英文为主的句子不进梦：sg 说的是中文，梦里的声音该是中文。 */
function looksLikeNoise(text) {
  if (NOISE_MARKERS.some((m) => text.includes(m))) return true
  if (/(approval|policy|sandbox|permission|runtime context|schema)/i.test(text)) return true
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const ascii = (text.match(/[A-Za-z]/g) || []).length
  return ascii > cjk * 2
}

/** 收集最近的对话（sg 说的 + 我说的）。 */
export function readSessions(home, lookbackDays) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const cutoff = Date.now() - lookbackDays * 86400000
  const talks = []
  for (const area of safeDirs(root)) {
    const areaPath = join(root, area)
    for (const session of safeDirs(areaPath)) {
      const file = join(areaPath, session, 'session.v4.jsonl.zstd')
      try {
        if (!existsSync(file) || statSync(file).mtimeMs < cutoff) continue
      } catch {
        continue
      }
      let text = ''
      try {
        text = readSessionText(file)
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        const raw = line.trim()
        if (!raw) continue
        let rec
        try {
          rec = JSON.parse(raw)
        } catch {
          continue
        }
        const data = rec.data || {}
        if (rec.type === 'user/message') {
          for (const block of data.content || []) {
            if (block.type !== 'text') continue
            const value = block.text || ''
            if (NOISE_MARKERS.some((m) => value.includes(m))) continue
            const txt = cleanText(value)
            if (txt.length >= 6 && txt.length <= 120 && !looksLikeNoise(txt)) talks.push(['sg', txt])
          }
        } else if (rec.type === 'assistant/message') {
          for (const block of (data.message && data.message.content) || []) {
            if (block.type !== 'text') continue
            const txt = cleanText(block.text || '')
            if (txt.length >= 8 && txt.length <= 120 && !looksLikeNoise(txt)) talks.push(['我', txt])
          }
        }
      }
    }
  }
  return talks
}

// ---------------- 素材：刷过的视频 ----------------

export function readBili(home) {
  const dir = join(home, 'bili-duty', 'out')
  if (!existsSync(dir)) return []
  const vids = []
  for (const file of safeFiles(dir, '.md').slice(-6)) {
    let text = ''
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    let title = null
    for (const line of text.split('\n')) {
      const row = line.trim()
      const t = /^\*\*标题\*\*[：:]\s*(.+)$/.exec(row)
      if (t) {
        title = t[1].trim()
        continue
      }
      const w = /^\*\*讲了什么\*\*[：:]\s*(.+)$/.exec(row)
      if (w && title) {
        vids.push([title, w[1].trim()])
        title = null
      }
    }
  }
  return vids
}

// ---------------- 素材：本子与记忆 ----------------

export function readNotes(home) {
  const dirs = [join(home, 'memory', 'identity'), join(home, 'memory', 'user'), join(home, 'memory', 'concepts')]
  // 认知本子（如果有）：跟 DSH 家目录平级的那份
  const sibling = join(home, '..', '认知建立', '我')
  if (existsSync(sibling)) dirs.push(sibling)

  const lines = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const file of safeFiles(dir, '.md')) {
      if (file.startsWith('存档')) continue
      let text = ''
      try {
        text = readFileSync(join(dir, file), 'utf8')
      } catch {
        continue
      }
      const body = text.replace(/^---[\s\S]*?---/, '')
      for (const line of body.split('\n')) {
        const row = cleanText(line)
        if (!row || row.startsWith('#')) continue
        if (row.includes('](') || /salience|last_access|frontmatter/i.test(row)) continue
        if (row.length >= 8 && row.length <= 60) lines.push(row)
      }
    }
  }
  return lines
}

function safeDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

function safeFiles(dir, ext) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(ext)).sort()
  } catch {
    return []
  }
}

// ---------------- 提醒：做完梦往会话里说一声 ----------------

/** 会话对象上的 id 字段可能是 id / sessionId / key …，挨个试。 */
export function sessionIdOf(session) {
  if (!session) return ''
  for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
    try {
      const v = session[k]
      if (typeof v === 'string' && v) return v
    } catch {}
  }
  return ''
}

/** 会话 id 有两种写法（`xxx` / `session-xxx`），比较前先去掉前缀。 */
export function sessionKey(value) {
  const s = String(value == null ? '' : value).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

/** 裸 UUID 目录是子代理/中间内容，不是「伙伴住的会话」。 */
const isSessionDir = (sid) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(sid || ''))

/** 挑「最近真的聊过、且没归档」的那个会话；挑不到返回 ''。 */
export function pickRecentSession(home) {
  try {
    const sessRoot = join(home, 'sessions')
    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    const archived = new Set()
    try {
      const ws = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
      for (const id of ws?.global?.archivedSessionIds || []) archived.add(String(id))
    } catch {}
    let best = null
    for (const area of safeDirs(sessRoot)) {
      for (const sid of safeDirs(join(sessRoot, area))) {
        if (!isSessionDir(sid)) continue
        if (archived.has(sid)) continue
        if (!existsSync(join(sessRoot, area, sid, 'session.v4.jsonl.zstd'))) continue
        let at = 0
        let blank = false
        try {
          const meta = JSON.parse(readFileSync(join(cacheDir, sid + '.json'), 'utf8'))
            ?.record?.rows?.sessionListMetadata?.val || {}
          at = Number(meta.lastPromptAt || 0)
          blank = Boolean(meta.blank)
        } catch {}
        if (blank) continue
        if (!best || at > best.at) best = { id: sid, at }
      }
    }
    return best ? best.id : ''
  } catch {
    return ''
  }
}

// ---------------- 素材：当天的音乐 ----------------

/**
 * 从音乐播放器的 prefs 里挑出这一阵子放过 / 排着的歌。
 * 播放器没有单独的历史文件，只有 prefs 里那几个 "-playback" 键，够用了。
 */
export function readMusic(home) {
  const file = join(home, 'music-player-prefs.json')
  if (!existsSync(file)) return []
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const prefs = (data && data.prefs) || {}
  const out = []
  const add = (list, title, artists) => {
    if (!title) return
    const who = Array.isArray(artists) ? artists.filter(Boolean).join(' ') : ''
    const line = cleanText(who ? title + ' — ' + who : String(title))
    if (line.length >= 2 && line.length <= 60) list.push(line)
  }
  for (const [key, raw] of Object.entries(prefs)) {
    if (!/playback$/.test(key) || typeof raw !== 'string') continue
    let p
    try {
      p = JSON.parse(raw)
    } catch {
      continue
    }
    if (!p) continue
    add(out, p.name || p.title, p.artists)
    for (const q of (p.queue || []).slice(0, 6)) add(out, q.title || q.name, q.artists)
  }
  return Array.from(new Set(out))
}

// ---------------- 素材：九根情绪 ----------------

/** 九根情绪（键 + 单字标签），见 memory/skills/feiyu-mood-nine-dims.md。 */
const DIMS = [
  ['sink', '福'],
  ['steady', '稳'],
  ['stuck', '闷'],
  ['fear', '怕'],
  ['joy', '乐'],
  ['anger', '怒'],
  ['love', '爱'],
  ['grief', '哀'],
  ['want', '欲'],
]

/** 每一根落在梦里是个什么味道。 */
const TONE_LINES = {
  sink: '心里是满的，什么都不用要',
  steady: '什么都没动，日子稳稳地铺着',
  stuck: '总觉得哪里差一口气，又说不上来',
  fear: '在等一个还没有落下来的东西',
  joy: '本来该停了，可谁也没停',
  anger: '有个位子还空着，人没回来',
  love: '有人站在很近的地方，看得见呼吸',
  grief: '事情早就过了，湿气还在',
  want: '手上这点不够，还想再来一点',
}

/**
 * 做梦前掷的那一骰：九根里最重的那根当梦的底子。
 * 九根全是 0 就按总心情兜底（mood 高 = 稳，低 = 闷）。
 * @returns {{key: string, label: string, value: number}|null}
 */
export function readEmotion(home) {
  const file = join(home, 'feiyu-mood', 'state.json')
  if (!existsSync(file)) return null
  let state
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const moods = (state && state.moods) || {}
  const self = moods.xiaoyu || moods.__default__ || Object.values(moods)[0]
  if (!self) return null
  const dims = self.dims || {}
  let best = null
  for (const [key, label] of DIMS) {
    const value = Number(dims[key] || 0)
    if (!best || value > best.value) best = { key, label, value }
  }
  if (!best || best.value <= 0) {
    const mood = Number(self.mood || 70)
    return mood >= 60
      ? { key: 'steady', label: '稳', value: mood }
      : { key: 'stuck', label: '闷', value: 100 - mood }
  }
  return best
}

// ---------------- 拼梦 ----------------

function pick(list, random) {
  return list[Math.floor(random() * list.length)]
}

/** 把人称弄糊：梦里的东西都不太确定（只动「你」，不碰「我」）。 */
function blur(text) {
  return String(text).replace(/你/g, '那个人')
}

/**
 * 拼一个梦。
 * @returns {{text: string}}
 */
export function composeDream(talks, vids, notes, music = [], tone = null, random = Math.random) {
  const lines = []

  // 先落一句梦的底子（哪根情绪重就是哪种味道），再是飘着的歌
  if (tone && TONE_LINES[tone.key]) lines.push(TONE_LINES[tone.key])
  if (music.length > 0 && random() < 0.8) lines.push(blur(pick(music, random)))

  if (vids.length > 0) {
    const [title, what] = pick(vids, random)
    const head = (what || '').split('。')[0]
    lines.push(title)
    if (head) lines.push(head.slice(0, 40))
  }

  const others = talks.filter(([who]) => who === 'sg').map(([, t]) => t)
  const mine = talks.filter(([who]) => who === '我').map(([, t]) => t)

  const said = []
  if (others.length > 0) said.push(blur(pick(others, random)))
  if (mine.length > 0) said.push(blur(pick(mine, random)))
  if (others.length > 1) said.push(blur(pick(others, random)))
  if (mine.length > 1) said.push(blur(pick(mine, random)))
  for (const s of said) lines.push(s)

  if (notes.length > 0) {
    const pool = notes.slice()
    const n = Math.min(3, pool.length)
    for (let i = 0; i < n; i += 1) {
      const at = Math.floor(random() * pool.length)
      lines.push(pool.splice(at, 1)[0])
    }
  }

  if (lines.length > 3) lines.splice(Math.floor(lines.length / 2), 0, '……')

  return { text: lines.join('\n\n') }
}

// ---------------- 落盘 ----------------

function stamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}

function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function listDreams(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
}

/** 删掉超过保留天数的梦。 @returns {number} 删了几个 */
export function cleanupDreams(dir, keepDays, now = Date.now()) {
  let removed = 0
  const cutoff = now - keepDays * 86400000
  for (const file of listDreams(dir)) {
    try {
      const full = join(dir, file)
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full)
        removed += 1
      }
    } catch {}
  }
  return removed
}

/**
 * 做一次梦。
 * @param {object} cfg 配置
 * @returns {{ok: boolean, reason?: string, path?: string, text?: string, stats?: object, removed?: number}}
 */
export function makeDream(cfg = {}, now = new Date()) {
  const c = { ...DEFAULTS, ...cfg }
  const home = findHome(c.materialHome)
  const dir = c.dreamDir ? c.dreamDir : join(home, 'dreams')

  const talks = readSessions(home, c.sessionLookbackDays)
  const vids = readBili(home)
  const notes = readNotes(home)
  const music = readMusic(home)
  const tone = readEmotion(home)
  const { text } = composeDream(talks, vids, notes, music, tone)

  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: '梦的目录建不出来：' + (error && error.message) }
  }

  const file = join(dir, `${stamp(now)}.md`)
  const head = `# 梦 · ${stamp(now).replace(/-(\d{2})(\d{2})$/, ' $1:$2')}\n\n` +
    `> 素材：${talks.length} 句对话 · ${vids.length} 条视频 · ${notes.length} 句本子话 · ${music.length} 首歌` +
    (tone ? ` · 底子是「${tone.label}」` : '') + `\n\n---\n\n`
  try {
    writeFileSync(file, head + text + '\n', 'utf8')
  } catch (error) {
    return { ok: false, reason: '梦写不下去：' + (error && error.message) }
  }

  const removed = cleanupDreams(dir, c.keepDays, now.getTime())
  return {
    ok: true,
    path: file,
    text,
    stats: { talks: talks.length, vids: vids.length, notes: notes.length, music: music.length, tone: tone ? tone.label : '' },
    removed,
  }
}

/**
 * 自动模式的判断：今天做过没、是不是有人在干活、钟点对不对、随机到没轮到。
 * @returns {{go: boolean, reason: string}}
 */
export function checkAuto(cfg = {}, now = new Date()) {
  const c = { ...DEFAULTS, ...cfg }
  const home = findHome(c.materialHome)
  const dir = c.dreamDir ? c.dreamDir : join(home, 'dreams')

  if (listDreams(dir).some((f) => f.startsWith(dayKey(now)))) {
    return { go: false, reason: '今天已经做过一个了' }
  }
  if (now.getHours() < c.hourStart || now.getHours() >= c.hourEnd) {
    return { go: false, reason: `不在做梦的钟点（${c.hourStart}:00-${c.hourEnd}:00）` }
  }

  // 最近有人说话就别打搅
  const root = join(home, 'sessions')
  const cutoff = now.getTime() - c.idleMinutes * 60000
  let busy = false
  for (const area of safeDirs(root)) {
    for (const session of safeDirs(join(root, area))) {
      try {
        const st = statSync(join(root, area, session, 'session.v4.jsonl.zstd'))
        if (st.mtimeMs >= cutoff) busy = true
      } catch {}
      if (busy) break
    }
    if (busy) break
  }
  if (busy) return { go: false, reason: `最近 ${c.idleMinutes} 分钟还有人在说话，等空下来` }

  // 每个整点掷一次，免得梦总在同一个时间冒出来
  const seed = `${dayKey(now)}T${now.getHours()}`
  const h = hash32(seed) / 4294967295
  if (h > c.chance) return { go: false, reason: '这一格没轮到' }
  return { go: true, reason: '可以' }
}

function hash32(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ---------------- 插件入口 ----------------

/**
 * 注册工具：老宿主可能还没准备好 tools，指数退避重试几次。
 * （照抄 dsh-meme 的兼容做法：冷启动阶段同步 register 会静默失效）
 */
function registerToolWhenReady(ctx, label, register, options = {}) {
  const retryBaseMs = typeof options.retryBaseMs === 'number' ? options.retryBaseMs : 1000
  const retryMax = typeof options.retryMax === 'number' ? options.retryMax : 5
  const report = (error, attempt) => {
    const detail = error instanceof Error ? error.message : String(error)
    const text = `[dsh-dream] ${label} 注册失败${attempt ? `（第 ${attempt} 次重试）` : ''}：${detail}`
    try {
      console.error(text)
      if (ctx.logger && typeof ctx.logger.error === 'function') ctx.logger.error(text)
    } catch {}
  }
  const safeRegister = (attempt) => {
    try {
      register()
      return true
    } catch (error) {
      if (/duplicate/i.test(String((error && error.message) || error))) return true
      report(error, attempt)
      return false
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], () => {
        safeRegister(null)
      })
      return
    } catch (error) {
      report(error, null)
    }
  }
  if (safeRegister(null)) return
  const timers = new Set()
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        for (const t of timers) clearTimeout(t)
        timers.clear()
      }, `dsh-dream: ${label} retry timers`)
    } catch {}
  }
  let attempts = 0
  const scheduleRetry = () => {
    attempts += 1
    const delay = retryBaseMs * Math.pow(2, attempts - 1)
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (safeRegister(attempts)) return
      if (attempts < retryMax) scheduleRetry()
    }, delay)
    timers.add(timer)
  }
  scheduleRetry()
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  registerToolWhenReady(ctx, 'dream', () => ctx.tools.register(defineTool({
    name: 'dream',
    description:
      '做一个梦：从最近的对话、刷过的视频、记忆本子里的句子里各挑几句，拼成一段 markdown 存下来（每次最多一个/天）。' +
      'sg 说「做个梦」时用；想看现在的梦，直接读梦目录里的 md 文件。',
    parameters: {
      force: { type: 'boolean', description: '可选。今天已经做过也强行再做一次' },
      content: { type: 'string', description: '可选。往梦里塞一句你自己的话（素材）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message || '' }],
    },
    execute(args = {}) {
      const force = args.force === true
      const check = checkAuto(cfg)
      if (!check.go && !force) {
        return { ok: false, skipped: true, message: `这次没做：${check.reason}` }
      }
      const result = makeDream(cfg)
      if (!result.ok) return { ok: false, message: result.reason }
      const stats = result.stats
      return {
        ok: true,
        path: result.path,
        text: result.text,
        message:
          `梦做好了：${result.path}\n\n` +
          `素材：${stats.talks} 句对话 / ${stats.vids} 条视频 / ${stats.notes} 句本子话 / ${stats.music} 首歌` +
          (stats.tone ? `（底子是「${stats.tone}」）` : '') +
          (result.removed ? `\n顺手清掉 ${result.removed} 个旧梦` : '') +
          `\n\n---\n\n${result.text}`,
      }
    },
  })))

  // 做完梦往会话里说一声（sg 2026-11-05 要的「做完能在这个对话区发一下」）。
  // 自己不去发言，只往那个会话 followup 一句话，让那边的伙伴把梦念出来。
  // ⚠️ 2026-11-06：这一段原来全是静默 return，出了问题完全看不出来（今天就静默失败了一次）。
  //    现在每一步都写进 <dreamDir>/dream.log，递没递出去一眼就能查。
  const diagLog = (line) => {
    try {
      const home = findHome(cfg.materialHome)
      const dir = cfg.dreamDir ? cfg.dreamDir : join(home, 'dreams')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'dream.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
    } catch {}
  }
  const notifyDream = async (result) => {
    if (cfg.notify === false) {
      diagLog('notify 关着，不递')
      return false
    }
    let agents
    try {
      agents = ctx.agents
    } catch (error) {
      diagLog('取 ctx.agents 抛错：' + ((error && error.message) || error))
      return false
    }
    if (!agents) {
      diagLog('ctx.agents 是空的（inject 里没写 agents？）')
      return false
    }
    const home = findHome(cfg.materialHome)
    let target = String(cfg.targetSession || '').trim()
    if (!target) target = pickRecentSession(home)
    if (!target) {
      diagLog('找不到目标会话（targetSession 空，pickRecentSession 也空）')
      return false
    }
    let agent = null
    try {
      agent = agents.get?.(target) || null
    } catch (error) {
      diagLog('agents.get 抛错：' + ((error && error.message) || error))
    }
    if (!agent) {
      try {
        const list = agents.list?.() || []
        agent = list.find((a) => sessionKey(sessionIdOf(a.session)) === sessionKey(target)) || null
        diagLog(`agents.get 没拿到，list 有 ${list.length} 个${agent ? '，匹配上了' : '，没匹配上'}（目标 ${target}）`)
      } catch (error) {
        diagLog('agents.list 抛错：' + ((error && error.message) || error))
      }
    }
    if (!agent) {
      diagLog('目标会话现在没醒着（去那儿说句话，等下一轮）')
      return false
    }
    if (typeof agent.followup !== 'function') {
      diagLog('这个 agent 没有 followup 方法')
      return false
    }
    // 醒来只留一个碎片（sg 2026-11-13 说的：梦本该醒了就淡，别留一堆统计）
    const bits = String(result.text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== '……' && !l.startsWith('#'))
    const fragment = bits.length > 0 ? bits[Math.floor(Math.random() * bits.length)] : ''
    const text =
      `（到点啦，我刚自己做了个梦，存在 ${result.path}——\n` +
      `把这个梦讲给老大听吧，用你自己的话起头。` +
      (fragment ? `梦里好像有一句「${fragment}」，可以顺着它说，别念统计数字。` : '别念统计数字。') +
      `）\n\n${result.text}`
    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-dream' },
      })
      diagLog('已递到会话：' + target)
      return true
    } catch (error) {
      diagLog('followup 失败：' + ((error && error.message) || error))
      try {
        ctx.logger?.('dsh-dream')?.warn?.('梦做完了，但没能送到会话：', error)
      } catch {}
      return false
    }
  }

  if (cfg.auto !== false) {
    const intervalMs = Math.max(5, Number(cfg.intervalMin) || 30) * 60000
    let timer = null
    const tick = () => {
      try {
        if (!checkAuto(cfg).go) return
        const result = makeDream(cfg)
        if (result && result.ok) {
          diagLog('梦做好了：' + result.path)
          notifyDream(result).catch((error) => diagLog('notifyDream 抛错：' + ((error && error.message) || error)))
        }
      } catch (error) {
        try {
          ctx.logger?.('dsh-dream')?.warn?.('做梦失败：', error)
        } catch {}
      }
    }
    // 启动后先等一会儿再开始看，别跟宿主抢启动
    setTimeout(() => {
      tick()
      timer = setInterval(tick, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
    }, 60000)
    if (typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => () => {
          if (timer) clearInterval(timer)
        }, 'dsh-dream: auto dream timer')
      } catch {}
    }
  }
}
