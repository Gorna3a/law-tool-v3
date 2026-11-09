/**
 * Prompts for OmniRoute/OpenAI chat completions.
 * Version is tracked so prompt updates can be detected.
 */

export const PROMPT_VERSION = 1;

export const SYSTEM_EXTRACTOR = `You are a meticulous transcriber of official legal gazettes. You transcribe exactly what is printed. You never summarise, translate, correct, modernise or complete the text.`;

export const SYSTEM_JUDGE = `You are the judge in a transcription pipeline for legal gazettes. Two independent transcribers (A and B) read the same page image(s). You decide what is really printed by looking at the image, not by trusting either transcriber.`;

export const SHARED_RULES = `RULES:
1. Reading order: finish the whole left column, then the whole right column (pages are usually two columns). A heading spanning both columns comes first.
2. Skip the running header band (journal name, issue number, date, page number) and any page footer.
3. One item per printed paragraph. Join the wrapped lines of a paragraph with a single space. If a line ends with a hyphen, join the next line directly with NO space (compound words such as "quarante-cinq", "procès-verbal").
4. Headings (Titre / Chapitre / Section / Sous-section, or the Arabic equivalents) are separate items: the label is one item, its title the next item.
5. Keep list markers exactly as printed (—, •, *, 1-, a), 1.).
6. Copy characters exactly: accents, curly vs straight apostrophes, « », °, œ, digits (Western or Arabic-Indic as printed), punctuation and odd typography such as "Art.14." or "24-au". Do NOT fix typos of the source.
7. Arabic text: normal Unicode Arabic in logical (right-to-left) order, never presentation forms, never reversed.
8. Tables: one item per row, cells separated by " | ".
9. Illegible text: write [illisible]. Never invent text.`;

const CONTINUES_RULE = `10. "continuesPrevious": true ONLY for the first paragraph of a column when it continues a paragraph that started in the previous column or on the previous page (not indented, does not start a new article). Otherwise false.`;

export function buildPagePrompt(textLayerHint?: string): string {
  let prompt = `Transcribe the body text of the attached page image.\n\n${SHARED_RULES}\n${CONTINUES_RULE}`;

  if (textLayerHint && textLayerHint.trim().length > 20) {
    prompt += `\n\nMachine text layer of this page (HINT ONLY: may be in the wrong column order, garbled Arabic or stray spaces; the image is authoritative):\n<<<\n${textLayerHint}\n>>>`;
  }

  prompt += `\n\nOutput ONLY a JSON object: {"paragraphs":[{"text":"...","continuesPrevious":false}]}`;
  return prompt;
}

export function buildUnitReExtractionPrompt(
  unitKey: string,
  unitDescription: string,
  hints: Array<{ a: string; b: string }> = []
): string {
  let prompt = `Unit key: ${unitKey}\n\nThe attached images are consecutive pages of a legal gazette. Transcribe ONLY: ${unitDescription}\n\n${SHARED_RULES}`;

  if (hints.length > 0) {
    prompt += `\n\nTwo earlier independent readings disagree at these spots. Look very carefully at the image and write what is REALLY printed; do not assume either reading is right:`;
    for (const { a, b } of hints) {
      prompt += `\n- «${a}»  versus  «${b}»`;
    }
  }

  prompt += `\n\nIf this text does not exist on the pages, return an empty list.\nOutput ONLY a JSON object {"paragraphs":[{"text":"..."}]} (join text that continues across a column or page break into one paragraph).`;
  return prompt;
}

export function buildJudgePrompt(
  unitKey: string,
  unitDescription: string,
  textA: string[],
  textB: string[],
  wordDiffs: Array<{ a: string; b: string }>
): string {
  const aJson = JSON.stringify(textA, null, 2);
  const bJson = JSON.stringify(textB, null, 2);

  let prompt = `Unit key: ${unitKey}\n\nTarget: ${unitDescription}\n\n${SHARED_RULES}\n\n`;
  prompt += `Transcription A:\n${aJson}\n\nTranscription B:\n${bJson}\n\n`;

  if (wordDiffs.length > 0) {
    prompt += `Automatic word-level differences:\n`;
    for (const { a, b } of wordDiffs.slice(0, 30)) {
      prompt += `- «${a}»  vs  «${b}»\n`;
    }
    prompt += `\n`;
  }

  prompt += `For each difference say which reading matches the image. Then write your own complete, faithful transcription of the target text as printed (one string per paragraph, same rules).\n\n`;
  prompt += `Output ONLY JSON: {"differences":[{"a":"","b":"","truth":"","correct":"a|b|neither"}],"reading":["..."],"confidence":"high|medium|low","note":""}`;
  return prompt;
}

export function buildVisionTestPrompt(): string {
  return `Transcribe exactly what you see in the image. Output ONLY a JSON object: {"text":"..."}`;
}

export function buildCorrectivePrompt(original: string): string {
  return `${original}\n\n[CORRECTION REQUEST] Your previous response was not valid JSON. Reply with ONLY the JSON object, no markdown fences, no explanation.`;
}
