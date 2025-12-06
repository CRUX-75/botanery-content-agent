// src/lib/caption-builder.ts

export function createCaption({
  hook,
  body,
  cta,
  hashtag_block,
}: {
  hook: string;
  body: string;
  cta: string;
  hashtag_block?: string | null;
}): string {
  const parts = [hook, '', body, '', cta];
  if (hashtag_block) parts.push('', hashtag_block);
  return parts.join('\n');
}
