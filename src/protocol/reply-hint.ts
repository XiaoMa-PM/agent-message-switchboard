// INPUT: The receiving adapter's reply-tool phrase and the inbound v1 messageId.
// OUTPUT: One fixed reply-guidance sentence; the id is an escaped JSON string, so a crafted id cannot add lines to the header.
// POS: Shared daily inbound-header wording; guidance for the model only, never authority, routing or an automatic reply.
export function replyHint(tool: string, messageId: string): string {
  const id = JSON.stringify(messageId)
    .replace(/[\u0085\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  return `如需回复对方，请调用 ${tool}（inReplyTo=${id}）；直接在本会话回答只有本会话用户看得到，对方收不到。`;
}
