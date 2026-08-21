export {}

declare module '@google/genai' {
  interface GoogleGenAIOptions {
    /** Instance-local transport seam supplied by the Yokai SDK patch or published fork. */
    fetchImplementation?: (url: URL, init: RequestInit) => Promise<Response>
  }
}
