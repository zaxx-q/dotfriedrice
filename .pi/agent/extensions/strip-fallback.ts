import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const targetText = "I wasn't able to finish putting together a response for that. Could you try rephrasing your request, or let me know if you'd like me to try again?";

  // Helper to remove target text from an assistant message's content
  const cleanMessageContent = (msg: any) => {
    if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const originalLength = msg.content.length;
        const filteredContent = msg.content.filter((block: any) => {
          if (block.type === "text" && block.text?.trim() === targetText) {
            return false;
          }
          return true;
        });
        if (filteredContent.length !== originalLength) {
          return {
            ...msg,
            content: filteredContent,
          };
        }
      } else if (typeof msg.content === "string" && msg.content.trim() === targetText) {
        return {
          ...msg,
          content: "",
        };
      }
    }
    return msg;
  };

  // 1. Strip the fallback message from the LLM context so it doesn't pollute subsequent turns
  pi.on("context", async (event) => {
    let modified = false;
    const messages = event.messages.map((msg: any) => {
      const cleaned = cleanMessageContent(msg);
      if (cleaned !== msg) {
        modified = true;
      }
      return cleaned;
    });

    if (modified) {
      return { messages };
    }
  });

  // 2. Intercept message finalization to prevent it from being saved to the session in the first place
  pi.on("message_end", async (event) => {
    const cleaned = cleanMessageContent(event.message);
    if (cleaned !== event.message) {
      return { message: cleaned };
    }
  });
}
