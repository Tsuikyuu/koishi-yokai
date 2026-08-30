import { expect, it } from '@effect/vitest'
import { Option } from 'effect'

import { SceneUnderstanding, ThreadScene } from '../../src/index'

const message = (
  messageId: string,
  authorId: string,
  content: string,
  replyToMessageId: Option.Option<ThreadScene.MessageId> = Option.none(),
) =>
  ThreadScene.Message.make({
    messageId: ThreadScene.MessageId.make(messageId),
    authorId: ThreadScene.ParticipantId.make(authorId),
    timestamp: ThreadScene.EpochMilliseconds.make(0),
    content,
    replyToMessageId,
    isSelf: false,
    directedToYokai: false,
  })

it('assigns explicit replies to the correct thread in a fixed multi-topic replay', () => {
  const weather = SceneUnderstanding.observe(
    ThreadScene.empty(),
    message('weather-question', 'alice', '明天上海天气怎么样？'),
    0,
  )
  const cooking = SceneUnderstanding.observe(
    weather.state,
    message('cooking-question', 'bob', '拉面汤底要怎么熬？'),
    1_000,
  )
  const cookingReply = SceneUnderstanding.observe(
    cooking.state,
    message(
      'cooking-reply',
      'carol',
      '鸡骨加昆布慢慢熬就行',
      Option.some(ThreadScene.MessageId.make('cooking-question')),
    ),
    2_000,
  )
  const weatherReply = SceneUnderstanding.observe(
    cookingReply.state,
    message(
      'weather-reply',
      'dave',
      '天气预报说会下雨，记得带伞',
      Option.some(ThreadScene.MessageId.make('weather-question')),
    ),
    3_000,
  )

  expect(cookingReply.scene.thread.id).toBe('thread:cooking-question')
  expect(cookingReply.scene.thread.participants).toEqual(['bob', 'carol'])
  expect(cookingReply.scene.thread.mode).toBe('question')
  expect(cookingReply.scene.direction.kind).toBe('participant')
  expect(Option.getOrUndefined(cookingReply.scene.direction.targetParticipantId)).toBe('bob')
  expect(cookingReply.scene.sufficientResponse).toBe(true)

  expect(weatherReply.scene.thread.id).toBe('thread:weather-question')
  expect(weatherReply.scene.thread.participants).toEqual(['alice', 'dave'])
  expect(weatherReply.scene.direction.kind).toBe('participant')
  expect(weatherReply.scene.activeThreadCount).toBe(2)
  expect(weatherReply.scene.interruptsOthers).toBe(true)
  expect(weatherReply.state.activeThreads).toHaveLength(2)
})

it('classifies scene modes and preserves a question while ordinary answers arrive', () => {
  const cases: ReadonlyArray<readonly [string, ThreadScene.Mode]> = [
    ['这个接口为什么失败？', 'question'],
    ['哈哈这也太好笑了😂', 'joke'],
    ['我不同意，这个结论不对', 'dispute'],
    ['最近压力很大，有点焦虑', 'confiding'],
    ['通知：今晚十点维护', 'notice'],
    ['今天一起吃饭吧', 'chat'],
  ]

  for (const [content, expected] of cases) {
    const observed = SceneUnderstanding.observe(
      ThreadScene.empty(),
      message(`message-${expected}`, 'alice', content),
      0,
    )
    expect(observed.scene.thread.mode).toBe(expected)
  }
})

it('bounds active threads and recent message references deterministically', () => {
  const manyThreads = Array.from({ length: ThreadScene.MAX_ACTIVE_THREADS + 3 }, (_, index) =>
    message(`topic-${index}`, `author-${index}`, `subject${index}`),
  ).reduce(
    (state, next, index) => SceneUnderstanding.observe(state, next, index).state,
    ThreadScene.empty(),
  )
  expect(manyThreads.activeThreads).toHaveLength(ThreadScene.MAX_ACTIVE_THREADS)
  expect(manyThreads.activeThreads.map((thread) => thread.id)).toEqual(
    Array.from(
      { length: ThreadScene.MAX_ACTIVE_THREADS },
      (_, index) => `thread:topic-${index + 3}`,
    ),
  )

  const seed = SceneUnderstanding.observe(
    ThreadScene.empty(),
    message('chain-0', 'alice', 'bounded chain'),
    0,
  )
  const chain = Array.from({ length: ThreadScene.MAX_THREAD_MESSAGES + 6 }, (_, index) =>
    message(
      `chain-${index + 1}`,
      'alice',
      'bounded chain continuation',
      Option.some(ThreadScene.MessageId.make(`chain-${index}`)),
    ),
  ).reduce(
    (state, next, index) => SceneUnderstanding.observe(state, next, index + 1).state,
    seed.state,
  )
  expect(chain.activeThreads).toHaveLength(1)
  const chainedThread = chain.activeThreads[0]
  if (chainedThread === undefined) throw new Error('Expected one bounded thread')
  expect(chainedThread.recentMessages).toHaveLength(ThreadScene.MAX_THREAD_MESSAGES)
})
