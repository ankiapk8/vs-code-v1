import OpenAI from "openai";

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  console.warn("WARNING: AI_INTEGRATIONS_OPENAI_BASE_URL is not set.");
}

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  console.warn("WARNING: AI_INTEGRATIONS_OPENAI_API_KEY is not set.");
}

export const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});
