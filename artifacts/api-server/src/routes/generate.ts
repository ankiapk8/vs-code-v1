import { Router, type IRouter } from "express";
import { db, decksTable, cardsTable, generationsTable } from "@workspace/db";
import { GenerateCardsBody } from "@workspace/api-zod";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { serializeCard } from "../lib/serialize-card";

const router: IRouter = Router();

const MAX_PAGE_IMAGES = Number.MAX_SAFE_INTEGER;
const VISUAL_BATCH_SIZE = 6;
const MAX_VISUAL_PAGES = Number.MAX_SAFE_INTEGER;
const MAX_CARD_TARGET = Number.MAX_SAFE_INTEGER;
const CROP_PADDING = 0.04;
const MIN_CROP_DIMENSION = 0.12;
const VISUAL_CONCURRENCY = 2;
// Reject any visual card whose bbox covers more than this fraction of the page
// area. Full-page bboxes are almost always the model giving up and screenshotting
// the whole page instead of finding a real figure on it. The user explicitly does
// not want full-page screenshots.
const MAX_VISUAL_BBOX_AREA = 0.78;
// Also reject bboxes that span almost the entire width AND almost the entire
// height (which produce a "whole page" feel even if area is just under the cap).
const MAX_VISUAL_BBOX_DIM = 0.92;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableAIError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || getErrorCode(error) === "ABORT_ERR";
}

async function createChatCompletionWithRetry(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  payload: Parameters<typeof openai.chat.completions.create>[0],
  requestLog: { warn: (obj: unknown, message: string) => void },
  signal?: AbortSignal,
) {
  const delays = [2000, 5000, 10000];

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error("Cancelled");
    try {
      return await openai.chat.completions.create(payload, { signal });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      if (!isRetryableAIError(error) || attempt >= delays.length) {
        throw error;
      }
      const delayMs = delays[attempt];
      requestLog.warn({ err: error, attempt: attempt + 1, delayMs }, "Retrying AI card generation");
      await sleep(delayMs);
    }
  }
}

function parseJson<T>(raw: string): T[] {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const candidates = [
    cleaned,
    cleaned.match(/\[[\s\S]*\]/)?.[0],
    cleaned.match(/\{[\s\S]*\}/)?.[0],
  ].filter((v): v is string => Boolean(v));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed as T[];
      if (parsed && typeof parsed === "object") {
        const arr = (parsed as Record<string, unknown>).cards ?? (parsed as Record<string, unknown>).items;
        if (Array.isArray(arr)) return arr as T[];
      }
    } catch {
      continue;
    }
  }
  return [];
}

async function getOpenAIClient() {
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("AI card generation is not configured yet.");
  }
  const { openai } = await import("@workspace/integrations-openai-ai-server");
  return openai;
}

type RawCard = {
  front: string;
  back: string;
  type?: "basic" | "mcq";
  choices?: string[];
  correctIndex?: number;
  pageNumber?: number | null;
};
type Bbox = { x: number; y: number; w: number; h: number };
type FigureType = "chart" | "table" | "radiology" | "flowchart" | "diagram" | "photomicrograph" | "trace" | "equation";
type VisualRawCard = { pageIndex: number; front: string; back: string; bbox?: Bbox; figureType?: FigureType };
type VisualCardResult = { front: string; back: string; image: string; sourceImage: string; bbox: Bbox | null; figureType: FigureType | null; pageNumber: number | null };

const FIGURE_TYPES: FigureType[] = ["chart", "table", "radiology", "flowchart", "diagram", "photomicrograph", "trace", "equation"];

function normalizeFigureType(raw: unknown): FigureType | null {
  if (typeof raw !== "string") return null;
  const v = raw.toLowerCase().trim();
  if ((FIGURE_TYPES as string[]).includes(v)) return v as FigureType;
  // Map common aliases
  if (v === "graph" || v === "plot") return "chart";
  if (v === "xray" || v === "x-ray" || v === "ct" || v === "mri" || v === "ultrasound" || v === "imaging") return "radiology";
  if (v === "algorithm" || v === "decision-tree" || v === "decision_tree" || v === "pathway") return "flowchart";
  if (v === "schematic" || v === "anatomy" || v === "illustration") return "diagram";
  if (v === "histology" || v === "micrograph" || v === "photo" || v === "clinical-photo") return "photomicrograph";
  if (v === "ecg" || v === "eeg" || v === "trace" || v === "waveform") return "trace";
  if (v === "formula" || v === "math") return "equation";
  return null;
}

function normalizeCard(c: unknown): RawCard | null {
  if (!c || typeof c !== "object") return null;
  const r = c as Record<string, unknown>;
  const front = typeof r.front === "string" ? r.front.trim() : "";
  const back = typeof r.back === "string" ? r.back.trim() : "";
  if (!front || !back) return null;

  const rawType = typeof r.type === "string" ? r.type.toLowerCase().trim() : "basic";
  const wantsMcq = rawType === "mcq" || rawType === "multiple_choice" || rawType === "multiple-choice";

  if (wantsMcq && Array.isArray(r.choices)) {
    const choices = r.choices
      .map(c => (typeof c === "string" ? c.trim() : ""))
      .filter(s => s.length > 0);
    let correctIndex: number | undefined;
    if (typeof r.correctIndex === "number" && Number.isFinite(r.correctIndex)) {
      correctIndex = Math.floor(r.correctIndex);
    } else if (typeof r.correct === "string") {
      const letter = r.correct.trim().toUpperCase();
      const idx = letter.charCodeAt(0) - "A".charCodeAt(0);
      if (idx >= 0 && idx < choices.length) correctIndex = idx;
    }
    if (
      choices.length >= 2 &&
      typeof correctIndex === "number" &&
      correctIndex >= 0 &&
      correctIndex < choices.length
    ) {
      return { front, back, type: "mcq", choices, correctIndex };
    }
  }

  return { front, back, type: "basic" };
}

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, v));
}

function normalizeBbox(raw: unknown): Bbox | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Support {x,y,w,h} or {x,y,width,height} or [x,y,w,h]
  let x: unknown, y: unknown, w: unknown, h: unknown;
  if (Array.isArray(raw) && raw.length === 4) {
    [x, y, w, h] = raw;
  } else {
    x = r.x;
    y = r.y;
    w = r.w ?? r.width;
    h = r.h ?? r.height;
  }
  if ([x, y, w, h].some(v => typeof v !== "number")) return null;
  const bbox: Bbox = {
    x: clamp01(x, 0),
    y: clamp01(y, 0),
    w: clamp01(w, 1),
    h: clamp01(h, 1),
  };
  if (bbox.w < 0.03 || bbox.h < 0.03) return null;
  if (bbox.x + bbox.w > 1) bbox.w = 1 - bbox.x;
  if (bbox.y + bbox.h > 1) bbox.h = 1 - bbox.y;
  // Guarantee a minimum visible crop size so tiny boxes don't produce
  // postage-stamp images that miss labels/captions around the figure.
  if (bbox.w < MIN_CROP_DIMENSION) {
    const grow = (MIN_CROP_DIMENSION - bbox.w) / 2;
    bbox.x = Math.max(0, bbox.x - grow);
    bbox.w = Math.min(1 - bbox.x, MIN_CROP_DIMENSION);
  }
  if (bbox.h < MIN_CROP_DIMENSION) {
    const grow = (MIN_CROP_DIMENSION - bbox.h) / 2;
    bbox.y = Math.max(0, bbox.y - grow);
    bbox.h = Math.min(1 - bbox.y, MIN_CROP_DIMENSION);
  }
  return bbox;
}

function expandBbox(bbox: Bbox, pad: number): Bbox {
  const x = Math.max(0, bbox.x - pad);
  const y = Math.max(0, bbox.y - pad);
  const right = Math.min(1, bbox.x + bbox.w + pad);
  const bottom = Math.min(1, bbox.y + bbox.h + pad);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

async function cropImage(dataUrlOrB64: string, bbox: Bbox | null): Promise<string> {
  const src = dataUrlOrB64.startsWith("data:") ? dataUrlOrB64 : `data:image/jpeg;base64,${dataUrlOrB64}`;
  if (!bbox) return src;
  try {
    const img = await loadImage(src);
    // Always crop — bboxes covering most of the page are already filtered out
    // upstream so the user never sees a "whole page screenshot".
    const padded = expandBbox(bbox, CROP_PADDING);
    const sx = Math.round(padded.x * img.width);
    const sy = Math.round(padded.y * img.height);
    const sw = Math.max(1, Math.min(img.width - sx, Math.round(padded.w * img.width)));
    const sh = Math.max(1, Math.min(img.height - sy, Math.round(padded.h * img.height)));
    const canvas = createCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    return src;
  }
}

const SOURCE_THUMB_MAX = 720;

async function downscaleSourcePage(dataUrlOrB64: string): Promise<string> {
  const src = dataUrlOrB64.startsWith("data:") ? dataUrlOrB64 : `data:image/jpeg;base64,${dataUrlOrB64}`;
  try {
    const img = await loadImage(src);
    if (img.width <= SOURCE_THUMB_MAX) return src;
    const scale = SOURCE_THUMB_MAX / img.width;
    const w = SOURCE_THUMB_MAX;
    const h = Math.round(img.height * scale);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch {
    return src;
  }
}

function customPromptBlock(customPrompt: string | undefined): string {
  const trimmed = (customPrompt ?? "").trim();
  if (!trimmed) return "";
  // Cap to keep total prompt reasonable
  const capped = trimmed.length > 1500 ? trimmed.slice(0, 1500) + "…" : trimmed;
  return `\n\nADDITIONAL USER INSTRUCTIONS (these override the defaults above when they conflict, except for the JSON output format which is mandatory):\n"""\n${capped}\n"""`;
}

// Chunking constants for exhaustive text generation. We split very long PDFs
// into manageable pieces so the model can cover every paragraph instead of
// summarising the whole text in a single call (which silently drops content).
const TEXT_CHUNK_CHARS = 6000;
const TEXT_CHUNK_OVERLAP = 300;
const ABSOLUTE_TEXT_CARD_CAP = 1000;

type TextChunk = { text: string; pageNumber: number | null };

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= chunkSize) return [trimmed];
  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    let end = Math.min(trimmed.length, start + chunkSize);
    if (end < trimmed.length) {
      // Snap end to a paragraph or sentence boundary inside the last 25% of the chunk
      const window = trimmed.slice(start + Math.floor(chunkSize * 0.75), end);
      const para = window.lastIndexOf("\n\n");
      const sentence = window.lastIndexOf(". ");
      const snap = para >= 0 ? para : sentence;
      if (snap > 0) end = start + Math.floor(chunkSize * 0.75) + snap + (para >= 0 ? 2 : 2);
    }
    chunks.push(trimmed.slice(start, end).trim());
    if (end >= trimmed.length) break;
    start = Math.max(end - overlap, end);
  }
  return chunks;
}

// Build chunks that know which PDF page each one *starts on*. We pack pages
// into a chunk until the budget fills up, then emit. Tiny pages get grouped,
// huge pages may be split across multiple chunks (all tagged with the same
// starting page). This gives every text card a sane source-page tag so the
// merged deck can be sorted by original PDF page.
function buildPagedChunks(pageTexts: string[], chunkSize: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let buf = "";
  let bufStartPage: number | null = null;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) chunks.push({ text: trimmed, pageNumber: bufStartPage });
    buf = "";
    bufStartPage = null;
  };

  for (let i = 0; i < pageTexts.length; i++) {
    const page = (pageTexts[i] ?? "").trim();
    if (!page) continue;
    const pageNumber = i + 1;

    if (page.length > chunkSize) {
      // Page is bigger than one chunk on its own — emit anything pending first,
      // then split this single page into multiple chunks (all stamped with the
      // same page number).
      flush();
      const sub = chunkText(page, chunkSize, 0);
      for (const s of sub) chunks.push({ text: s, pageNumber });
      continue;
    }

    if (buf.length + page.length + 2 > chunkSize) flush();
    if (!buf) bufStartPage = pageNumber;
    buf += (buf ? "\n\n" : "") + `[PAGE ${pageNumber}]\n${page}`;
  }
  flush();
  return chunks;
}

const TEXT_CARD_SYSTEM_PROMPT_BASE = `You are a meticulous Anki flashcard creator. Your top priority is COMPLETE COVERAGE: every fact, definition, mechanism, classification, dose, value, name, criterion, side-effect, indication, contraindication, formula, step, comparison or relationship in the source text must end up on at least one card. Do not summarise. Do not skip details because they "feel minor". If the text mentions it, the deck must test it.

═══════════════════════════════════════════════
1) PRESERVE ANY MULTIPLE-CHOICE QUESTIONS YOU FIND
═══════════════════════════════════════════════
If the source text already contains a multiple-choice question (look for patterns like "Q1.", "Question 1:", numbered stems followed by options "A) … B) … C) … D) …" or "(a) (b) (c) (d)" or "1. 2. 3. 4." with an answer key like "Answer: B", "Ans: C", "Correct: D", "Key: A", or an explanation block), you MUST keep it as an MCQ card and preserve the EXACT wording of:
  • the question stem
  • every option (do not paraphrase, do not reorder, do not drop any)
  • the original correct answer

Output that card with:
  "type": "mcq"
  "front": the question stem ONLY (no options inside the stem text — options live in the "choices" array)
  "choices": ["option A text", "option B text", ...] in the original order, WITHOUT the "A)" / "B)" prefix
  "correctIndex": 0-based index of the correct option
  "back": a concise explanation of why the correct option is right (and, if obvious from the source, why the distractors are wrong)

If the source has an MCQ but the answer is not given, choose the most defensible answer based on the surrounding text and explain your reasoning in "back".

═══════════════════════════════════════════════
2) EXHAUSTIVE Q&A FOR EVERYTHING ELSE
═══════════════════════════════════════════════
For any non-MCQ content, create as many "type": "basic" cards as needed so that NO information is missed. A reader who masters the deck must know everything the source text taught.

Card-writing rules:
  • One atomic fact per card — split compound statements into multiple cards.
  • Questions are specific and unambiguous; answers are concise but complete.
  • Self-contained — never say "as above" or "in the previous paragraph".
  • Preserve numerical values, units, dosages, percentages, and proper names exactly.
  • For lists/classifications, make a card for each item AND a "name all members of X" card.
  • For comparisons (A vs B), make a card for the contrast AND individual fact cards for each side.
  • Avoid trivial or tautological questions ("What is X? — X.").

═══════════════════════════════════════════════
OUTPUT FORMAT (STRICT)
═══════════════════════════════════════════════
Return ONLY a JSON array. Each item is one of:

Basic card:
  { "type": "basic", "front": "...", "back": "..." }

MCQ card:
  { "type": "mcq", "front": "stem", "choices": ["...", "...", "...", "..."], "correctIndex": 1, "back": "explanation" }

No markdown, no commentary, no \`\`\` fences — just the JSON array.`;

async function generateTextCardsForChunk(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  chunk: string,
  targetCards: number,
  requestLog: { warn: (obj: unknown, message: string) => void },
  signal?: AbortSignal,
  customPrompt?: string,
  pageNumber: number | null = null,
): Promise<RawCard[]> {
  const systemPrompt = TEXT_CARD_SYSTEM_PROMPT_BASE + customPromptBlock(customPrompt);

  const userContent = `Source text (one segment of a larger document — treat it on its own and cover EVERY fact in it):

"""
${chunk}
"""

Goal: ~${targetCards} cards for this segment, but you MUST add more if the segment contains more distinct facts/MCQs. You may add fewer ONLY if the segment is genuinely thin (e.g. a heading or a few words). Preserve any multiple-choice questions verbatim as MCQ cards. Output JSON array only.`;

  const response = await createChatCompletionWithRetry(openai, {
    model: "gpt-4.1-mini",
    max_completion_tokens: 16384,
    stream: false as const,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  }, requestLog, signal);

  const raw = (response as { choices: Array<{ message: { content: string | null } }> })
    .choices[0]?.message?.content ?? "[]";
  const cards = parseJson<unknown>(raw)
    .map(normalizeCard)
    .filter((c): c is RawCard => c !== null);
  if (pageNumber !== null) {
    for (const c of cards) c.pageNumber = pageNumber;
  }
  return cards;
}

async function generateTextCards(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  text: string,
  maxCards: number,
  requestLog: { warn: (obj: unknown, message: string) => void },
  signal?: AbortSignal,
  customPrompt?: string,
  onProgress?: (done: number, total: number) => void,
  pageTexts?: string[],
): Promise<RawCard[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // When per-page text is provided, use page-aware chunking so every card can
  // be tagged with its source PDF page. Otherwise fall back to plain chunking
  // (and cards stay un-paged).
  const chunks: TextChunk[] = pageTexts && pageTexts.length > 0
    ? buildPagedChunks(pageTexts, TEXT_CHUNK_CHARS)
    : chunkText(trimmed, TEXT_CHUNK_CHARS, TEXT_CHUNK_OVERLAP).map(t => ({ text: t, pageNumber: null }));

  if (chunks.length === 0) return [];

  // Distribute the user's target across chunks proportionally to length, with
  // a generous floor so dense chunks aren't starved. The model is also allowed
  // (and required) to exceed this when the chunk has more facts than the goal.
  const totalChars = chunks.reduce((s, c) => s + c.text.length, 0) || 1;
  const cardsPerChunk = chunks.map(c => {
    const proportional = Math.ceil((c.text.length / totalChars) * Math.max(maxCards, 1));
    const densityFloor = Math.max(8, Math.ceil(c.text.length / 250));
    return Math.max(proportional, densityFloor);
  });

  const allCards: RawCard[] = [];
  // Run chunks with limited concurrency to avoid hammering the AI provider.
  const CONCURRENCY = 3;
  let done = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    if (signal?.aborted) throw new Error("Cancelled");
    const slice = chunks.slice(i, i + CONCURRENCY);
    const targets = cardsPerChunk.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((chunk, idx) =>
        generateTextCardsForChunk(openai, chunk.text, targets[idx], requestLog, signal, customPrompt, chunk.pageNumber),
      ),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") allCards.push(...r.value);
      else requestLog.warn({ err: r.reason }, "Text chunk generation failed");
    }
    done += slice.length;
    onProgress?.(done, chunks.length);
  }

  // Deduplicate exact-duplicate fronts that can arise from chunk overlap.
  const seen = new Set<string>();
  const unique: RawCard[] = [];
  for (const c of allCards) {
    const key = `${c.type ?? "basic"}::${c.front.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= ABSOLUTE_TEXT_CARD_CAP) break;
  }

  return unique;
}

async function generateVisualCardsForBatch(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  batchImages: string[],
  batchStart: number,
  cardsPerPage: number,
  requestLog: { warn: (obj: unknown, message: string) => void },
  signal?: AbortSignal,
  customPrompt?: string,
): Promise<VisualRawCard[]> {
  type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "high" } };

  const imageUrls: ContentPart[] = batchImages.map(img => ({
    type: "image_url" as const,
    image_url: {
      url: img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`,
      detail: "high" as const,
    },
  }));

  const cardsRange = cardsPerPage <= 1 ? "1" : `1–${cardsPerPage}`;

  const systemPrompt = `You are an expert visual learning designer and clinical/scientific illustrator. You convert PDF page images into Anki flashcards centred on the FIGURES shown on each page (NOT on the surrounding prose). You will receive ${batchImages.length} page image(s) (pages ${batchStart + 1}–${batchStart + batchImages.length}).

═══════════════════════════════════════════════
STEP 1 — DETECT REAL FIGURES ONLY
═══════════════════════════════════════════════
Scan each page and identify ONLY genuine visual elements that have inherent visual content a learner needs to look at. The qualifying categories are:

  📊 CHARTS & GRAPHS — bar/line/pie/scatter charts, dose-response curves, Kaplan-Meier curves, growth charts, histograms, Forest plots, ROC curves, box plots.
  📋 TABLES — any tabular data: drug doses, classifications, scoring systems, criteria, differential lists, comparison tables, lab values, pharmacology tables.
  🩻 RADIOLOGICAL IMAGES — X-ray, CT, MRI, ultrasound, PET, angiography, fluoroscopy, mammography, nuclear scans, DEXA, echocardiography stills.
  🔀 FLOWCHARTS, ALGORITHMS & DECISION TREES — clinical pathways, treatment algorithms, diagnostic flowcharts, signalling cascades drawn as flow diagrams.
  🧬 DIAGRAMS & SCHEMATICS — anatomical drawings, cross-sections, organ illustrations, embryology stages, chemical structures, biochemical pathways, cell signalling, circuits, free-body diagrams, engineering blueprints, maps.
  🔬 PHOTOMICROGRAPHS / CLINICAL PHOTOS — histology / cytology / microscopy slides, gross pathology, dermatology, ophthalmology, ENT photos, electrophoresis gels, Western blots.
  📈 PHYSIOLOGICAL TRACES — ECG, EEG, EMG, spirometry, capnography, arterial line traces, pressure-volume loops.
  ➗ EQUATIONS — only when the equation is rendered as a typeset visual block (e.g. boxed formulas, multi-line derivations) and not as inline text.

❌ DO NOT make a card for: pure prose paragraphs, headings/titles alone, page numbers, footnotes, bullet lists of plain text, references, table-of-contents pages, blank pages, copyright notices.

If a page has NO qualifying figure from the categories above, output ZERO cards for that page. Empty pages are acceptable and expected — the learner does not want a "screenshot of the whole page" when there is no real figure on it.

If a page has multiple distinct figures (e.g., Figure 5.1 and Figure 5.2), each gets its OWN card with its OWN bounding box. Do not lump them.

If a single figure has multiple sub-panels (A, B, C, D) and each panel teaches a clearly different concept, make one card per panel with a tight bbox around just that panel.

═══════════════════════════════════════════════
STEP 2 — DRAW TIGHT, PROFESSIONAL BOUNDING BOXES
═══════════════════════════════════════════════
Coordinates are NORMALIZED 0..1 where (0,0) is the TOP-LEFT of the page and (1,1) is the BOTTOM-RIGHT. The bbox is {"x", "y", "w", "h"}.

🚫 ABSOLUTELY FORBIDDEN — DO NOT do any of the following:
  ✗ Do NOT return {"x":0,"y":0,"w":1,"h":1} or any bbox covering most of the page. The user does NOT want full-page screenshots. If you cannot find a focused figure, OMIT the card.
  ✗ Do NOT box surrounding paragraphs of prose. The bbox must contain the figure (and its caption/labels) — NOT the body text above or below it.
  ✗ Do NOT make a bbox wider than 0.9 of the page width AND taller than 0.9 of the page height simultaneously. Even genuine large figures usually have margins.
  ✗ Do NOT make a bbox whose area exceeds 0.75 of the page (w × h > 0.75). If the real figure is that large, double-check you aren't including non-figure content; tighten the box to the figure itself.
  ✗ Do NOT clip text mid-line, mid-word, or mid-character.
  ✗ Do NOT cut through arrows, leader lines, or anatomical structures.
  ✗ Do NOT omit a referenced sub-panel.
  ✗ Do NOT miss the figure number/caption.

✅ REQUIRED — every box MUST include:
  1. The entire figure body (no clipping).
  2. ALL labels, arrows, leader lines, callouts, sub-panel letters (A/B/C/D), and the structures they point to.
  3. The figure's caption / title / footnote (e.g., "Figure 5.1: Cardiac conduction system") if it is directly under or above the figure.
  4. Axis labels, axis numbers/units, tick marks, legends, colour keys, scale bars, and orientation markers (R/L, anterior/posterior).
  5. ~3–5% of whitespace margin on each side — TIGHT around the figure, not around the whole page.

Decision algorithm for each box:
  a. Locate the actual visible ink/pixels belonging to this figure (lines, labels, captions, leaders, legends).
  b. Find the smallest rectangle that fully contains all of those pixels.
  c. Add a small 3–5% safety margin in every direction.
  d. STOP. Do not expand further. Do not include surrounding paragraphs.

═══════════════════════════════════════════════
STEP 3 — WRITE FOCUSED VISUAL CARDS
═══════════════════════════════════════════════
Each card must be:
  • Image-first: the question should REQUIRE the learner to look at the cropped image (identify, label, interpret, diagnose, name the structure, calculate from the graph, recognise the pattern, read off a value from the chart, complete the next step in the flowchart).
  • Self-contained: do not say "as shown above" or "from the previous figure". Reference what's in the cropped image itself.
  • Specific: prefer "Identify the structure indicated by arrow A in this CT scan" over "What is this?".
  • Concise on the back: a clear answer + 1–2 lines of context if useful (e.g., "Right middle lobe consolidation — typical for community-acquired pneumonia").

═══════════════════════════════════════════════
OUTPUT FORMAT (STRICT)
═══════════════════════════════════════════════
Return ONLY a JSON array. Each item must have exactly:
  - "pageIndex": integer (0-based index within the images you received, so 0 = first image in this batch)
  - "figureType": one of "chart" | "table" | "radiology" | "flowchart" | "diagram" | "photomicrograph" | "trace" | "equation" — used by the system to verify your detection. Use the closest fit.
  - "front": string (question)
  - "back": string (answer)
  - "bbox": object {"x": number, "y": number, "w": number, "h": number} — all between 0 and 1, following STEP 2 strictly. Must satisfy w * h ≤ 0.75 and (w ≤ 0.9 OR h ≤ 0.9).

Aim for ${cardsRange} card(s) per page WHEN qualifying figures exist. Pages without qualifying figures contribute zero cards. If a page has more distinct figures than ${cardsRange}, you MAY exceed it (one card per distinct figure). Do NOT invent cards for non-existent visuals.

No markdown, no commentary, no \`\`\` fences — just the JSON array.${customPromptBlock(customPrompt)}`;

  try {
    const response = await createChatCompletionWithRetry(openai, {
      model: "gpt-4.1",
      max_completion_tokens: 16384,
      stream: false as const,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text" as const, text: `Here are the ${batchImages.length} page image(s) for pages ${batchStart + 1}–${batchStart + batchImages.length}. Detect EVERY visual on each page (do not miss any) and produce generous, professional bounding boxes that include all labels, captions, and ~6–10% breathing room. Then write image-first Anki cards. Output JSON only.` },
            ...imageUrls,
          ],
        },
      ],
    }, requestLog, signal);

    const raw = (response as { choices: Array<{ message: { content: string | null } }> })
      .choices[0]?.message?.content ?? "[]";
    const parsed = parseJson<Record<string, unknown>>(raw);
    const result: VisualRawCard[] = [];
    for (const c of parsed) {
      if (typeof c.pageIndex !== "number" || typeof c.front !== "string" || typeof c.back !== "string") continue;
      const bbox = normalizeBbox(c.bbox);
      // Drop cards without a usable focused bbox — the user does not want full-page screenshots.
      if (!bbox) {
        requestLog.warn({ pageIndex: c.pageIndex }, "Visual card dropped: no usable bbox");
        continue;
      }
      const area = bbox.w * bbox.h;
      if (area > MAX_VISUAL_BBOX_AREA || (bbox.w > MAX_VISUAL_BBOX_DIM && bbox.h > MAX_VISUAL_BBOX_DIM)) {
        requestLog.warn({ pageIndex: c.pageIndex, area, w: bbox.w, h: bbox.h }, "Visual card dropped: bbox too large (looks like a full-page screenshot)");
        continue;
      }
      result.push({
        pageIndex: c.pageIndex,
        front: c.front,
        back: c.back,
        bbox,
        figureType: normalizeFigureType(c.figureType) ?? undefined,
      });
    }
    return result;
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error;
    return [];
  }
}

async function generateAllVisualCards(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  images: string[],
  targetCount: number | undefined,
  requestLog: { warn: (obj: unknown, message: string) => void },
  onBatchGroupDone?: (doneBatches: number, totalBatches: number) => void,
  signal?: AbortSignal,
  customPrompt?: string,
): Promise<VisualCardResult[]> {
  const pagesToProcess = images.slice(0, MAX_VISUAL_PAGES);
  const batches: { start: number; imgs: string[] }[] = [];

  for (let i = 0; i < pagesToProcess.length; i += VISUAL_BATCH_SIZE) {
    batches.push({ start: i, imgs: pagesToProcess.slice(i, i + VISUAL_BATCH_SIZE) });
  }

  // Compute upper bound of cards per page from target. The model is also
  // instructed it MAY exceed this when a page has more distinct figures than
  // this number, so genuinely figure-rich pages aren't artificially capped.
  const cardsPerPage = targetCount && targetCount > 0
    ? Math.max(1, Math.min(8, Math.ceil(targetCount / pagesToProcess.length)))
    : 3;

  const results: VisualCardResult[] = [];
  let doneBatches = 0;

  for (let i = 0; i < batches.length; i += VISUAL_CONCURRENCY) {
    if (signal?.aborted) throw new Error("Cancelled");
    const chunk = batches.slice(i, i + VISUAL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(b => generateVisualCardsForBatch(openai, b.imgs, b.start, cardsPerPage, requestLog, signal, customPrompt).then(async cards => {
        const out: VisualCardResult[] = [];
        const thumbCache = new Map<number, string>();
        for (const c of cards) {
          if (c.pageIndex < 0 || c.pageIndex >= b.imgs.length) continue;
          // We already rejected oversize bboxes upstream — every card here has a focused bbox.
          const cropped = await cropImage(b.imgs[c.pageIndex], c.bbox ?? null);
          let thumb = thumbCache.get(c.pageIndex);
          if (!thumb) {
            thumb = await downscaleSourcePage(b.imgs[c.pageIndex]);
            thumbCache.set(c.pageIndex, thumb);
          }
          out.push({
            front: c.front.trim(),
            back: c.back.trim(),
            image: cropped,
            sourceImage: thumb,
            bbox: c.bbox ?? null,
            figureType: c.figureType ?? null,
            pageNumber: b.start + c.pageIndex + 1,
          });
        }
        return out;
      }))
    );

    for (const r of settled) {
      if (r.status === "fulfilled") results.push(...r.value);
    }

    doneBatches += chunk.length;
    onBatchGroupDone?.(doneBatches, batches.length);

    if (i + VISUAL_CONCURRENCY < batches.length) await sleep(500);
  }

  // If a target was given, trim down
  if (targetCount && targetCount > 0 && results.length > targetCount) {
    return results.slice(0, targetCount);
  }
  return results;
}

function sseEmit(res: import("express").Response, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

type DeckType = "text" | "visual" | "both";

function resolveDeckType(input: unknown, hasImages: boolean): DeckType {
  const t = input === "text" || input === "visual" || input === "both" ? input : "both";
  if (!hasImages && t !== "text") return "text";
  return t;
}

router.post("/generate/stream", async (req, res, next): Promise<void> => {
  const parsed = GenerateCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, deckName, cardCount = 20, visualCardCount, parentId, pageImages, pageTexts, deckType: rawDeckType, customPrompt } = parsed.data;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate cards from." });
    return;
  }

  const runStartedAt = Date.now();
  let recorded = false;
  const recordRun = async (status: "success" | "error" | "cancelled", cardsGenerated: number, errorMessage?: string) => {
    if (recorded) return;
    recorded = true;
    try {
      await db.insert(generationsTable).values({
        deckName,
        deckType: rawDeckType ?? "both",
        status,
        cardsGenerated,
        pageCount: Array.isArray(pageImages) ? pageImages.length : 0,
        durationMs: Date.now() - runStartedAt,
        customPrompt: customPrompt?.trim() ? customPrompt.trim().slice(0, 1500) : null,
        errorMessage: errorMessage ? errorMessage.slice(0, 500) : null,
        startedAt: new Date(runStartedAt),
        completedAt: new Date(),
      });
    } catch (err) {
      req.log.warn({ err }, "Failed to record generation history");
    }
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send SSE comment heartbeats to keep proxies (Replit edge, Cloudflare,
  // Android Chrome on mobile networks, etc.) from closing the long-lived
  // connection during slow AI calls. Comments start with ":" and are ignored
  // by EventSource/fetch consumers.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* socket may be closed */
    }
  }, 12_000);
  const stopHeartbeat = () => clearInterval(heartbeat);
  res.on("close", stopHeartbeat);
  res.on("finish", stopHeartbeat);

  const selectedImages = Array.isArray(pageImages) && pageImages.length > 0
    ? pageImages.slice(0, MAX_PAGE_IMAGES)
    : [];
  const hasImages = selectedImages.length > 0;
  const deckType = resolveDeckType(rawDeckType, hasImages);
  const wantText = deckType === "text" || deckType === "both";
  const wantVisual = (deckType === "visual" || deckType === "both") && hasImages;

  const maxTextCards = wantText ? Math.max(cardCount, 1) : 0;
  const maxVisualCards = wantVisual
    ? Math.max(visualCardCount ?? cardCount, 1)
    : 0;

  sseEmit(res, { type: "progress", percent: 5, message: "Connecting to AI…" });

  let openai: Awaited<ReturnType<typeof getOpenAIClient>>;
  try {
    openai = await getOpenAIClient();
  } catch (error) {
    const msg = error instanceof Error ? error.message : "AI not configured.";
    await recordRun("error", 0, msg);
    sseEmit(res, { type: "error", message: msg });
    res.end();
    return;
  }

  sseEmit(res, { type: "progress", percent: 12, message: wantText ? "Generating text cards…" : "Analyzing pages…" });

  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  req.on("close", onClientClose);
  const signal = abortController.signal;

  const TEXT_DONE_PERCENT = wantVisual ? 40 : 82;
  const VISUAL_START = wantText ? 42 : 15;
  const VISUAL_END = 85;

  let textCards: RawCard[] = [];
  let visualCards: VisualCardResult[] = [];

  try {
    const TEXT_START = 10;
    const textPromise = wantText
      ? generateTextCards(
          openai,
          text,
          maxTextCards,
          req.log,
          signal,
          customPrompt,
          (done, total) => {
            const frac = total > 0 ? done / total : 1;
            const pct = Math.round(TEXT_START + frac * (TEXT_DONE_PERCENT - TEXT_START));
            sseEmit(res, {
              type: "progress",
              percent: pct,
              message: `Generating text cards… (${done}/${total} chunks)`,
            });
          },
          pageTexts,
        ).then(cards => {
          textCards = cards;
          sseEmit(res, { type: "progress", percent: TEXT_DONE_PERCENT, message: `Text cards done (${cards.length} generated)` });
        })
      : Promise.resolve();

    const visualPromise = wantVisual
      ? generateAllVisualCards(openai, selectedImages, maxVisualCards, req.log, (done, total) => {
          const frac = done / total;
          const pct = Math.round(VISUAL_START + frac * (VISUAL_END - VISUAL_START));
          const pages = Math.min(done * VISUAL_BATCH_SIZE, selectedImages.length);
          sseEmit(res, { type: "progress", percent: pct, message: `Analyzing & cropping images… (${pages}/${selectedImages.length} pages)` });
        }, signal, customPrompt).then(cards => { visualCards = cards; })
      : Promise.resolve();

    await Promise.all([textPromise, visualPromise]);
  } catch (error) {
    req.off("close", onClientClose);
    if (isAbortError(error) || signal.aborted) {
      req.log.info("AI card generation cancelled by client");
      await recordRun("cancelled", 0);
      try { sseEmit(res, { type: "error", message: "Cancelled" }); } catch { /* socket may be gone */ }
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    req.log.error({ err: error }, "SSE AI card generation failed");
    const status = getErrorStatus(error);
    const code = getErrorCode(error);
    let msg: string;
    if (status === 429 || code === "too_many_requests") {
      msg = "AI is temporarily rate-limited. Wait a minute and try again.";
    } else {
      msg = error instanceof Error ? error.message : "AI card generation failed.";
    }
    await recordRun("error", 0, msg);
    sseEmit(res, { type: "error", message: msg });
    res.end();
    return;
  }
  req.off("close", onClientClose);
  if (signal.aborted) {
    await recordRun("cancelled", 0);
    try { res.end(); } catch { /* ignore */ }
    return;
  }

  sseEmit(res, { type: "progress", percent: 90, message: "Saving cards to database…" });

  try {
    const filteredText = textCards
      .map(c => normalizeCard(c))
      .filter((c): c is RawCard => c !== null);

    const filteredVisual = visualCards
      .filter(c => c.front.length > 0 && c.back.length > 0);

    if (filteredText.length === 0 && filteredVisual.length === 0) {
      await recordRun("error", 0, "AI did not return any usable cards.");
      sseEmit(res, { type: "error", message: "AI did not return any usable cards." });
      res.end();
      return;
    }

    // Single merged deck: text + visual cards live together, sorted by source
    // PDF page so the deck reads in the same order as the original document.
    const [primaryDeck] = await db
      .insert(decksTable)
      .values({ name: deckName, parentId: parentId ?? null })
      .returning();

    if (!primaryDeck) {
      await recordRun("error", 0, "Failed to save deck.");
      sseEmit(res, { type: "error", message: "Failed to save deck." });
      res.end();
      return;
    }

    const cardRows: (typeof cardsTable.$inferInsert)[] = [
      ...filteredText.map(c => ({
        deckId: primaryDeck.id,
        front: c.front,
        back: c.back,
        image: null,
        cardType: c.type === "mcq" ? ("mcq" as const) : ("basic" as const),
        choices: c.type === "mcq" && c.choices ? JSON.stringify(c.choices) : null,
        correctIndex: c.type === "mcq" && typeof c.correctIndex === "number" ? c.correctIndex : null,
        pageNumber: c.pageNumber ?? null,
      })),
      ...filteredVisual.map(c => ({
        deckId: primaryDeck.id,
        front: c.front,
        back: c.back,
        image: c.image.startsWith("data:") ? c.image : `data:image/jpeg;base64,${c.image}`,
        sourceImage: c.sourceImage ?? null,
        bbox: c.bbox ? JSON.stringify(c.bbox) : null,
        pageNumber: c.pageNumber ?? null,
      })),
    ];

    const inserted = cardRows.length > 0
      ? await db.insert(cardsTable).values(cardRows).returning()
      : [];
    const totalInserted = inserted.length;

    await recordRun("success", totalInserted);
    sseEmit(res, {
      type: "done",
      percent: 100,
      generatedCount: totalInserted,
      deck: { ...primaryDeck, cardCount: totalInserted, createdAt: primaryDeck.createdAt.toISOString() },
    });
    res.end();
  } catch (err) {
    await recordRun("error", 0, err instanceof Error ? err.message : "Unknown error");
    next(err);
  }
});

// =============================================================================
// QUESTION BANK (MCQ-ONLY) GENERATION
// =============================================================================

const QBANK_SYSTEM_PROMPT_BASE = `You are an expert medical/educational question writer creating a high-quality question bank in the style of UWorld, Amboss, or Kaplan QBank. Every output card MUST be a multiple-choice question — no basic flashcards, no open-ended cards.

═══════════════════════════════════════════════
QUESTION DESIGN RULES
═══════════════════════════════════════════════
1. Each question is a complete, standalone clinical/scientific vignette or a focused conceptual stem. Prefer realistic vignettes over bare-fact recall when the source supports it.
2. Use exactly 5 answer choices when possible (4 minimum, 6 maximum). Choices must be plausible distractors, parallel in length and style, mutually exclusive, and free of "all of the above" / "none of the above".
3. Exactly ONE choice is correct. The correct answer must be unambiguously supported by the source text.
4. Do not telegraph the answer through length, grammar, or absolute words ("always", "never").
5. The "front" field contains ONLY the question stem (vignette + the actual question, e.g. "Which of the following is the most likely diagnosis?"). Do NOT embed answer letters or choices inside the stem.
6. The "choices" array contains the option text only — without "A)", "B)", "1.", or any prefix.
7. The "correctIndex" is a 0-based index into "choices".
8. The "back" field is a high-quality UWorld-style EXPLANATION:
   - Start with one sentence stating which option is correct and why.
   - Then a concise teaching paragraph (mechanism, key concept, why it fits the stem).
   - Then a brief "Why the others are wrong" section that addresses each distractor by letter.
   - End with a one-line "Educational Objective" / take-home point.
   - Use **bold** for key terms. Keep total length focused and exam-relevant.

═══════════════════════════════════════════════
PRESERVE EXISTING MCQs
═══════════════════════════════════════════════
If the source text already contains a multiple-choice question (numbered stem, A)/B)/C)/D) options, "Answer: B" key), preserve the EXACT wording of stem and choices and use the original correct answer. Add or expand the explanation in "back" if it is thin.

═══════════════════════════════════════════════
COVERAGE
═══════════════════════════════════════════════
Generate as many high-quality MCQs as the source supports. Cover the breadth of testable facts — definitions, mechanisms, classifications, clinical features, diagnostics, management, complications, comparisons. Do NOT pad with low-yield trivia.

═══════════════════════════════════════════════
OUTPUT FORMAT (STRICT)
═══════════════════════════════════════════════
Return ONLY a JSON array. Each item is:

  { "type": "mcq", "front": "stem (vignette + question)", "choices": ["...", "...", "...", "...", "..."], "correctIndex": 2, "back": "explanation" }

No markdown, no commentary, no \`\`\` fences — just the JSON array.`;

async function generateQbankCardsForChunk(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  chunk: string,
  targetQuestions: number,
  requestLog: { warn: (obj: unknown, message: string) => void },
  signal?: AbortSignal,
  customPrompt?: string,
  pageNumber: number | null = null,
): Promise<RawCard[]> {
  const systemPrompt = QBANK_SYSTEM_PROMPT_BASE + customPromptBlock(customPrompt);

  const userContent = `Source text (one segment of a larger document — write MCQs that cover EVERY testable fact in it):

"""
${chunk}
"""

Goal: ~${targetQuestions} high-quality MCQs for this segment, but you MUST add more if the segment contains more testable concepts. You may add fewer ONLY if the segment is genuinely thin. Every output card MUST be type="mcq". Output JSON array only.`;

  const response = await createChatCompletionWithRetry(openai, {
    model: "gpt-4.1-mini",
    max_completion_tokens: 16384,
    stream: false as const,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  }, requestLog, signal);

  const raw = (response as { choices: Array<{ message: { content: string | null } }> })
    .choices[0]?.message?.content ?? "[]";
  const cards = parseJson<unknown>(raw)
    .map(normalizeCard)
    .filter((c): c is RawCard => c !== null && c.type === "mcq");
  if (pageNumber !== null) {
    for (const c of cards) c.pageNumber = pageNumber;
  }
  return cards;
}

async function generateQbankCards(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  text: string,
  maxQuestions: number,
  requestLog: { warn: (obj: unknown, message: string) => void },
  signal?: AbortSignal,
  customPrompt?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<RawCard[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks = chunkText(trimmed, TEXT_CHUNK_CHARS, TEXT_CHUNK_OVERLAP).map(t => ({ text: t, pageNumber: null as number | null }));
  if (chunks.length === 0) return [];

  const totalChars = chunks.reduce((s, c) => s + c.text.length, 0) || 1;
  const questionsPerChunk = chunks.map(c => {
    const proportional = Math.ceil((c.text.length / totalChars) * Math.max(maxQuestions, 1));
    const densityFloor = Math.max(4, Math.ceil(c.text.length / 400));
    return Math.max(proportional, densityFloor);
  });

  const allCards: RawCard[] = [];
  const CONCURRENCY = 3;
  let done = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    if (signal?.aborted) throw new Error("Cancelled");
    const slice = chunks.slice(i, i + CONCURRENCY);
    const targets = questionsPerChunk.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((chunk, idx) =>
        generateQbankCardsForChunk(openai, chunk.text, targets[idx], requestLog, signal, customPrompt, chunk.pageNumber),
      ),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") allCards.push(...r.value);
      else requestLog.warn({ err: r.reason }, "Qbank chunk generation failed");
    }
    done += slice.length;
    onProgress?.(done, chunks.length);
  }

  // Deduplicate by stem
  const seen = new Set<string>();
  const unique: RawCard[] = [];
  for (const c of allCards) {
    const key = c.front.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= ABSOLUTE_TEXT_CARD_CAP) break;
  }
  return unique;
}

router.post("/generate-qbank", async (req, res, next): Promise<void> => {
  const body = (req.body ?? {}) as {
    text?: unknown;
    deckName?: unknown;
    questionCount?: unknown;
    parentId?: unknown;
    customPrompt?: unknown;
  };

  const text = typeof body.text === "string" ? body.text : "";
  const deckName = typeof body.deckName === "string" ? body.deckName.trim() : "";
  const questionCount = typeof body.questionCount === "number" && Number.isFinite(body.questionCount)
    ? Math.max(1, Math.floor(body.questionCount))
    : 20;
  const parentId = typeof body.parentId === "number" && Number.isFinite(body.parentId)
    ? body.parentId
    : null;
  const customPrompt = typeof body.customPrompt === "string" ? body.customPrompt : undefined;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate questions from." });
    return;
  }
  if (!deckName) {
    res.status(400).json({ error: "Question bank name is required." });
    return;
  }

  let openai: Awaited<ReturnType<typeof getOpenAIClient>>;
  try {
    openai = await getOpenAIClient();
  } catch (error) {
    req.log.error({ err: error }, "AI question bank generation failed");
    res.status(503).json({ error: error instanceof Error ? error.message : "AI question bank generation failed." });
    return;
  }

  let questions: RawCard[] = [];
  try {
    questions = await generateQbankCards(openai, text, questionCount, req.log, undefined, customPrompt);
  } catch (error) {
    req.log.error({ err: error }, "AI question bank generation failed");
    const status = getErrorStatus(error);
    const code = getErrorCode(error);
    if (status === 429 || code === "too_many_requests") {
      res.status(429).json({ error: "AI is temporarily rate-limited. Wait a minute and try again." });
      return;
    }
    res.status(503).json({ error: error instanceof Error ? error.message : "AI question bank generation failed." });
    return;
  }

  // Keep only valid MCQs
  const filtered = questions.filter(c => c.type === "mcq" && Array.isArray(c.choices) && c.choices.length >= 2 && typeof c.correctIndex === "number");
  if (filtered.length === 0) {
    res.status(500).json({ error: "AI did not generate any usable MCQs." });
    return;
  }

  try {
    const [primaryDeck] = await db
      .insert(decksTable)
      .values({ name: deckName, parentId: parentId ?? null, kind: "qbank" })
      .returning();

    if (!primaryDeck) {
      res.status(500).json({ error: "Failed to save question bank." });
      return;
    }

    const cardRows: (typeof cardsTable.$inferInsert)[] = filtered.map(c => ({
      deckId: primaryDeck.id,
      front: c.front,
      back: c.back,
      image: null,
      cardType: "mcq" as const,
      choices: c.choices ? JSON.stringify(c.choices) : null,
      correctIndex: typeof c.correctIndex === "number" ? c.correctIndex : null,
      pageNumber: c.pageNumber ?? null,
    }));

    const inserted = await db.insert(cardsTable).values(cardRows).returning();

    res.status(201).json({
      deck: { ...primaryDeck, cardCount: inserted.length, createdAt: primaryDeck.createdAt.toISOString() },
      cards: inserted.map(serializeCard),
      generatedCount: inserted.length,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/generate-qbank/stream", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    text?: unknown;
    deckName?: unknown;
    questionCount?: unknown;
    parentId?: unknown;
    customPrompt?: unknown;
  };

  const text = typeof body.text === "string" ? body.text : "";
  const deckName = typeof body.deckName === "string" ? body.deckName.trim() : "";
  const questionCount = typeof body.questionCount === "number" && Number.isFinite(body.questionCount)
    ? Math.max(1, Math.floor(body.questionCount))
    : 20;
  const parentId = typeof body.parentId === "number" && Number.isFinite(body.parentId)
    ? body.parentId
    : null;
  const customPrompt = typeof body.customPrompt === "string" ? body.customPrompt : undefined;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate questions from." });
    return;
  }
  if (!deckName) {
    res.status(400).json({ error: "Question bank name is required." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* socket closed */ }
  }, 12_000);
  const stopHeartbeat = () => clearInterval(heartbeat);
  res.on("close", stopHeartbeat);
  res.on("finish", stopHeartbeat);

  let openai: Awaited<ReturnType<typeof getOpenAIClient>>;
  try {
    openai = await getOpenAIClient();
  } catch (error) {
    sseEmit(res, { type: "error", message: error instanceof Error ? error.message : "AI not configured." });
    res.end();
    return;
  }

  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  req.on("close", onClientClose);

  let questions: RawCard[] = [];
  try {
    questions = await generateQbankCards(
      openai,
      text,
      questionCount,
      req.log,
      abortController.signal,
      customPrompt,
      (done, total) => {
        const frac = total > 0 ? done / total : 1;
        const pct = Math.round(15 + frac * (85 - 15));
        sseEmit(res, {
          type: "progress",
          percent: pct,
          message: `Writing MCQs… (${done}/${total} chunks)`,
        });
      }
    );
  } catch (error) {
    req.off("close", onClientClose);
    if (isAbortError(error) || abortController.signal.aborted) {
      req.log.info("AI question bank generation cancelled by client");
      try { sseEmit(res, { type: "error", message: "Cancelled" }); } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    req.log.error({ err: error }, "AI question bank generation failed");
    const status = getErrorStatus(error);
    const code = getErrorCode(error);
    const msg = (status === 429 || code === "too_many_requests")
      ? "AI is temporarily rate-limited. Wait a minute and try again."
      : (error instanceof Error ? error.message : "AI question bank generation failed.");
    sseEmit(res, { type: "error", message: msg });
    res.end();
    return;
  }
  req.off("close", onClientClose);
  if (abortController.signal.aborted) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }

  sseEmit(res, { type: "progress", percent: 85, message: "Saving question bank…" });

  const filtered = questions.filter(c => c.type === "mcq" && Array.isArray(c.choices) && c.choices.length >= 2 && typeof c.correctIndex === "number");
  if (filtered.length === 0) {
    sseEmit(res, { type: "error", message: "AI did not generate any usable MCQs." });
    res.end();
    return;
  }

  try {
    const [primaryDeck] = await db
      .insert(decksTable)
      .values({ name: deckName, parentId: parentId ?? null, kind: "qbank" })
      .returning();

    if (!primaryDeck) {
      sseEmit(res, { type: "error", message: "Failed to save question bank." });
      res.end();
      return;
    }

    const cardRows: (typeof cardsTable.$inferInsert)[] = filtered.map(c => ({
      deckId: primaryDeck.id,
      front: c.front,
      back: c.back,
      image: null,
      cardType: "mcq" as const,
      choices: c.choices ? JSON.stringify(c.choices) : null,
      correctIndex: typeof c.correctIndex === "number" ? c.correctIndex : null,
      pageNumber: c.pageNumber ?? null,
    }));

    const inserted = await db.insert(cardsTable).values(cardRows).returning();

    sseEmit(res, {
      type: "done",
      generatedCount: inserted.length,
      deck: { ...primaryDeck, cardCount: inserted.length, createdAt: primaryDeck.createdAt.toISOString() },
    });
    res.end();
  } catch (err) {
    req.log.error({ err }, "Question bank insert failed");
    sseEmit(res, { type: "error", message: err instanceof Error ? err.message : "Failed to save question bank." });
    res.end();
  }
});

router.post("/generate", async (req, res, next): Promise<void> => {
  const parsed = GenerateCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, deckName, cardCount = 20, visualCardCount, parentId, pageImages, pageTexts, deckType: rawDeckType, customPrompt } = parsed.data;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate cards from." });
    return;
  }

  const selectedImages = Array.isArray(pageImages) && pageImages.length > 0
    ? pageImages.slice(0, MAX_PAGE_IMAGES)
    : [];
  const hasImages = selectedImages.length > 0;
  const deckType = resolveDeckType(rawDeckType, hasImages);
  const wantText = deckType === "text" || deckType === "both";
  const wantVisual = (deckType === "visual" || deckType === "both") && hasImages;
  const maxTextCards = wantText ? Math.max(cardCount, 1) : 0;
  const maxVisualCards = wantVisual ? Math.max(visualCardCount ?? cardCount, 1) : 0;

  let openai: Awaited<ReturnType<typeof getOpenAIClient>>;
  try {
    openai = await getOpenAIClient();
  } catch (error) {
    req.log.error({ err: error }, "AI card generation failed");
    res.status(503).json({ error: error instanceof Error ? error.message : "AI card generation failed." });
    return;
  }

  let textCards: RawCard[] = [];
  let visualCards: VisualCardResult[] = [];

  try {
    [textCards, visualCards] = await Promise.all([
      wantText ? generateTextCards(openai, text, maxTextCards, req.log, undefined, customPrompt, undefined, pageTexts) : Promise.resolve([] as RawCard[]),
      wantVisual ? generateAllVisualCards(openai, selectedImages, maxVisualCards, req.log, undefined, undefined, customPrompt) : Promise.resolve([]),
    ]);
  } catch (error) {
    req.log.error({ err: error }, "AI card generation failed");
    const status = getErrorStatus(error);
    const code = getErrorCode(error);
    if (status === 429 || code === "too_many_requests") {
      res.status(429).json({ error: "AI is temporarily rate-limited. Wait a minute and try again." });
      return;
    }
    res.status(503).json({ error: error instanceof Error ? error.message : "AI card generation failed." });
    return;
  }

  const filteredText = textCards
    .map(c => normalizeCard(c))
    .filter((c): c is RawCard => c !== null);
  const filteredVisual = visualCards.filter(c => c.front.length > 0 && c.back.length > 0);

  if (filteredText.length === 0 && filteredVisual.length === 0) {
    res.status(500).json({ error: "AI did not generate any cards." });
    return;
  }

  try {
    // Single merged deck — text + visual cards together, ordered later by source page.
    const [primaryDeck] = await db
      .insert(decksTable)
      .values({ name: deckName, parentId: parentId ?? null })
      .returning();

    if (!primaryDeck) {
      res.status(500).json({ error: "Failed to save deck." });
      return;
    }

    const cardRows: (typeof cardsTable.$inferInsert)[] = [
      ...filteredText.map(c => ({
        deckId: primaryDeck.id,
        front: c.front,
        back: c.back,
        image: null,
        cardType: c.type === "mcq" ? ("mcq" as const) : ("basic" as const),
        choices: c.type === "mcq" && c.choices ? JSON.stringify(c.choices) : null,
        correctIndex: c.type === "mcq" && typeof c.correctIndex === "number" ? c.correctIndex : null,
        pageNumber: c.pageNumber ?? null,
      })),
      ...filteredVisual.map(c => ({
        deckId: primaryDeck.id,
        front: c.front,
        back: c.back,
        image: c.image.startsWith("data:") ? c.image : `data:image/jpeg;base64,${c.image}`,
        sourceImage: c.sourceImage ?? null,
        bbox: c.bbox ? JSON.stringify(c.bbox) : null,
        pageNumber: c.pageNumber ?? null,
      })),
    ];

    const allInserted = cardRows.length > 0
      ? await db.insert(cardsTable).values(cardRows).returning()
      : [];

    res.status(201).json({
      deck: { ...primaryDeck, cardCount: allInserted.length, createdAt: primaryDeck.createdAt.toISOString() },
      cards: allInserted.map(serializeCard),
      generatedCount: allInserted.length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
