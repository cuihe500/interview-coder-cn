import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationPersona, TranscriptionSpeaker } from '../preload/contracts'
import {
  AUTO_REPLY_END_OF_SENTENCE_MS,
  AUTO_REPLY_MAX_CHARACTERS,
  AUTO_REPLY_MID_SENTENCE_MS,
  AUTO_REPLY_TURN_GAP_MS,
  AutoReplyTurn,
  endsSentence,
  shouldTriggerAutoReply,
  spokenContent,
  type AutoReplyRequest
} from './transcription-auto-reply'
import { SpeakerTranscript } from './transcription-speakers'

type Speaker = TranscriptionSpeaker | null

const FILLERS = [
  '诶？',
  '呃，那个',
  '嗯哼。',
  '对吧？',
  '哎。',
  '好嘞。',
  '这样啊。',
  'Yeah.',
  'Hmm.',
  '嗯呢',
  '好吧。',
  '喂？',
  '嗯，嗯，稍等一下。',
  'OK，好的，谢谢。',
  '？'
]

/**
 * A turn over a real transcript, driven the way the transcription module and
 * the chat auto reply drive it
 */
function createConversation(speakers: Speaker[] = [null], persona?: ConversationPersona) {
  const transcript = new SpeakerTranscript()
  transcript.setSpeakers(speakers)
  const asks = (speaker: Speaker) => shouldTriggerAutoReply(speaker, persona)
  const sent: (AutoReplyRequest & { requestId: string })[] = []
  let streamBusy = false
  const turn: AutoReplyTurn = new AutoReplyTurn({
    transcript: {
      pending: () => transcript.getConfirmedLines(),
      take: () => transcript.consumeConfirmed()
    },
    asks,
    onSettled: () => {
      if (streamBusy) return
      const request = turn.pendingRequest
      if (!request) {
        turn.discardUnanswered()
        return
      }
      const requestId = `request-${sent.length + 1}`
      turn.markSent(request, requestId)
      sent.push({ ...request, requestId })
    }
  })

  return {
    transcript,
    turn,
    sent,
    texts: () => sent.map((request) => request.text),
    blockRequests: () => {
      streamBusy = true
    },
    /** Words the provider shows while they are being spoken */
    speak(speaker: Speaker, text: string) {
      transcript.updatePartial(speaker, text)
      if (asks(speaker)) turn.touch(text)
    },
    /** A sentence the provider finished */
    finish(speaker: Speaker, text: string) {
      transcript.finishSentence(speaker, text)
      transcript.confirm(speaker, true)
      if (asks(speaker)) turn.hear()
    },
    /** The silence fallback confirming words the provider has not finished */
    pause(speaker: Speaker) {
      transcript.confirm(speaker, false)
      if (asks(speaker)) turn.hear()
    }
  }
}

describe('AutoReplyTurn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers a finished question shortly after the last words', () => {
    const { speak, finish, texts } = createConversation()

    speak(null, '你说说重绘和回流有什么区别')
    vi.advanceTimersByTime(300)
    finish(null, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS - 301)
    expect(texts()).toEqual([])

    vi.advanceTimersByTime(1)
    expect(texts()).toEqual(['你说说重绘和回流有什么区别？'])
  })

  it('waits for the rest of a sentence the speaker paused in', () => {
    const { speak, pause, finish, texts } = createConversation()

    speak(null, '那你说一下')
    vi.advanceTimersByTime(1500)
    pause(null)
    vi.advanceTimersByTime(500)
    speak(null, '那你说一下，嗯，React 的 Fiber 架构')
    vi.advanceTimersByTime(800)
    finish(null, '那你说一下，嗯，React 的 Fiber 架构解决了什么问题？')
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)

    expect(texts()).toEqual(['那你说一下，嗯，React 的 Fiber 架构解决了什么问题？'])
  })

  it('counts a hesitation mid-sentence as still talking', () => {
    const { speak, pause, finish, texts } = createConversation()

    speak(null, '那你说一下')
    vi.advanceTimersByTime(1500)
    pause(null)
    vi.advanceTimersByTime(100)
    speak(null, '那你说一下，嗯')
    vi.advanceTimersByTime(1500)
    pause(null)
    // Past the mid-sentence wait counted from the last words, not from the "嗯"
    vi.advanceTimersByTime(800)
    expect(texts()).toEqual([])

    speak(null, '那你说一下，嗯，React 的 Fiber 架构')
    finish(null, '那你说一下，嗯，React 的 Fiber 架构解决了什么问题？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)
    expect(texts()).toEqual(['那你说一下，嗯，React 的 Fiber 架构解决了什么问题？'])
  })

  it('answers what was said once a pause mid-sentence lasts', () => {
    const { speak, pause, texts } = createConversation()

    speak(null, '那你说一下')
    vi.advanceTimersByTime(1500)
    pause(null)
    vi.advanceTimersByTime(AUTO_REPLY_MID_SENTENCE_MS - 1501)
    expect(texts()).toEqual([])

    vi.advanceTimersByTime(1)
    expect(texts()).toEqual(['那你说一下'])
  })

  it('resends the whole turn when the speaker goes on, replacing the first request', () => {
    const { speak, finish, sent } = createConversation()

    finish(null, '那我们聊聊前端性能。')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)
    speak(null, '你说说重绘和回流')
    finish(null, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)

    expect(sent).toEqual([
      { text: '那我们聊聊前端性能。', replacesRequestId: null, requestId: 'request-1' },
      {
        text: '那我们聊聊前端性能。你说说重绘和回流有什么区别？',
        replacesRequestId: 'request-1',
        requestId: 'request-2'
      }
    ])
  })

  it('does not resend for fillers after the question, but keeps them for a later resend', () => {
    const { speak, finish, transcript, texts } = createConversation()

    finish(null, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)
    speak(null, '嗯，好的')
    finish(null, '嗯，好的。')
    vi.advanceTimersByTime(AUTO_REPLY_MID_SENTENCE_MS)

    expect(texts()).toEqual(['你说说重绘和回流有什么区别？'])
    expect(transcript.getText()).toBe('')

    speak(null, '比如在 React 里')
    finish(null, '比如在 React 里呢？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)

    expect(texts()[1]).toBe('你说说重绘和回流有什么区别？嗯，好的。比如在 React 里呢？')
  })

  it('keeps the question mark the provider adds after sending for a resend', () => {
    const { speak, pause, finish, texts } = createConversation()

    speak(null, '你说说重绘和回流有什么区别')
    vi.advanceTimersByTime(1500)
    pause(null)
    vi.advanceTimersByTime(AUTO_REPLY_MID_SENTENCE_MS - 1500)
    finish(null, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(100)
    speak(null, '比如')
    finish(null, '比如在 React 里呢？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)

    expect(texts()).toEqual([
      '你说说重绘和回流有什么区别',
      '你说说重绘和回流有什么区别？比如在 React 里呢？'
    ])
  })

  it('neither sends nor interrupts the answer for noise in the silence after a question', () => {
    const { speak, finish, transcript, sent } = createConversation()

    speak(null, '你说说重绘和回流有什么区别')
    finish(null, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(2000)
    for (const noise of ['啊', '？', '嗯。', '阿', '啊？']) {
      speak(null, noise)
      vi.advanceTimersByTime(800)
      finish(null, noise)
      vi.advanceTimersByTime(800)
    }
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)

    expect(sent).toHaveLength(1)
    expect(transcript.getText()).toBe('')
  })

  it('answers on time while noise follows the question', () => {
    const { speak, finish, texts } = createConversation()

    speak(null, '你说说重绘和回流有什么区别')
    finish(null, '你说说重绘和回流有什么区别？')
    for (let count = 1; count <= 4; count++) {
      vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS / 4)
      speak(null, '啊'.repeat(count))
    }

    expect(texts()).toEqual(['你说说重绘和回流有什么区别？'])
  })

  it('answers on time when a stray word follows the question', () => {
    const { speak, finish, sent } = createConversation()

    speak(null, '你说说重绘和回流有什么区别')
    finish(null, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(500)
    speak(null, '我')
    finish(null, '我。')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS - 500)

    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('你说说重绘和回流有什么区别？')
  })

  it('does not resend for stray words that add up', () => {
    const { finish, sent } = createConversation()

    finish(null, '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)
    finish(null, '我。')
    finish(null, '一。')
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)

    expect(sent).toHaveLength(1)
  })

  it('never sends fillers, backchannels or bare punctuation, and drops them', () => {
    const { finish, transcript, texts } = createConversation()

    for (const filler of FILLERS) {
      finish(null, filler)
      vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)
    }

    expect(texts()).toEqual([])
    expect(transcript.getText()).toBe('')
  })

  it('answers short follow-up questions', () => {
    const { finish, texts } = createConversation()

    for (const question of ['为什么？', '然后呢？', '还有吗？', '继续。']) {
      finish(null, question)
      vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)
    }

    expect(texts()).toEqual(['为什么？', '然后呢？', '还有吗？', '继续。'])
  })

  it('does not answer my own words when the interviewer only backchannels', () => {
    const { speak, finish, transcript, texts } = createConversation(['interviewer', 'me'])

    speak('interviewer', '你说说重绘和回流有什么区别')
    finish('interviewer', '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)
    speak('me', '回流是指元素的几何属性发生变化')
    finish('me', '回流是指元素的几何属性发生变化，浏览器需要重新计算布局。')
    finish('interviewer', '嗯。')
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)
    finish('me', '重绘只是外观变化。')
    finish('interviewer', '？')
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)

    expect(texts()).toEqual(['面试官：你说说重绘和回流有什么区别？'])
    expect(transcript.getText()).toContain('我：重绘只是外观变化。')

    speak('interviewer', '那你说说怎么减少回流')
    finish('interviewer', '那你说说怎么减少回流？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)

    // My answers ride along with the next real question
    expect(texts()[1]).toBe(
      '我：回流是指元素的几何属性发生变化，浏览器需要重新计算布局。\n面试官：嗯。\n我：重绘只是外观变化。\n面试官：那你说说怎么减少回流？'
    )
  })

  it('does not resend the interviewer turn for my words', () => {
    const { speak, pause, finish, texts } = createConversation(['interviewer', 'me'])

    speak('interviewer', '你说说重绘和回流有什么区别')
    vi.advanceTimersByTime(1500)
    pause('interviewer')
    vi.advanceTimersByTime(AUTO_REPLY_MID_SENTENCE_MS - 1500)
    // Still inside the interviewer's turn
    finish('me', '嗯，好的，我想一下。')
    finish('interviewer', '你说说重绘和回流有什么区别？')
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)

    expect(texts()).toEqual(['面试官：你说说重绘和回流有什么区别'])
  })

  it('answers my own words in a mock interview', () => {
    const { finish, texts } = createConversation(['interviewer', 'me'], 'mock-interview')

    finish('me', '我做过三年前端开发，主要负责性能优化。')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)

    expect(texts()).toEqual(['我：我做过三年前端开发，主要负责性能优化。'])
  })

  it('starts a new turn once the speaker has been quiet for the gap', () => {
    const { finish, sent } = createConversation()

    finish(null, '第一个问题？')
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)
    finish(null, '第二个问题？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)

    expect(sent[1]).toEqual({
      text: '第二个问题？',
      replacesRequestId: null,
      requestId: 'request-2'
    })
  })

  it('keeps a question waiting for a busy stream past the gap', () => {
    const { finish, turn, blockRequests } = createConversation()
    blockRequests()

    finish(null, '还没发出去的问题？')
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS * 3)

    expect(turn.pendingRequest).toEqual({ text: '还没发出去的问题？', replacesRequestId: null })
  })

  it('starts a new turn instead of growing past the size limit', () => {
    const { speak, finish, sent } = createConversation()

    finish(null, '长'.repeat(AUTO_REPLY_MAX_CHARACTERS - 1))
    vi.advanceTimersByTime(AUTO_REPLY_MID_SENTENCE_MS)
    speak(null, '新的问题')
    finish(null, '新的问题？')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)

    expect(sent[1]).toMatchObject({ text: '新的问题？', replacesRequestId: null })
  })

  it('drops punctuation left over from the end of the previous turn', () => {
    const single = createConversation()
    single.finish(null, '？最后一道场景题，请设计一个方案。')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)
    expect(single.texts()).toEqual(['最后一道场景题，请设计一个方案。'])

    const mixed = createConversation(['interviewer', 'me'])
    mixed.finish('interviewer', '？最后一道场景题，请设计一个方案。')
    vi.advanceTimersByTime(AUTO_REPLY_END_OF_SENTENCE_MS)
    expect(mixed.texts()).toEqual(['面试官：最后一道场景题，请设计一个方案。'])
  })

  it('sends nothing once cleared', () => {
    const { finish, turn, texts } = createConversation()

    finish(null, '不会发送的问题？')
    turn.clear()
    vi.advanceTimersByTime(AUTO_REPLY_TURN_GAP_MS)

    expect(texts()).toEqual([])
    expect(turn.pendingRequest).toBeNull()
  })
})

describe('spokenContent', () => {
  it('drops punctuation, spaces, case and clauses made only of fillers', () => {
    expect(spokenContent('嗯，好的。OK，那你说说 React Fiber？')).toBe('那你说说reactfiber')
  })

  it('keeps a clause that has content besides fillers', () => {
    expect(spokenContent('好的我们开始')).toBe('好的我们开始')
    expect(spokenContent('这个对吗？')).toBe('这个对吗')
  })

  it('is empty for speech that asks nothing', () => {
    for (const filler of FILLERS) expect(spokenContent(filler)).toBe('')
    for (const filler of ['Hmmm…', 'Uh-huh.', 'Mhm.', 'Ummm,', 'Okkk', '好的好的。']) {
      expect(spokenContent(filler)).toBe('')
    }
  })

  it('stays fast on long runs of filler sounds', () => {
    expect(spokenContent(`${'m'.repeat(5000)}问`)).toBe(`${'m'.repeat(5000)}问`)
    expect(spokenContent(`${'好的'.repeat(5000)}我`)).toHaveLength(10_001)
  })
})

describe('endsSentence', () => {
  it('accepts sentence-final punctuation', () => {
    expect(endsSentence('你说说重绘和回流有什么区别？')).toBe(true)
    expect(endsSentence('请设计一个完整的方案。')).toBe(true)
    expect(endsSentence('你用过 Vue 3 吗？')).toBe(true)
    expect(endsSentence('What is a closure?')).toBe(true)
  })

  it('looks past noise after the sentence', () => {
    expect(endsSentence('有什么区别？嗯')).toBe(true)
    expect(endsSentence('有什么区别？嗯，好的。')).toBe(true)
    expect(endsSentence('有什么区别？我')).toBe(true)
  })

  it('rejects speech cut off mid-sentence', () => {
    expect(endsSentence('那你说一下')).toBe(false)
    expect(endsSentence('那你说一下，')).toBe(false)
    expect(endsSentence('那你说一下，嗯')).toBe(false)
    expect(endsSentence('那你说一下……')).toBe(false)
    expect(endsSentence('嗯。')).toBe(false)
  })
})

describe('shouldTriggerAutoReply', () => {
  it('skips my own speech in a regular conversation', () => {
    expect(shouldTriggerAutoReply('me', undefined)).toBe(false)
  })

  it('skips my own speech in a review conversation', () => {
    expect(shouldTriggerAutoReply('me', 'review')).toBe(false)
  })

  it('replies to my own speech in a mock interview', () => {
    expect(shouldTriggerAutoReply('me', 'mock-interview')).toBe(true)
  })

  it('replies to the interviewer in every conversation type', () => {
    expect(shouldTriggerAutoReply('interviewer', undefined)).toBe(true)
    expect(shouldTriggerAutoReply('interviewer', 'review')).toBe(true)
    expect(shouldTriggerAutoReply('interviewer', 'mock-interview')).toBe(true)
  })

  it('replies when the speaker is unknown', () => {
    expect(shouldTriggerAutoReply(null, undefined)).toBe(true)
    expect(shouldTriggerAutoReply(undefined, undefined)).toBe(true)
    expect(shouldTriggerAutoReply(null, 'mock-interview')).toBe(true)
  })
})
