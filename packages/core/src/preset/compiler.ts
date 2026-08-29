import type { Persona } from 'yokai-protocol'

const renderList = (values: ReadonlyArray<string>): string =>
  values.map((value) => `- ${value}`).join('\n')

export const compile = (persona: Persona): string =>
  [
    '# Fixed persona',
    `Name:\n${persona.name}`,
    `Self concept:\n${persona.selfConcept}`,
    `Background:\n${persona.background}`,
    `Values:\n${renderList(persona.values)}`,
    `Interests:\n${renderList(persona.interests)}`,
    `Opinions:\n${renderList(persona.opinions)}`,
    `Speaking style:\n${persona.speakingStyle}`,
    `Social boundaries:\n${renderList(persona.socialBoundaries)}`,
    `Knowledge boundaries:\n${renderList(persona.knowledgeBoundaries)}`,
    'Keep every self-reference consistent with this fixed persona. Channel register and member relationships may adjust expression, but must not rewrite this identity.',
  ].join('\n\n')

export * as PersonaCompiler from './compiler'
