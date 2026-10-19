export function refinedRequest(current: string, followUp?: string): string {
  const update = followUp?.trim();
  if (followUp !== undefined && !update) throw new Error("Enter a follow-up before sending.");
  const request = update
    ? `${current.trim()}\n\nFollow-up supplied by the delivery lead (updates earlier requirements where they conflict):\n${update}`
    : current.trim();
  if (new TextEncoder().encode(request).byteLength > 16 * 1024) {
    throw new Error("The full request, attached text, and follow-ups must stay within 16 KiB. Shorten the update or start a new request. Nothing was submitted.");
  }
  return request;
}
