import ky from "ky";
import { toast } from "sonner";
import { useState } from "react";
import {
  CopyIcon,
  HistoryIcon,
  PlusIcon
} from "lucide-react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";

import {
  useConversation,
  useConversations,
  useCreateConversation,
  useMessages,
} from "../hooks/use-conversations";

import { Id } from "../../../../convex/_generated/dataModel";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { PastConversationsDialog } from "./past-conversations-dialog";

interface ConversationSidebarProps {
  projectId: Id<"projects">;
};

const THINKING_START_MARKER = "<!--POLARIS_THINKING_START-->";
const THINKING_END_MARKER = "<!--POLARIS_THINKING_END-->";

const splitThinkingFromContent = (content: string) => {
  const startIndex = content.indexOf(THINKING_START_MARKER);
  const endIndex = content.indexOf(THINKING_END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return { thinking: null, response: content };
  }

  const thinking = content
    .slice(startIndex + THINKING_START_MARKER.length, endIndex)
    .trim();
  const response = `${content.slice(0, startIndex)}${content.slice(endIndex + THINKING_END_MARKER.length)}`.trim();

  return {
    thinking: thinking || null,
    response,
  };
};

export const ConversationSidebar = ({
  projectId,
}: ConversationSidebarProps) => {
  const [input, setInput] = useState("");
  const [
    selectedConversationId,
    setSelectedConversationId,
  ] = useState<Id<"conversations"> | null>(null);
  const [
    pastConversationsOpen,
    setPastConversationsOpen
  ] = useState(false);

  const createConversation = useCreateConversation();
  const conversations = useConversations(projectId);

  const activeConversationId =
    selectedConversationId ?? conversations?.[0]?._id ?? null;

  const activeConversation = useConversation(activeConversationId);
  const conversationMessages = useMessages(activeConversationId);

  // Check if any message is currently processing
  const isProcessing = conversationMessages?.some(
    (msg) => msg.status === "processing"
  );

  const handleCancel = async () => {
    try {
      await ky.post("/api/messages/cancel", {
        json: { projectId },
      });
    } catch {
      toast.error("Unable to cancel request");
    }
  };

  const handleCreateConversation = async () => {
    try {
      const newConversationId = await createConversation({
        projectId,
        title: DEFAULT_CONVERSATION_TITLE,
      });
      setSelectedConversationId(newConversationId);
      return newConversationId;
    } catch {
      toast.error("Unable to create new conversation");
      return null;
    }
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    // If processing and no new message, this is just a stop function
    if (isProcessing && !message.text) {
      await handleCancel()
      setInput("");
      return;
    }

    let conversationId = activeConversationId;

    if (!conversationId) {
      conversationId = await handleCreateConversation();
      if (!conversationId) {
        return;
      }
    }

    // Trigger Inngest function via API
    try {
      await ky.post("/api/messages", {
        json: {
          conversationId,
          message: message.text,
        },
      });
    } catch {
      toast.error("Message failed to send");
    }

    setInput("");
  }

  return (
    <>
      <PastConversationsDialog
        projectId={projectId}
        open={pastConversationsOpen}
        onOpenChange={setPastConversationsOpen}
        onSelect={setSelectedConversationId}
      />
      <div className="flex flex-col h-full bg-sidebar">
        <div className="h-8.75 flex items-center justify-between border-b">
          <div className="text-sm truncate pl-3">
            {activeConversation?.title ?? DEFAULT_CONVERSATION_TITLE}
          </div>
          <div className="flex items-center px-1 gap-1">
            <Button
              size="icon-xs"
              variant="highlight"
              onClick={() => setPastConversationsOpen(true)}
            >
              <HistoryIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="highlight"
              onClick={handleCreateConversation}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        <Conversation className="flex-1">
          <ConversationContent>
            {conversationMessages?.map((message, messageIndex) => (
              (() => {
                const parsedContent =
                  message.role === "assistant"
                    ? splitThinkingFromContent(message.content)
                    : { thinking: null, response: message.content };

                return (
                  <Message
                    key={message._id}
                    from={message.role}
                  >
                    <MessageContent>
                      {message.status === "processing" ? (
                        <Reasoning isStreaming defaultOpen>
                          <ReasoningTrigger />
                          <ReasoningContent>
                            Running tools and preparing a response.
                          </ReasoningContent>
                        </Reasoning>
                      ) : message.status === "cancelled" ? (
                        <span className="text-muted-foreground italic">
                          Request cancelled
                        </span>
                      ) : (
                        <>
                          {message.role === "assistant" && parsedContent.thinking && (
                            <Reasoning defaultOpen={false}>
                              <ReasoningTrigger />
                              <ReasoningContent>{parsedContent.thinking}</ReasoningContent>
                            </Reasoning>
                          )}
                          <MessageResponse>{parsedContent.response}</MessageResponse>
                        </>
                      )}
                    </MessageContent>
                    {message.role === "assistant" &&
                      message.status === "completed" &&
                      messageIndex === (conversationMessages?.length ?? 0) - 1 && (
                        <MessageActions>
                          <MessageAction
                            onClick={() => {
                              navigator.clipboard.writeText(message.content)
                            }}
                            label="Copy"
                          >
                            <CopyIcon className="size-3" />
                          </MessageAction>
                        </MessageActions>
                      )
                    }
                  </Message>
                );
              })()
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        <div className="p-3">
          <PromptInput
            onSubmit={handleSubmit}
            className="mt-2"
          >
            <PromptInputBody>
              <PromptInputTextarea
                placeholder="Ask Polaris anything..."
                onChange={(e) => setInput(e.target.value)}
                value={input}
                disabled={isProcessing}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools />
              <PromptInputSubmit
                disabled={isProcessing ? false : !input}
                status={isProcessing ? "streaming" : undefined}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </>
  );
};
