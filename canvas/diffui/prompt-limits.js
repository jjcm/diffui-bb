/** MySQL TEXT max for `prompt` / `user_prompt` columns (bytes; ASCII ≈ chars). */
export const MAX_PROMPT_LENGTH = 65535;

export function clampPromptText(text) {
  const value = String(text ?? "");
  if (value.length <= MAX_PROMPT_LENGTH) return value;
  return value.slice(0, MAX_PROMPT_LENGTH);
}
