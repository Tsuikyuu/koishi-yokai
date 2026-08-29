import { Effect } from 'effect'

import {
  MAX_TEXT_LENGTH,
  MAX_TOTAL_TEXT_LENGTH,
  MAX_XML_ATTRIBUTES,
  MAX_XML_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_ELEMENTS,
  ParseError,
  type ParseFailureReason,
} from './schema'

export interface XmlAttribute {
  readonly name: string
  readonly value: string
}

export interface XmlText {
  readonly _tag: 'Text'
  readonly value: string
}

export interface XmlElement {
  readonly _tag: 'Element'
  readonly name: string
  readonly attributes: ReadonlyArray<XmlAttribute>
  readonly children: ReadonlyArray<XmlNode>
}

export type XmlNode = XmlElement | XmlText

interface Cursor {
  readonly source: string
  readonly offset: number
  readonly elementCount: number
  readonly attributeCount: number
  readonly textLength: number
}

interface ParsedName {
  readonly name: string
  readonly cursor: Cursor
}

interface ParsedAttribute {
  readonly attribute: XmlAttribute
  readonly cursor: Cursor
}

interface ParsedAttributes {
  readonly attributes: ReadonlyArray<XmlAttribute>
  readonly cursor: Cursor
}

interface ParsedElement {
  readonly element: XmlElement
  readonly cursor: Cursor
}

interface ParsedChildren {
  readonly children: ReadonlyArray<XmlNode>
  readonly cursor: Cursor
}

const ENTITY_TOKEN = /(&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)/g

export const parseError = (reason: ParseFailureReason): ParseError => new ParseError({ reason })

export const isXmlWhitespace = (character: string): boolean =>
  character === '\u0009' ||
  character === '\u000a' ||
  character === '\u000d' ||
  character === '\u0020'

export const isWhitespaceText = (value: string): boolean => Array.from(value).every(isXmlWhitespace)

const skipWhitespace = (cursor: Cursor): Cursor => {
  let offset = cursor.offset
  while (offset < cursor.source.length) {
    const character = cursor.source[offset]
    if (character === undefined || !isXmlWhitespace(character)) break
    offset += 1
  }
  return { ...cursor, offset }
}

const characterAt = (cursor: Cursor): string | undefined => cursor.source[cursor.offset]

const expectLiteral = (cursor: Cursor, literal: string): Effect.Effect<Cursor, ParseError> =>
  cursor.source.startsWith(literal, cursor.offset)
    ? Effect.succeed({ ...cursor, offset: cursor.offset + literal.length })
    : Effect.fail(parseError('invalid-xml'))

const isNameStart = (character: string): boolean => /^[A-Za-z_]$/.test(character)

const isNameContinue = (character: string): boolean => /^[A-Za-z0-9._-]$/.test(character)

const readName = (cursor: Cursor): Effect.Effect<ParsedName, ParseError> => {
  const first = characterAt(cursor)
  if (first === undefined || !isNameStart(first)) {
    return Effect.fail(parseError('invalid-xml'))
  }

  let offset = cursor.offset + 1
  while (offset < cursor.source.length) {
    const character = cursor.source[offset]
    if (character === undefined || !isNameContinue(character)) break
    offset += 1
  }

  return Effect.succeed({
    name: cursor.source.slice(cursor.offset, offset),
    cursor: { ...cursor, offset },
  })
}

const isXmlCodePoint = (value: number): boolean =>
  value === 0x09 ||
  value === 0x0a ||
  value === 0x0d ||
  (value >= 0x20 && value <= 0xd7ff) ||
  (value >= 0xe000 && value <= 0xfffd) ||
  (value >= 0x10000 && value <= 0x10ffff)

const isXmlText = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && isXmlCodePoint(codePoint)
  })

const decodeNumericEntity = (
  token: string,
  radix: 10 | 16,
  prefixLength: number,
): Effect.Effect<string, ParseError> => {
  const digits = token.slice(prefixLength, -1)
  const codePoint = Number.parseInt(digits, radix)
  return Number.isSafeInteger(codePoint) && isXmlCodePoint(codePoint)
    ? Effect.succeed(String.fromCodePoint(codePoint))
    : Effect.fail(parseError('invalid-xml'))
}

const decodeEntity = (token: string): Effect.Effect<string, ParseError> => {
  if (token === '&amp;') return Effect.succeed('&')
  if (token === '&lt;') return Effect.succeed('<')
  if (token === '&gt;') return Effect.succeed('>')
  if (token === '&quot;') return Effect.succeed('"')
  if (token === '&apos;') return Effect.succeed("'")
  if (token.startsWith('&#x')) return decodeNumericEntity(token, 16, 3)
  if (token.startsWith('&#')) return decodeNumericEntity(token, 10, 2)
  return Effect.fail(parseError('invalid-xml'))
}

const decodeTextPart = (part: string): Effect.Effect<string, ParseError> =>
  part.startsWith('&')
    ? decodeEntity(part)
    : part.includes('&')
      ? Effect.fail(parseError('invalid-xml'))
      : Effect.succeed(part)

const decodeXmlText = (encoded: string): Effect.Effect<string, ParseError> =>
  encoded.includes(']]>')
    ? Effect.fail(parseError('invalid-xml'))
    : Effect.forEach(encoded.split(ENTITY_TOKEN), decodeTextPart).pipe(
        Effect.map((parts) => parts.join('')),
        Effect.filterOrFail(isXmlText, () => parseError('invalid-xml')),
      )

const addText = (cursor: Cursor, value: string): Effect.Effect<Cursor, ParseError> => {
  if (value.length > MAX_TEXT_LENGTH || cursor.textLength + value.length > MAX_TOTAL_TEXT_LENGTH) {
    return Effect.fail(parseError('text-too-large'))
  }
  return Effect.succeed({ ...cursor, textLength: cursor.textLength + value.length })
}

const readAttribute = Effect.fn('RoleResponseXml.readAttribute')(function* (cursor: Cursor) {
  const parsedName = yield* readName(cursor)
  const afterEquals = yield* expectLiteral(skipWhitespace(parsedName.cursor), '=')
  const quoted = skipWhitespace(afterEquals)
  const quote = characterAt(quoted)
  if (quote !== '"') {
    return yield* Effect.fail(parseError('invalid-xml'))
  }

  const valueStart = quoted.offset + 1
  const valueEnd = quoted.source.indexOf(quote, valueStart)
  if (valueEnd < 0) return yield* Effect.fail(parseError('invalid-xml'))
  const encoded = quoted.source.slice(valueStart, valueEnd)
  if (encoded.includes('<')) return yield* Effect.fail(parseError('invalid-xml'))
  const value = yield* decodeXmlText(encoded)
  const counted = yield* addText({ ...quoted, offset: valueEnd + 1 }, value)

  return {
    attribute: { name: parsedName.name, value },
    cursor: counted,
  } satisfies ParsedAttribute
})

const readAttributes = Effect.fn('RoleResponseXml.readAttributes')(function* (
  cursor: Cursor,
  attributes: ReadonlyArray<XmlAttribute>,
): Effect.fn.Return<ParsedAttributes, ParseError> {
  const afterWhitespace = skipWhitespace(cursor)
  if (afterWhitespace.source.startsWith('/>', afterWhitespace.offset)) {
    return yield* Effect.fail(parseError('invalid-xml'))
  }
  if (afterWhitespace.source.startsWith('>', afterWhitespace.offset)) {
    return {
      attributes,
      cursor: { ...afterWhitespace, offset: afterWhitespace.offset + 1 },
    }
  }
  if (afterWhitespace.offset === cursor.offset) {
    return yield* Effect.fail(parseError('invalid-xml'))
  }
  if (cursor.attributeCount >= MAX_XML_ATTRIBUTES) {
    return yield* Effect.fail(parseError('too-many-attributes'))
  }

  const parsed = yield* readAttribute(afterWhitespace)
  if (attributes.some((attribute) => attribute.name === parsed.attribute.name)) {
    return yield* Effect.fail(parseError('invalid-xml'))
  }
  return yield* readAttributes(
    { ...parsed.cursor, attributeCount: parsed.cursor.attributeCount + 1 },
    [...attributes, parsed.attribute],
  )
})

const readClosingTag = Effect.fn('RoleResponseXml.readClosingTag')(function* (
  cursor: Cursor,
  expectedName: string,
) {
  const afterOpen = yield* expectLiteral(cursor, '</')
  const parsedName = yield* readName(afterOpen)
  if (parsedName.name !== expectedName) return yield* Effect.fail(parseError('invalid-xml'))
  return yield* expectLiteral(skipWhitespace(parsedName.cursor), '>')
})

const readElementInternal = Effect.fn('RoleResponseXml.readElement')(function* (
  cursor: Cursor,
  depth: number,
): Effect.fn.Return<ParsedElement, ParseError> {
  if (depth > MAX_XML_DEPTH) {
    return yield* Effect.fail(parseError('maximum-depth-exceeded'))
  }
  if (cursor.elementCount >= MAX_XML_ELEMENTS) {
    return yield* Effect.fail(parseError('too-many-elements'))
  }

  const afterOpen = yield* expectLiteral(cursor, '<')
  const marker = characterAt(afterOpen)
  if (marker === undefined || marker === '!' || marker === '?' || marker === '/') {
    return yield* Effect.fail(parseError('invalid-xml'))
  }
  const parsedName = yield* readName(afterOpen)
  const counted = { ...parsedName.cursor, elementCount: parsedName.cursor.elementCount + 1 }
  const parsedAttributes = yield* readAttributes(counted, [])

  const parsedChildren = yield* readChildren(parsedAttributes.cursor, parsedName.name, depth)
  return {
    element: {
      _tag: 'Element',
      name: parsedName.name,
      attributes: parsedAttributes.attributes,
      children: parsedChildren.children,
    },
    cursor: parsedChildren.cursor,
  }
})

const readChildren = Effect.fn('RoleResponseXml.readChildren')(function* (
  cursor: Cursor,
  parentName: string,
  parentDepth: number,
  children: ReadonlyArray<XmlNode> = [],
): Effect.fn.Return<ParsedChildren, ParseError> {
  if (cursor.source.startsWith('</', cursor.offset)) {
    const afterClose = yield* readClosingTag(cursor, parentName)
    return { children, cursor: afterClose }
  }

  const marker = characterAt(cursor)
  if (marker === undefined) return yield* Effect.fail(parseError('invalid-xml'))
  if (marker === '<') {
    const parsed = yield* readElementInternal(cursor, parentDepth + 1)
    return yield* readChildren(parsed.cursor, parentName, parentDepth, [
      ...children,
      parsed.element,
    ])
  }

  const textEnd = cursor.source.indexOf('<', cursor.offset)
  if (textEnd < 0) return yield* Effect.fail(parseError('invalid-xml'))
  const encoded = cursor.source.slice(cursor.offset, textEnd)
  const value = yield* decodeXmlText(encoded)
  const counted = yield* addText({ ...cursor, offset: textEnd }, value)
  const text: XmlText = { _tag: 'Text', value }
  return yield* readChildren(counted, parentName, parentDepth, [...children, text])
})

export const readDocument = Effect.fn('RoleResponseXml.readDocument')(function* (source: string) {
  if (Buffer.byteLength(source, 'utf8') > MAX_XML_BYTES) {
    return yield* Effect.fail(parseError('document-too-large'))
  }

  const initial: Cursor = {
    source,
    offset: 0,
    elementCount: 0,
    attributeCount: 0,
    textLength: 0,
  }
  const parsed = yield* readElementInternal(skipWhitespace(initial), 1)
  const completed = skipWhitespace(parsed.cursor)
  if (completed.offset !== source.length) {
    return yield* Effect.fail(parseError('invalid-xml'))
  }
  return parsed.element
})

export const attributeValue = (element: XmlElement, name: string): string | undefined => {
  const attribute = element.attributes.find((candidate) => candidate.name === name)
  return attribute === undefined ? undefined : attribute.value
}

export const hasOnlyAttributes = (element: XmlElement, names: ReadonlyArray<string>): boolean =>
  element.attributes.every((attribute) => names.includes(attribute.name))

export const structuralChildren = (element: XmlElement): ReadonlyArray<XmlElement> | undefined => {
  const elements: Array<XmlElement> = []
  for (const child of element.children) {
    if (child._tag === 'Element') {
      elements.push(child)
    } else if (!isWhitespaceText(child.value)) {
      return undefined
    }
  }
  return elements
}

export const plainText = (element: XmlElement): string | undefined => {
  if (element.attributes.length !== 0) return undefined
  const parts: Array<string> = []
  for (const child of element.children) {
    if (child._tag === 'Element') return undefined
    parts.push(child.value)
  }
  return parts.join('')
}
