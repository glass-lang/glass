import { checkOk } from '@glass-lang/util'
import fetch from 'node-fetch'
import { TranspilerOutput } from '.'
import { ResponseData } from '../dist/runGlassTranspilerOutput'
import { LANGUAGE_MODELS, LanguageModelCreator, LanguageModelType } from './languageModels'
import { ChatBlock, parseChatBlocks2 } from './parseChatBlocks'
import { FunctionData, RequestData } from './parseGlassBlocks'
import { DEFAULT_TOKEN_COUNTER, TokenCounter } from './tokenCounter'
import { addToDocument, handleRequestNode } from './transformGlassDocument'

export async function runGlassTranspilerOutput(
  { interpolatedDoc, defaultModel, functions }: TranspilerOutput,
  options: {
    tokenCounter?: TokenCounter
    openaiKey?: string
    anthropicKey?: string
    progress?: (data: { nextGlassfile: string; response: ChatBlock[] }) => void
    id?: () => string
    output?: (line: string) => void
  } = {}
): Promise<{
  response: ChatBlock[]
  nextGlassfile: string
}> {
  const transformedInterpolatedDoc = interpolatedDoc

  const newBlockIds: string[] = []

  if (options?.progress) {
    options.progress(
      handleRequestNode(
        transformedInterpolatedDoc,
        {
          newBlockIds,
          responseData: [[{ response: '' }]],
          requestBlocks,
          streaming: true,
          index: 0,
        },
        options.id
      )
    )
  }

  const responseData: ResponseData[][] = []
  const messageBlocks = parseChatBlocks2(transformedInterpolatedDoc, requestBlocks, options?.tokenCounter)
  const messagesSoFar: ChatBlock[] = []
  checkOk(messageBlocks.length === requestBlocks.length)

  let i = 0
  let res:
    | {
        response: ChatBlock[]
        nextGlassfile: string
      }
    | undefined = undefined
  let codeResponse: any
  const continued = false

  for (; i < messageBlocks.length; i++) {
    const messages = messageBlocks[i]
    const requestData = requestBlocks[i]
    const model = requestData.model
    const languageModel = LANGUAGE_MODELS.find(m => m.name === model)
    if (!languageModel) {
      throw new Error(`Language model ${model} not found`)
    }
    res =
      languageModel.creator === LanguageModelCreator.anthropic
        ? await runGlassChatAnthropic(
            messages,
            messagesSoFar,
            responseData,
            requestBlocks,
            newBlockIds,
            transformedInterpolatedDoc,
            options
          )
        : languageModel.type === LanguageModelType.chat
        ? await runGlassChat(
            messages,
            messagesSoFar,
            responseData,
            requestBlocks,
            newBlockIds,
            functions,
            transformedInterpolatedDoc,
            i,
            options
          )
        : await runGlassCompletion(
            messages,
            messagesSoFar,
            responseData,
            requestBlocks,
            newBlockIds,
            transformedInterpolatedDoc,
            options
          )

    const blocksToAddToDocument: { tag: string; content: string; attrs?: any }[] = []

    if (blocksToAddToDocument.length > 0) {
      const added = addToDocument(blocksToAddToDocument, res.nextGlassfile)
      res.nextGlassfile = added.doc
    }
  }

  return res!
}

/**
 * Takes a glass template string and interpolation variables and outputs an array of chat messages you can use to prompt ChatGPT API (e.g. gpt-3.5-turbo or gpt-4).
 */
async function runGlassChat(
  messages: ChatBlock[],
  messagesSoFar: ChatBlock[],
  responseData: ResponseData[][],
  requestBlocks: RequestData[],
  newBlockIds: string[],
  functions: FunctionData[],
  interpolatedDoc: string,
  responseIndex: number,
  options: {
    id?: () => string
    tokenCounter?: TokenCounter
    openaiKey?: string
    progress?: (data: { nextGlassfile: string; response: ChatBlock[] }) => void
    output?: (line: string) => void
  }
): Promise<{
  response: ChatBlock[]
  nextGlassfile: string
}> {
  const request = requestBlocks[responseIndex]
  const responseDataToAppendTo = responseData[responseIndex] // if undefined, starting new response data

  console.log('runGlass: chat-gpt', messagesSoFar.concat(messages))
  if (options.output) {
    options.output('runGlass: chat-gpt')
    options.output(JSON.stringify(messagesSoFar.concat(messages), null, 2))
  }

  const tokenCounter = options.tokenCounter || DEFAULT_TOKEN_COUNTER

  const requestTokens = tokenCounter.countTokens(
    messagesSoFar
      .concat(messages)
      .map(b => `<|im_start|>${b.role}\n${b.content}<|im_end|>`)
      .join(''),
    request.model
  )

  let functionArgs = {}
  if (functions.length > 0) {
    functionArgs = {
      functions: functions.map(f => ({
        name: f.name,
        description: f.description,
        parameters: f.parameters,
      })),
      function_call: 'auto',
    }
  }

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      Authorization: `Bearer ${options?.openaiKey || process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: messagesSoFar.concat(messages).map(m => ({ ...m })),
      model: request.model,
      stream: true,
      ...functionArgs,
    }),
  })

  const response = await handleStream(r, handleChatChunk, next => {
    if (!r.ok) {
      throw new Error(`HTTP error: ${r.status}`)
    }
    if (options?.progress) {
      const responseTokens = tokenCounter.countTokens(`<|im_start|>assistant\n${next}<|im_end|>`, request.model)
      return options.progress(
        handleRequestNode(
          interpolatedDoc,
          {
            newBlockIds,
            responseData:
              responseDataToAppendTo == null
                ? responseData.concat([
                    [
                      {
                        response: next.content.trim(),
                        function_call: next.function_call,
                        requestTokens,
                        responseTokens,
                      },
                    ],
                  ])
                : responseData.map((r, i) =>
                    i === responseIndex
                      ? r.concat([
                          {
                            response: next.content.trim(),
                            function_call: next.function_call,
                            requestTokens,
                            responseTokens,
                          },
                        ])
                      : r
                  ),
            requestBlocks,
            requestTokens,
            responseTokens,
            streaming: true,
            index: responseData.length,
          },
          options.id
        )
      )
    }
  })

  let functionObservation: string | undefined = undefined
  if (response.function_call != null) {
    const fn = functions.find(f => f.name === response.function_call!.name)!
    checkOk(fn, `Function ${response.function_call!.name} not found`)
    const args = JSON.parse(response.function_call!.arguments)
    const result = await fn.run(args)
    functionObservation = JSON.stringify(result, null, 2)
  }

  // TODO: handle counting tokens for function response
  const responseTokens = tokenCounter.countTokens(`<|im_start|>assistant\n${response.content}<|im_end|>`, request.model)

  if (responseDataToAppendTo == null) {
    responseData.push([
      {
        response: response.content.trim(),
        function_call: response.function_call,
        functionObservation,
        requestTokens,
        responseTokens,
      },
    ])
  } else {
    responseData[responseIndex].push({
      response: response.content.trim(),
      function_call: response.function_call,
      functionObservation,
      requestTokens,
      responseTokens,
    })
  }
  messagesSoFar.push(...messages)
  messagesSoFar.push({
    role: 'assistant',
    content: response.content.trim().length ? response.content.trim() : JSON.stringify(response.function_call, null, 2),
  })

  if (functionObservation) {
    messagesSoFar.push({
      role: 'function',
      content: functionObservation,
      name: response.function_call!.name,
    })

    return await runGlassChat(
      [],
      messagesSoFar,
      responseData,
      requestBlocks,
      newBlockIds,
      functions,
      interpolatedDoc,
      responseIndex, // don't increment, gotta continue
      options
    )
  }

  return handleRequestNode(
    interpolatedDoc,
    {
      newBlockIds,
      responseData,
      requestBlocks,
      requestTokens,
      responseTokens,
      streaming: false,
      index: responseData.length - 1,
    },
    options.id
  )
}

/**
 * Takes a glass template string and interpolation variables and outputs an array of chat messages you can use to prompt ChatGPT API (e.g. gpt-3.5-turbo or gpt-4).
 */
async function runGlassCompletion(
  messages: ChatBlock[],
  messagesSoFar: ChatBlock[],
  responseData: ResponseData[][],
  requestBlocks: RequestData[],
  newBlockIds: string[],
  interpolatedDoc: string,
  options: {
    tokenCounter?: TokenCounter
    id?: () => string
    args?: any
    openaiKey?: string
    progress?: (data: { nextGlassfile: string; response: ChatBlock[] }) => void
    output?: (line: string) => void
  }
): Promise<{
  response: ChatBlock[]
  nextGlassfile: string
}> {
  const request = requestBlocks[responseData.length]

  const messagesToUse = messagesSoFar.concat(messages)
  const useChat = messagesToUse.length > 1

  let prompt = ''
  let stopSequence: string | null = null
  if (!useChat) {
    prompt = messagesToUse[0].content
  } else {
    stopSequence = '\n\nHuman:'
    for (const msg of messagesToUse) {
      if (msg.role === 'assistant') {
        prompt += `\n\nAssistant: ${msg.content}`
      } else if (msg.role === 'user') {
        prompt += `\n\nHuman: ${msg.content}`
      } else if (msg.role === 'system') {
        prompt += `\n\nHuman: ${msg.content}`
      } else {
        throw new Error(`Unknown role for completion query: ${msg.role}`)
      }
    }
    prompt += '\n\nAssistant: '
  }

  console.log('runGlass: gpt3', prompt)
  if (options.output) {
    options.output('runGlass: gpt3')
    options.output(prompt)
  }

  console.log({
    prompt,
    model: request.model,
    stream: true,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    stop: (request.stopSequence || []).concat(stopSequence ? [stopSequence] : []),
  })

  const tokenCounter = options.tokenCounter || DEFAULT_TOKEN_COUNTER

  const requestTokens = tokenCounter.countTokens(prompt, request.model)
  const stop = (request.stopSequence || []).concat(stopSequence ? [stopSequence] : [])

  const r = await fetch('https://api.openai.com/v1/completions', {
    method: 'POST',
    headers: {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      Authorization: `Bearer ${options?.openaiKey || process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model: request.model,
      stream: true,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stop: stop.length ? stop : undefined,
    }),
  })

  const response = await handleStream(r, handleCompletionChunk, next => {
    if (!r.ok) {
      throw new Error(`HTTP error: ${r.status}`)
    }
    if (options?.progress) {
      const responseTokens = tokenCounter.countTokens(next.content, request.model)
      return options.progress(
        handleRequestNode(
          interpolatedDoc,
          {
            newBlockIds,
            responseData: responseData.concat([[{ response: next.content.trim(), requestTokens, responseTokens }]]),
            requestBlocks,
            streaming: true,
            requestTokens,
            responseTokens,
            index: responseData.length,
          },
          options.id
        )
      )
    }
  })

  const responseTokens = tokenCounter.countTokens(response.content, request.model)

  responseData.push([{ response: response.content.trim(), requestTokens, responseTokens }])
  messagesSoFar.push(...messages)
  messagesSoFar.push({ role: 'assistant', content: response.content.trim() })

  return handleRequestNode(
    interpolatedDoc,
    {
      newBlockIds,
      responseData,
      requestBlocks,
      streaming: false,
      requestTokens,
      responseTokens,
      index: responseData.length - 1,
    },
    options.id
  )
}
