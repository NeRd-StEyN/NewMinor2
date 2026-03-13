import { generateText, Output } from "ai";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const hasStatusCode = (error: unknown, statusCode: number) => {
  return getErrorMessage(error).includes(`status code: ${statusCode}`);
};

const isRateLimitError = (error: unknown) => {
  const message = getErrorMessage(error).toLowerCase();

  return (
    hasStatusCode(error, 429) ||
    message.includes("resource_exhausted") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("rate-limiting")
  );
};

const isOllamaEnabled = () => {
  return (
    process.env.OLLAMA_ENABLED === "true" ||
    Boolean(process.env.OLLAMA_MODEL) ||
    Boolean(process.env.OLLAMA_BASE_URL)
  );
};

const suggestionSchema = z.object({
  suggestion: z
    .string()
    .describe(
      "The code to insert at cursor, or empty string if no completion needed"
    ),
});

const SUGGESTION_PROMPT = `You are a code suggestion assistant.

<context>
<file_name>{fileName}</file_name>
<previous_lines>
{previousLines}
</previous_lines>
<current_line number="{lineNumber}">{currentLine}</current_line>
<before_cursor>{textBeforeCursor}</before_cursor>
<after_cursor>{textAfterCursor}</after_cursor>
<next_lines>
{nextLines}
</next_lines>
<full_code>
{code}
</full_code>
</context>

<instructions>
Follow these steps IN ORDER:

1. First, look at next_lines. If next_lines contains ANY code, check if it continues from where the cursor is. If it does, return empty string immediately - the code is already written.

2. Check if before_cursor ends with a complete statement (;, }, )). If yes, return empty string.

3. Only if steps 1 and 2 don't apply: suggest what should be typed at the cursor position, using context from full_code.

Your suggestion is inserted immediately after the cursor, so never suggest code that's already in the file.
</instructions>`;

export async function POST(request: Request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 403 },
      );
    }

    const {
      fileName,
      code,
      currentLine,
      previousLines,
      textBeforeCursor,
      textAfterCursor,
      nextLines,
      lineNumber,
    } = await request.json();

    if (!code) {
      return NextResponse.json(
        { error: "Code is required" },
        { status: 400 }
      );
    }

    const prompt = SUGGESTION_PROMPT
      .replace("{fileName}", fileName)
      .replace("{code}", code)
      .replace("{currentLine}", currentLine)
      .replace("{previousLines}", previousLines || "")
      .replace("{textBeforeCursor}", textBeforeCursor)
      .replace("{textAfterCursor}", textAfterCursor)
      .replace("{nextLines}", nextLines || "")
      .replace("{lineNumber}", lineNumber.toString());

    const modelCandidates: Array<{
      provider: "groq" | "gemini" | "ollama";
      model: Parameters<typeof generateText>[0]["model"];
    }> = [];

    if (process.env.GROQ_API_KEY) {
      modelCandidates.push({
        provider: "groq",
        model: createOpenAI({
          apiKey: process.env.GROQ_API_KEY,
          baseURL: "https://api.groq.com/openai/v1",
        })("llama-3.3-70b-versatile", { structuredOutputs: false }),
      });
    }

    const geminiKeys = [
      process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      process.env.GOOGLE_GENERATIVE_AI_API_KEY_2,
      process.env.GOOGLE_GENERATIVE_AI_API_KEY_3,
    ].filter(Boolean);

    for (const key of geminiKeys) {
      modelCandidates.push({
        provider: "gemini",
        model: createGoogleGenerativeAI({
          apiKey: key!,
        })("gemini-1.5-flash-latest", { structuredOutputs: false }),
      });
    }

    if (isOllamaEnabled()) {
      modelCandidates.push({
        provider: "ollama",
        model: createOpenAI({
          apiKey: process.env.OLLAMA_API_KEY || "ollama",
          baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
        })(process.env.OLLAMA_MODEL || "qwen2.5-coder:1.5b", { structuredOutputs: false }),
      });
    }

    if (modelCandidates.length === 0) {
      return NextResponse.json(
        { error: "No AI provider configured" },
        { status: 500 },
      );
    }

    let lastError: unknown;

    for (const candidate of modelCandidates) {
      try {
        const { output } = await generateText({
          model: candidate.model,
          output: Output.object({ schema: suggestionSchema }),
          prompt,
        });

        return NextResponse.json({ suggestion: output.suggestion });
      } catch (error) {
        lastError = error;
        const hasFallback = modelCandidates.at(-1)?.provider !== candidate.provider;

        if (hasFallback) {
          console.warn(
            `Suggestion provider ${candidate.provider} failed, falling back to next provider`,
            error,
          );
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  } catch (error) {
    console.error("Suggestion error: ", error);

    if (isRateLimitError(error)) {
      return NextResponse.json(
        { error: "AI provider is rate-limiting requests. Please retry shortly." },
        { status: 429 },
      );
    }

    return NextResponse.json(
      { error: "Failed to generate suggestion" },
      { status: 500 },
    );
  }
}
