import { createAgent, openai, gemini, createNetwork } from '@inngest/agent-kit';

import { inngest } from "@/inngest/client";
import { Id } from "../../../../convex/_generated/dataModel";
import { NonRetriableError } from "inngest";
import { convex } from "@/lib/convex-client";
import { api } from "../../../../convex/_generated/api";
import {
  CODING_AGENT_SYSTEM_PROMPT,
  TITLE_GENERATOR_SYSTEM_PROMPT
} from "./constants";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { createReadFilesTool } from './tools/read-files';
import { createListFilesTool } from './tools/list-files';
import { createUpdateFileTool } from './tools/update-file';
import { createCreateFilesTool } from './tools/create-files';
import { createCreateFileTool } from './tools/create-file';
import { createCreateFolderTool } from './tools/create-folder';
import { createRenameFileTool } from './tools/rename-file';
import { createDeleteFilesTool } from './tools/delete-files';
import { createScrapeUrlsTool } from './tools/scrape-urls';

interface MessageEvent {
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  message: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const hasStatusCode = (error: unknown, statusCode: number) => {
  return getErrorMessage(error).includes(`status code: ${statusCode}`);
};

const THINKING_START_MARKER = "<!--POLARIS_THINKING_START-->";
const THINKING_END_MARKER = "<!--POLARIS_THINKING_END-->";
const NO_TOOL_CALLS_FOR_FILE_REQUEST = "NO_TOOL_CALLS_FOR_FILE_REQUEST";

const isPseudoToolCallText = (text: string) => {
  const normalized = text.trim();
  return (
    normalized.includes("\"arguments\"") &&
    normalized.includes("\"name\"") &&
    /(createFile|createFiles|createFolder|updateFile|listFiles|readFiles|deleteFiles|renameFile)/i.test(normalized)
  );
};

const extractAssistantResponseText = (result: {
  state: {
    results: Array<{
      output?: Array<{
        type?: string;
        role?: string;
        content?: string | Array<{ text: string }>;
      }>;
    }>;
  };
}) => {
  const lastResult = result.state.results.at(-1);
  const textMessage = lastResult?.output?.find(
    (m) => m.type === "text" && m.role === "assistant"
  );

  if (!textMessage?.content) {
    return "I processed your request. Let me know if you need anything else!";
  }

  return typeof textMessage.content === "string"
    ? textMessage.content
    : textMessage.content.map((c) => c.text).join("");
};

const buildThinkingTrace = (result: { state: { results: Array<{ output?: unknown[] }> } }) => {
  const lines: string[] = [];

  for (const step of result.state.results) {
    const output = Array.isArray(step.output) ? step.output : [];

    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const typedItem = item as {
        type?: string;
        name?: string;
        tool_name?: string;
      };

      if (typedItem.type === "tool_call") {
        const toolName = typedItem.name || typedItem.tool_name || "unknown_tool";
        lines.push(`- Called \`${toolName}\``);
      }
    }
  }

  return lines.join("\n");
};

const hasAnyToolCalls = (result: { state: { results: Array<{ output?: unknown[] }> } }) => {
  return result.state.results.some((step) => {
    const output = Array.isArray(step.output) ? step.output : [];

    return output.some((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }

      return (item as { type?: string }).type === "tool_call";
    });
  });
};

const requestLikelyNeedsTools = (message: string) => {
  const normalized = message.toLowerCase();

  return /(create|make|build|add|write|update|edit|modify|refactor|rename|delete|remove|move)\b/.test(normalized) &&
    /(file|files|folder|folders|component|page|route|api|project|app|screen|directory|module)\b/.test(normalized);
};

const getUserFacingFailureMessage = (error: unknown) => {
  const message = getErrorMessage(error);

  if (message.includes("ECONNREFUSED") || message.includes("127.0.0.1:11434")) {
    return "I couldn't reach Ollama at http://127.0.0.1:11434. Start Ollama with `ollama serve` and retry.";
  }

  if (message.includes("model") && message.includes("not found")) {
    return "The configured Ollama model was not found locally. Run `ollama pull <model>` and retry.";
  }

  if (message.includes("No AI API key configured")) {
    return "I couldn't process this request because no AI provider is configured. Add ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or GROQ_API_KEY, or enable Ollama with OLLAMA_ENABLED=true, then restart your servers.";
  }

  if (message.includes("POLARIS_CONVEX_INTERNAL_KEY is not configured")) {
    return "I couldn't process this request because POLARIS_CONVEX_INTERNAL_KEY is missing. Set it in .env.local and restart your servers.";
  }

  if (message.includes("rate-limiting requests")) {
    return "The AI provider is currently rate-limiting requests. Please retry in a moment or switch providers.";
  }

  if (message.includes("provider rejected the request")) {
    return "The AI provider rejected this request. Check your API key and model configuration, then try again.";
  }

  if (message.includes("executed file tools")) {
    return "I couldn't apply file changes because the configured providers responded in chat instead of using file tools. Please retry, or switch to a provider/model with stronger tool-calling support.";
  }

  if (hasStatusCode(error, 429)) {
    return "The AI provider is currently rate-limiting requests. Please retry in a moment or switch providers.";
  }

  if (hasStatusCode(error, 400)) {
    return "The AI provider rejected this request. Check your API key and model configuration, then try again.";
  }

  return "My apologies, I encountered an error while processing your request. Let me know if you need anything else!";
};

function getModelCandidates() {
  const ollamaOnly = process.env.OLLAMA_ONLY === "true";
  const candidates: Array<{
    provider: "groq" | "gemini" | "ollama";
    createModel: () => ReturnType<typeof gemini> | ReturnType<typeof openai>;
  }> = [];

  if (!ollamaOnly && process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    candidates.push({
      provider: "gemini",
      createModel: () =>
        gemini({
          model: "gemini-2.0-flash",
          apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        }),
    });
  }

  if (!ollamaOnly && process.env.GROQ_API_KEY) {
    candidates.push({
      provider: "groq",
      createModel: () =>
        openai({
          model: "llama-3.1-70b-versatile",
          apiKey: process.env.GROQ_API_KEY,
          baseUrl: "https://api.groq.com/openai/v1",
        }),
    });
  }

  const ollamaEnabled =
    process.env.OLLAMA_ENABLED === "true" ||
    Boolean(process.env.OLLAMA_MODEL) ||
    Boolean(process.env.OLLAMA_BASE_URL);

  if (ollamaEnabled) {
    candidates.push({
      provider: "ollama",
      createModel: () =>
        openai({
          model: process.env.OLLAMA_MODEL || "qwen2.5-coder:1.5b",
          apiKey: process.env.OLLAMA_API_KEY || "ollama",
          baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
        }),
    });
  }

  if (candidates.length === 0) {
    throw new NonRetriableError(
      "No AI provider configured. Set OLLAMA_ONLY=true and OLLAMA_ENABLED=true for local-only mode, or configure ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GROQ_API_KEY."
    );
  }

  return candidates;
}

export const processMessage = inngest.createFunction(
  {
    id: "process-message",
    // No retries: a 429 retry immediately hits the rate limit again, causing a cascade.
    // The onFailure handler below gives the user a proper error message instead.
    retries: 0,
    cancelOn: [
      {
        event: "message/cancel",
        if: "event.data.messageId == async.data.messageId",
      },
    ],
    onFailure: async ({ event, error, step }) => {
      const { messageId } = event.data.event.data as MessageEvent;
      const internalKey = process.env.POLARIS_CONVEX_INTERNAL_KEY;

      // Update the message with error content
      if (internalKey) {
        await step.run("update-message-on-failure", async () => {
          await convex.mutation(api.system.updateMessageContent, {
            internalKey,
            messageId,
            content: getUserFacingFailureMessage(error),
          });
        });
      }
    }
  },
  {
    event: "message/sent",
  },
  async ({ event, step }) => {
    const {
      messageId,
      conversationId,
      projectId,
      message
    } = event.data as MessageEvent;

    console.log("Processing message:", messageId);

    const internalKey = process.env.POLARIS_CONVEX_INTERNAL_KEY;
    const isOllamaOnly = process.env.OLLAMA_ONLY === "true";

    if (!internalKey) {
      throw new NonRetriableError("POLARIS_CONVEX_INTERNAL_KEY is not configured");
    }

    // TODO: Check if this is needed
    await step.sleep("wait-for-db-sync", "1s");

    // Get conversation for title generation check
    const conversation = await step.run("get-conversation", async () => {
      return await convex.query(api.system.getConversationById, {
        internalKey,
        conversationId,
      });
    });

    if (!conversation) {
      throw new NonRetriableError("Conversation not found");
    }

    // Fetch recent messages for conversation context
    const recentMessages = await step.run("get-recent-messages", async () => {
      return await convex.query(api.system.getRecentMessages, {
        internalKey,
        conversationId,
        limit: 4,
      });
    });

    // Build system prompt with conversation history (exclude the current processing message)
    let systemPrompt = CODING_AGENT_SYSTEM_PROMPT;

    // Filter out the current processing message and empty messages
    const contextMessages = recentMessages.filter(
      (msg) => msg._id !== messageId && msg.content.trim() !== ""
    );

    if (contextMessages.length > 0) {
      const historyText = contextMessages
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");

      systemPrompt += `\n\n## Previous Conversation (for context only - do NOT repeat these responses):\n${historyText}\n\n## Current Request:\nRespond ONLY to the user's new message below. Do not repeat or reference your previous responses.`;
    }

    const modelCandidates = getModelCandidates();

    const createCodingNetwork = (
      modelCandidate: (typeof modelCandidates)[number]
    ) => {
      const codingAgent = createAgent({
        name: "polaris",
        description: "An expert AI coding assistant",
        system: systemPrompt,
        model: modelCandidate.createModel(),
        tools: [
          createListFilesTool({ internalKey, projectId }),
          createReadFilesTool({ internalKey }),
          createUpdateFileTool({ internalKey }),
          createCreateFileTool({ projectId, internalKey }),
          createCreateFilesTool({ projectId, internalKey }),
          createCreateFolderTool({ projectId, internalKey }),
          createRenameFileTool({ internalKey }),
          createDeleteFilesTool({ internalKey }),
          createScrapeUrlsTool(),
        ],
      });

      return createNetwork({
        name: "polaris-network",
        agents: [codingAgent],
        // Lower iterations keeps responses much faster, especially on local Ollama.
        maxIter: 5,
        router: ({ network }) => {
          const lastResult = network.state.results.at(-1);
          const hasTextResponse = lastResult?.output.some(
            (m) => m.type === "text" && m.role === "assistant"
          );
          const hasToolCalls = lastResult?.output.some(
            (m) => m.type === "tool_call"
          );

          // Only stop if there's text WITHOUT tool calls (final response)
          if (hasTextResponse && !hasToolCalls) {
            return undefined;
          }
          return codingAgent;
        }
      });
    };

    // Run the agent with provider fallback on rate limits.
    let result: Awaited<ReturnType<ReturnType<typeof createCodingNetwork>["run"]>> | undefined;
    let successfulModelCandidate = modelCandidates[0];

    for (let index = 0; index < modelCandidates.length; index++) {
      const candidate = modelCandidates[index];
      const network = createCodingNetwork(candidate);

      try {
        const candidateResult = await network.run(message);
        const needsTools = requestLikelyNeedsTools(message);
        const usedTools = hasAnyToolCalls(candidateResult as { state: { results: Array<{ output?: unknown[] }> } });

        if (needsTools && !usedTools) {
          const hasNextProvider = index < modelCandidates.length - 1;

          console.warn(
            `Provider ${candidate.provider} returned a text-only response for a file operation request.`
          );

          if (hasNextProvider) {
            console.warn(
              `Trying next provider because ${candidate.provider} did not execute any tools.`
            );
            continue;
          }

          const repairResult = await network.run(
            `You must use the available file tools to complete this request. Do not answer with code in chat. First inspect the project with listFiles, then read/update/create the needed files, and only after the file operations are complete return a short summary.\n\nOriginal user request: ${message}`
          );

          if (!hasAnyToolCalls(repairResult as { state: { results: Array<{ output?: unknown[] }> } })) {
            throw new Error(NO_TOOL_CALLS_FOR_FILE_REQUEST);
          }

          result = repairResult;
          successfulModelCandidate = candidate;
          break;
        }

        result = candidateResult;
        successfulModelCandidate = candidate;
        break;
      } catch (error) {
        if (getErrorMessage(error).includes(NO_TOOL_CALLS_FOR_FILE_REQUEST)) {
          const hasNextProvider = index < modelCandidates.length - 1;

          if (hasNextProvider) {
            console.warn(
              `Provider ${candidate.provider} did not execute file tools. Trying next configured provider.`
            );
            continue;
          }

          throw new NonRetriableError(
            "None of the configured AI providers executed file tools for this file-change request. Retry, or adjust provider/model settings."
          );
        }

        if (hasStatusCode(error, 400)) {
          throw new NonRetriableError(
            "The configured AI provider rejected the request. Check the API key and model configuration."
          );
        }

        if (!hasStatusCode(error, 429)) {
          throw error;
        }

        const hasNextProvider = index < modelCandidates.length - 1;
        if (!hasNextProvider) {
          throw new NonRetriableError(
            "All configured AI providers are rate-limiting requests. Retry shortly or switch to a provider with higher limits."
          );
        }

        console.warn(
          `Provider ${candidate.provider} is rate-limiting requests (429). Trying next configured provider.`
        );
      }
    }

    if (!result) {
      throw new NonRetriableError("Unable to process the message with configured AI providers.");
    }

    let assistantResponse = extractAssistantResponseText(result);

    // Small local models may print fake JSON tool payloads instead of executing tools.
    // Retry once with an explicit correction prompt before persisting output.
    if (isPseudoToolCallText(assistantResponse)) {
      const repairNetwork = createCodingNetwork(successfulModelCandidate);
      const repairedResult = await repairNetwork.run(
        `Your previous output incorrectly printed raw tool JSON. For the same request below, execute real tool calls instead of printing JSON. Then return only a brief completion summary.\n\nUser request: ${message}`
      );

      result = repairedResult;
      assistantResponse = extractAssistantResponseText(repairedResult);
    }

    const thinkingTrace = buildThinkingTrace(result as { state: { results: Array<{ output?: unknown[] }> } });
    const persistedContent = thinkingTrace
      ? `${THINKING_START_MARKER}\n${thinkingTrace}\n${THINKING_END_MARKER}\n\n${assistantResponse}`
      : assistantResponse;

    // Update the assistant message with the response (this also sets status to completed)
    await step.run("update-assistant-message", async () => {
      await convex.mutation(api.system.updateMessageContent, {
        internalKey,
        messageId,
        content: persistedContent,
      })
    });

    // Generate conversation title AFTER the main response (non-blocking)
    // This way, even if title generation fails, the user already has their response
    const shouldGenerateTitle =
      conversation.title === DEFAULT_CONVERSATION_TITLE && !isOllamaOnly;

    if (shouldGenerateTitle) {
      try {
        const titleAgent = createAgent({
          name: "title-generator",
          system: TITLE_GENERATOR_SYSTEM_PROMPT,
          model: successfulModelCandidate.createModel(),
        });

        const { output: titleOutput } = await titleAgent.run(message, { step });

        const titleMessage = titleOutput.find(
          (m) => m.type === "text" && m.role === "assistant"
        );

        if (titleMessage?.type === "text") {
          const title =
            typeof titleMessage.content === "string"
              ? titleMessage.content.trim()
              : titleMessage.content
                .map((c) => c.text)
                .join("")
                .trim();

          if (title) {
            await step.run("update-conversation-title", async () => {
              await convex.mutation(api.system.updateConversationTitle, {
                internalKey,
                conversationId,
                title,
              });
            });
          }
        }
      } catch (titleError) {
        // Title generation failed (likely rate limiting) - log but don't fail the function
        console.warn("Title generation failed, skipping:", titleError);
      }
    }

    return { success: true, messageId, conversationId };
  }
);
