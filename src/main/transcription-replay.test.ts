import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptionSpeaker } from '../preload/contracts'
import fixture from './__fixtures__/volcengine-mock-interview.json'
import {
  AUTO_REPLY_MIN_CHARACTERS,
  AutoReplyTurn,
  shouldTriggerAutoReply,
  spokenContent
} from './transcription-auto-reply'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const sockets = vi.hoisted(() => [] as { emit: (event: string, ...args: unknown[]) => void }[])

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeSocket extends EventEmitter {
    static CONNECTING = 0
    static OPEN = 1
    readyState = 1
    constructor() {
      super()
      sockets.push(this)
    }
    send(_data: unknown, callback?: (error?: Error) => void) {
      callback?.()
    }
    close() {
      this.readyState = 3
    }
    terminate() {
      this.readyState = 3
    }
  }
  return { default: FakeSocket }
})

vi.mock('./transcription-timeline', () => ({ logTimeline: () => {} }))

type Utterance = { text: string; definite: boolean }
type Transcription = typeof import('./transcription')

const VOLCENGINE_CONFIG = {
  provider: 'volcengine',
  apiKey: 'test-key',
  model: 'bigmodel',
  resourceId: 'volc.bigasr.sauc.duration',
  wsUrl: 'wss://asr.example.test/api'
}

/** Server response frame: full-response type, gzip JSON, final flag on the last packet */
function volcengineFrame(utterances: Utterance[], final: boolean): Buffer {
  const payload = {
    result: {
      text: utterances.map((utterance) => utterance.text).join(''),
      utterances
    }
  }
  const body = gzipSync(Buffer.from(JSON.stringify(payload)))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length)
  return Buffer.concat([Buffer.from([0x11, 0x90 | (final ? 0x02 : 0x00), 0x11, 0x00]), size, body])
}

/** The recording stores only utterances that changed; rebuild the full list per frame */
function recordedFrames(): { t: number; final: boolean; utterances: Utterance[] }[] {
  const known: Utterance[] = []
  return fixture.frames.map((frame) => {
    for (const [index, utterance] of Object.entries(frame.changed)) {
      known[Number(index)] = utterance
    }
    return { t: frame.t, final: frame.final, utterances: known.slice(0, frame.count) }
  })
}

const finalTranscript = recordedFrames()
  .at(-1)!
  .utterances.map((utterance) => utterance.text)
  .join('')

function normalize(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

function count(text: string, phrase: string): number {
  return text.split(phrase).length - 1
}

async function loadTranscription(): Promise<Transcription> {
  vi.resetModules()
  handlers.clear()
  sockets.length = 0
  return import('./transcription')
}

/** Same steps as the chat auto reply (assistant/chat.ts), minus the chat stream itself */
function collectAutoReplies(transcription: Transcription): string[] {
  const asks = (speaker?: TranscriptionSpeaker | null) => shouldTriggerAutoReply(speaker, undefined)
  const requests: string[] = []
  const turn: AutoReplyTurn = new AutoReplyTurn({
    transcript: {
      pending: transcription.getConfirmedTranscriptionLines,
      take: transcription.consumeConfirmedTranscriptionText
    },
    asks,
    onSettled: () => {
      const request = turn.pendingRequest
      if (!request) {
        turn.discardUnanswered()
        return
      }
      turn.markSent(request)
      requests.push(request.text)
    }
  })
  transcription.subscribeTranscription((event) => {
    if (!asks(event.speaker)) return
    if (event.isPartial) turn.touch(event.utterance ?? '')
    else turn.hear()
  })
  return requests
}

/** Plays the recorded frames through the real provider handler on the recorded timeline */
function replay(): void {
  handlers.get('start-transcription')!({}, VOLCENGINE_CONFIG, 'replay-run', undefined)
  const socket = sockets.at(-1)!
  socket.emit('open')
  let now = 0
  for (const frame of recordedFrames()) {
    vi.advanceTimersByTime(frame.t - now)
    now = frame.t
    socket.emit('message', volcengineFrame(frame.utterances, frame.final))
  }
  vi.advanceTimersByTime(10_000)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Volcengine replay of the scripted mock interview', () => {
  it('hands every spoken character to auto replies once', async () => {
    const transcription = await loadTranscription()
    const consumed: string[] = []
    transcription.subscribeTranscription((event) => {
      if (event.isPartial) return
      const text = transcription.consumeConfirmedTranscriptionText()
      if (text.trim()) consumed.push(text)
    })

    replay()

    const sent = consumed.join('')
    // Revisions (e.g. "BO3" corrected to "Vue 3") may shift a few characters, never whole sentences
    expect(normalize(sent).length).toBeGreaterThan(normalize(finalTranscript).length * 0.95)
    expect(normalize(sent).length).toBeLessThan(normalize(finalTranscript).length * 1.05)
    expect(count(sent, '欢迎参加今天的面试')).toBe(1)
    expect(count(sent, '有什么区别')).toBe(1)
    expect(count(sent, '怎么减少回流')).toBe(1)
    expect(count(sent, '好在哪里')).toBe(1)
    expect(count(sent, '优化方案')).toBe(1)
  })

  it('asks each question as one whole turn, without fragments or earlier turns', async () => {
    const transcription = await loadTranscription()
    const requests = collectAutoReplies(transcription)

    replay()

    const lastAsking = (phrase: string) => requests.findLast((request) => request.includes(phrase))
    expect(lastAsking('先简单做个自我介绍')).toContain('欢迎参加今天的面试')
    expect(lastAsking('有什么区别')).toContain('你说说浏览器的重绘和回流')
    expect(lastAsking('怎么减少回流')).toContain('这个我了解了')
    // The partial still reads "不三的响应是原理" when the speaker pauses; its start marks the turn
    expect(lastAsking('好在哪里')).toContain('下一个问题')
    expect(lastAsking('优化方案')).toContain('最后一道场景题')

    // Volcengine repeats unchanged results while nobody speaks; that is not speech keeping a turn open
    expect(
      requests.some((request) => request.includes('我叫张三') && request.includes('聊聊前端性能'))
    ).toBe(false)
    for (const request of requests) {
      expect(request).not.toMatch(/^[\p{P}\s]/u)
      expect(spokenContent(request).length).toBeGreaterThanOrEqual(AUTO_REPLY_MIN_CHARACTERS)
      // A turn never carries an earlier question along
      expect(count(request, '？') + count(request, '吧。')).toBeLessThanOrEqual(2)
    }
    expect(
      requests.some((request) => request.includes('欢迎参加') && request.includes('回流'))
    ).toBe(false)
    // The lone "对" between two questions is dropped, not glued to the next one
    expect(requests.some((request) => request.startsWith('对'))).toBe(false)
  })

  it('stops listening before the provider delivers the last result', async () => {
    const transcription = await loadTranscription()
    handlers.get('start-transcription')!({}, VOLCENGINE_CONFIG, 'stop-run', undefined)
    sockets.at(-1)!.emit('open')
    expect(transcription.isTranscriptionListening()).toBe(true)

    void handlers.get('stop-transcription')!()

    expect(transcription.isTranscriptionListening()).toBe(false)
  })
})

const DASHSCOPE_CONFIG = {
  provider: 'dashscope',
  apiKey: 'test-key',
  model: 'fun-asr-realtime',
  wsUrl: 'wss://asr.example.test/api-ws/v1/inference/'
}

type Socket = (typeof sockets)[number]

/** Starts a DashScope run; mixed capture connects the interviewer (system) first, then me */
function startDashScope(channels?: string[]): Socket[] {
  handlers.get('start-transcription')!({}, DASHSCOPE_CONFIG, 'dashscope-run', channels)
  for (const socket of sockets) {
    socket.emit('open')
    socket.emit('message', JSON.stringify({ header: { event: 'task-started' } }))
  }
  return [...sockets]
}

/** A DashScope result: words still being spoken, or a finished sentence */
function say(socket: Socket, text: string, sentenceEnd = true): void {
  socket.emit(
    'message',
    JSON.stringify({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text, sentence_end: sentenceEnd } } }
    })
  )
}

describe('DashScope voice auto reply', () => {
  it('ignores noise in the silence after a question', async () => {
    const transcription = await loadTranscription()
    const requests = collectAutoReplies(transcription)
    const [socket] = startDashScope()

    say(socket, '你说说重绘和回流有什么区别', false)
    vi.advanceTimersByTime(400)
    say(socket, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(2000)
    say(socket, '啊', false)
    vi.advanceTimersByTime(1600)
    say(socket, '？')
    vi.advanceTimersByTime(1000)
    say(socket, '嗯', false)
    vi.advanceTimersByTime(600)
    say(socket, '嗯。')
    vi.advanceTimersByTime(1500)
    say(socket, '阿', false)
    vi.advanceTimersByTime(1600)
    say(socket, '啊？')
    vi.advanceTimersByTime(5000)

    // Any later request would interrupt the answer being written
    expect(requests).toEqual(['你说说重绘和回流有什么区别？'])
  })

  it('answers on time while noise follows the question', async () => {
    const transcription = await loadTranscription()
    const requests = collectAutoReplies(transcription)
    const [socket] = startDashScope()

    say(socket, '你说说重绘和回流有什么区别', false)
    vi.advanceTimersByTime(400)
    say(socket, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(300)
    say(socket, '啊', false)
    vi.advanceTimersByTime(500)
    expect(requests).toEqual(['你说说重绘和回流有什么区别？'])

    for (let count = 2; count <= 20; count++) {
      say(socket, '啊'.repeat(count), false)
      vi.advanceTimersByTime(500)
    }
    vi.advanceTimersByTime(5000)
    expect(requests).toEqual(['你说说重绘和回流有什么区别？'])
  })

  it('does not answer my own words when the interviewer only backchannels', async () => {
    const transcription = await loadTranscription()
    const requests = collectAutoReplies(transcription)
    const [interviewer, me] = startDashScope(['system', 'microphone'])

    say(interviewer, '你说说重绘和回流有什么区别', false)
    vi.advanceTimersByTime(400)
    say(interviewer, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(4000)
    say(me, '回流是指元素的几何属性发生变化', false)
    vi.advanceTimersByTime(400)
    say(me, '回流是指元素的几何属性发生变化，浏览器需要重新计算布局。')
    vi.advanceTimersByTime(300)
    say(interviewer, '嗯。')
    vi.advanceTimersByTime(500)
    say(me, '重绘只是外观变化。')
    vi.advanceTimersByTime(300)
    say(interviewer, '？')
    vi.advanceTimersByTime(5000)

    expect(requests).toEqual(['面试官：你说说重绘和回流有什么区别？'])

    say(interviewer, '那你说说怎么减少回流？')
    vi.advanceTimersByTime(5000)

    expect(requests.at(-1)).toBe(
      '我：回流是指元素的几何属性发生变化，浏览器需要重新计算布局。\n面试官：嗯。\n我：重绘只是外观变化。\n面试官：那你说说怎么减少回流？'
    )
  })

  it('sends no fillers or backchannels', async () => {
    const transcription = await loadTranscription()
    const requests = collectAutoReplies(transcription)
    const [socket] = startDashScope()

    for (const filler of ['诶？', '呃，那个', '嗯哼。', '对吧？', '哎。', '好嘞。', '这样啊。']) {
      say(socket, filler)
      vi.advanceTimersByTime(4000)
    }
    for (const filler of ['Yeah.', 'Hmm.', '嗯呢', '好吧。', '喂？', '嗯，嗯，稍等一下。']) {
      say(socket, filler)
      vi.advanceTimersByTime(4000)
    }

    expect(requests).toEqual([])
    expect(transcription.getTranscriptionText()).toBe('')
  })

  it('does not interrupt the answer for a filler after the question', async () => {
    const transcription = await loadTranscription()
    const requests = collectAutoReplies(transcription)
    const [socket] = startDashScope()

    say(socket, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(1500)
    say(socket, '嗯，好的。')
    vi.advanceTimersByTime(5000)

    expect(requests).toEqual(['你说说重绘和回流有什么区别？'])
  })

  it('waits out a thinking pause instead of sending half a question', async () => {
    const transcription = await loadTranscription()
    const requests = collectAutoReplies(transcription)
    const [socket] = startDashScope()

    say(socket, '那你说一下', false)
    vi.advanceTimersByTime(1600)
    say(socket, '那你说一下，嗯', false)
    vi.advanceTimersByTime(1600)
    say(socket, '那你说一下，嗯，React 的 Fiber 架构', false)
    vi.advanceTimersByTime(500)
    say(socket, '那你说一下，嗯，React 的 Fiber 架构解决了什么问题？')
    vi.advanceTimersByTime(5000)

    expect(requests).toEqual(['那你说一下，嗯，React 的 Fiber 架构解决了什么问题？'])
  })
})
