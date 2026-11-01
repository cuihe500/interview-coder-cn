import appConfig from '../../app.config.json'
import type { ConversationPersona, TranscriptionSpeaker } from '../preload/contracts'
import {
  formatTranscriptionLines,
  joinTranscriptionText,
  type SpeakerText
} from './transcription-speakers'

const config = appConfig.transcription
export const AUTO_REPLY_TURN_GAP_MS = config.autoReplyTurnGapMs
export const AUTO_REPLY_END_OF_SENTENCE_MS = config.autoReplyEndOfSentenceMs
export const AUTO_REPLY_MID_SENTENCE_MS = config.autoReplyMidSentenceMs
export const AUTO_REPLY_MIN_CHARACTERS = config.autoReplyMinCharacters
export const AUTO_REPLY_MAX_CHARACTERS = config.autoReplyMaxCharacters

type Timer = ReturnType<typeof setTimeout>
type Speaker = TranscriptionSpeaker | null

const CLAUSE_BREAK = /[\s\p{P}\p{S}]+/u
/**
 * Words that say nothing on their own; a clause made only of them asks nothing.
 * Matching stays linear because no word is made of other words ("好的" is
 * 好 + 的) and English words are matched with repeated letters collapsed.
 */
const FILLER_CLAUSE = new RegExp(
  `^(?:${[
    // Interjections and sentence-final particles
    '嗯|恩|啊|阿|哦|噢|喔|呃|额|唔|哈|呵|嘿|嘻|诶|欸|哎|唉|呀|哇|咦|嗨|喂|哟|呦|哼',
    '嘛|呢|吧|啦|吗|了|的|嘞|咯|喽',
    // Acknowledgements and tag questions
    '对|好|是|行|懂|可以|明白|了解|知道|收到|清楚|没错|没问题|没事|当然|真的',
    '不错|挺好|很好|有道理|原来如此|这样|这样子|谢谢|谢谢你|谢谢您',
    '对不对|是不是|好不好|行不行',
    // Hesitations
    '那个|那么|就是|就是说|稍等|稍等一下|等一下|等等',
    // English: "hmmm" is matched as "hm", "mhm" as m + hm
    'ok|okay|yeah|yes|yep|yup|right|sure|so|uh|um|hm|m|em|erm|ah|oh|huh'
  ].join('|')})+$`
)
const REPEATED_LETTER = /([a-z])\1+/g
/** Splits after each sentence-final mark; "……" trails off rather than ending a sentence */
const SENTENCE_BREAK = /(?<=[。？！?!.])/u
const SENTENCE_END = /[。？！?!.]$/u
/** Punctuation the provider adds to the end of the last turn arrives at the start of the next */
const LEADING_PUNCTUATION = /^[\s\p{P}]+/u

function isFiller(clause: string): boolean {
  return FILLER_CLAUSE.test(clause.toLowerCase().replace(REPEATED_LETTER, '$1'))
}

/** What was said, without punctuation, spaces, case, or clauses made only of fillers */
export function spokenContent(text: string): string {
  return text
    .toLowerCase()
    .split(CLAUSE_BREAK)
    .filter((clause) => !isFiller(clause))
    .join('')
}

/** Whether a word or two of stray sound is all there is ("啊", "？", a misheard "我") */
function isNoise(text: string): boolean {
  return spokenContent(text).length < AUTO_REPLY_MIN_CHARACTERS
}

/** Whether speech stops at a sentence end; noise after it ("…区别？嗯", "…区别？啊。") does not reopen it */
export function endsSentence(text: string): boolean {
  const sentences = text.trimEnd().split(SENTENCE_BREAK)
  while (sentences.length > 0 && isNoise(sentences[sentences.length - 1])) sentences.pop()
  return SENTENCE_END.test(sentences.at(-1)?.trimEnd() ?? '')
}

/** My speech answers the interviewer, except in a mock interview where my answers are the input */
export function shouldTriggerAutoReply(
  speaker: TranscriptionSpeaker | null | undefined,
  persona: ConversationPersona | undefined
): boolean {
  return speaker !== 'me' || persona === 'mock-interview'
}

function withoutLeadingPunctuation(line: SpeakerText): SpeakerText {
  return { ...line, text: line.text.replace(LEADING_PUNCTUATION, '') }
}

/** Where a turn reads speech; confirmed speech stays there until the turn takes it */
export type TurnTranscript = {
  /** Confirmed speech no request has taken yet, oldest first */
  pending(): SpeakerText[]
  /** Removes the speech pending() returned */
  take(): void
}

export type AutoReplyRequest = {
  text: string
  /** The earlier request of the same turn, which this one replaces */
  replacesRequestId: string | null
}

type AutoReplyTurnOptions = {
  transcript: TurnTranscript
  /** Whose speech asks the questions; everyone else's rides along as context */
  asks: (speaker: Speaker) => boolean
  /** The asking speaker paused long enough; the owner decides whether a request can go out */
  onSettled: () => void
}

/**
 * What the asking speaker said since they last went quiet for the turn gap. A
 * request goes out once their speech settles, sooner after a finished sentence
 * than after a pause mid-sentence, and carries the whole turn: speech after a
 * pause resends the complete question and replaces the answer to its first
 * half. Noise the provider turns into "啊" or "？" is not speech: it neither
 * holds a question back nor sends, joining the turn it trails or leaving the
 * transcript, except that my answers next to it wait there to ride along with
 * the next question.
 */
export class AutoReplyTurn {
  /** Speech this turn has taken: what its requests carried and the noise trailing them */
  private text = ''
  private sentRequestId: string | null = null
  /** What the latest unfinished utterance says, to tell new words from noise */
  private utteranceContent = ''
  /** Last time the asking speaker said new words; null until seen in this turn */
  private lastSpeechAt: number | null = null
  private settleTimer: Timer | null = null
  /** The latest finished speech has had its pause and is not handled yet */
  private settled = false
  private gapTimer: Timer | null = null

  constructor(private readonly options: AutoReplyTurnOptions) {}

  /** The provider heard more of the asking speaker's utterance; only new words mean they are still talking */
  touch(utterance: string): void {
    const content = spokenContent(utterance)
    const newWords = content !== this.utteranceContent
    this.utteranceContent = content
    // A stray sound is not someone talking, nor is noise after a finished
    // sentence; a hesitation mid-sentence ("那你说一下，嗯…") is
    if (content.length < AUTO_REPLY_MIN_CHARACTERS) return
    if (!newWords && endsSentence(utterance)) return
    this.lastSpeechAt = Date.now()
    this.clearSettle()
    this.scheduleGap(this.lastSpeechAt)
  }

  /** The asking speaker finished a sentence or paused; the answer waits for the pause to hold */
  hear(): { complete: boolean; waitMs: number } {
    const asked = this.options.transcript
      .pending()
      .filter((line) => this.options.asks(line.speaker))
    const complete = endsSentence(asked.at(-1)?.text ?? '')
    // A silence fallback arrives well after the speech it finalizes; the wait counts from the speech
    const spokeAt = this.lastSpeechAt ?? Date.now()
    const settleAt =
      spokeAt + (complete ? AUTO_REPLY_END_OF_SENTENCE_MS : AUTO_REPLY_MID_SENTENCE_MS)
    const waitMs = Math.max(0, settleAt - Date.now())
    this.clearSettle()
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.settled = true
      this.options.onSettled()
    }, waitMs)
    this.scheduleGap(spokeAt)
    return { complete, waitMs }
  }

  /** The request to send now: the whole turn, once speech settles on something new to answer */
  get pendingRequest(): AutoReplyRequest | null {
    if (!this.settled) return null
    const lines = this.options.transcript.pending()
    if (this.askedContent(lines).length < AUTO_REPLY_MIN_CHARACTERS) return null
    const fragment = formatTranscriptionLines(lines)
    if (this.text && this.text.length + fragment.length <= AUTO_REPLY_MAX_CHARACTERS) {
      return {
        text: joinTranscriptionText(this.text, fragment).trim(),
        replacesRequestId: this.sentRequestId
      }
    }
    return {
      text: formatTranscriptionLines(lines.map(withoutLeadingPunctuation)).trim(),
      replacesRequestId: null
    }
  }

  /** The request went out and took the pending speech with it */
  markSent(request: AutoReplyRequest, requestId: string | null = null): void {
    this.options.transcript.take()
    this.text = request.text
    this.sentRequestId = requestId
    this.clearSettle()
  }

  /**
   * Settled speech that asks nothing joins the turn it trails, so a resend
   * keeps the "？" after the question, or leaves the transcript instead of
   * prefixing the next question. Returns the speech set aside.
   */
  discardUnanswered(): string | null {
    if (!this.settled) return null
    const lines = this.options.transcript.pending()
    // My answers stay in the transcript to ride along with the next question
    const keeps = lines.some((line) => !this.options.asks(line.speaker) && spokenContent(line.text))
    if (keeps || this.askedContent(lines).length >= AUTO_REPLY_MIN_CHARACTERS) return null
    this.clearSettle()
    if (!lines.length) return null
    const text = formatTranscriptionLines(lines)
    this.options.transcript.take()
    if (this.text) this.text = joinTranscriptionText(this.text, text)
    return text
  }

  clear(): void {
    this.clearSettle()
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = null
    this.text = ''
    this.sentRequestId = null
    this.lastSpeechAt = null
  }

  /** What the asking speaker said, leaving out sentences that are only noise */
  private askedContent(lines: SpeakerText[]): string {
    return lines
      .filter((line) => this.options.asks(line.speaker))
      .flatMap((line) => line.text.split(SENTENCE_BREAK))
      .filter((sentence) => !isNoise(sentence))
      .map(spokenContent)
      .join('')
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    this.settled = false
  }

  private scheduleGap(from: number): void {
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = setTimeout(
      () => {
        this.gapTimer = null
        // Speech still settling, or a question waiting for a busy stream, keeps the turn open
        if (this.settleTimer || (this.settled && this.pendingRequest)) {
          this.scheduleGap(Date.now())
        } else {
          this.clear()
        }
      },
      Math.max(0, from + AUTO_REPLY_TURN_GAP_MS - Date.now())
    )
  }
}
