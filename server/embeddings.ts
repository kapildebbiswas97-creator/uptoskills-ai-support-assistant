import { GoogleGenAI } from '@google/genai';

export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';

export async function embedText(text: string, apiKey = process.env.GEMINI_API_KEY): Promise<number[]> {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required to create knowledge embeddings');
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });
  const values = response.embeddings?.[0]?.values;
  if (!values || values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Expected a ${EMBEDDING_DIMENSIONS}-dimension embedding`);
  }
  return values;
}
