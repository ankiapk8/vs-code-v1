import express, { Router, type IRouter } from "express";
import multer from "multer";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import type { PDFDocumentProxy } from "pdfjs-dist";

class NodeCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(entry: { canvas: Canvas }, width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  destroy(entry: { canvas: Canvas | null }) {
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      entry.canvas = null;
    }
  }
}

const router: IRouter = Router();
const MIN_TEXT_LENGTH = 20;
const OCR_SCALE = 2;
const MAX_OCR_DIMENSION = 2200;
const MAX_PDF_SIZE = 200 * 1024 * 1024; // 200 MB — matches express body limit

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are accepted."));
    }
  },
});

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pdfDocOptions(buffer: Buffer) {
  const copy = Buffer.from(buffer);
  return {
    data: new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength),
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
    CanvasFactory: NodeCanvasFactory,
  } as unknown as Parameters<(typeof import("pdfjs-dist/legacy/build/pdf.mjs"))["getDocument"]>[0];
}

async function extractEmbeddedPdfText(buffer: Buffer): Promise<{ text: string; pageTexts: string[]; numPages: number }> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjsLib.getDocument(pdfDocOptions(buffer)).promise;
  const numPages = pdf.numPages;
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
        .filter(Boolean)
        .join(" ");
      pageTexts.push(normalizeText(pageText));
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }

  return { text: normalizeText(pageTexts.join("\n")), pageTexts, numPages };
}

async function renderPageToBuffer(pdf: PDFDocumentProxy, pageNumber: number): Promise<Buffer> {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(
    OCR_SCALE,
    MAX_OCR_DIMENSION / Math.max(baseViewport.width, baseViewport.height),
  );
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);

  const factory = new NodeCanvasFactory();
  const entry = factory.create(width, height);

  await page.render({
    canvasContext: entry.context as Parameters<typeof page.render>[0]["canvasContext"],
    canvas: entry.canvas as never,
    viewport,
  }).promise;
  page.cleanup();

  const buffer = (entry.canvas as Canvas).toBuffer("image/png");
  factory.destroy(entry as { canvas: Canvas | null });
  return buffer;
}

async function extractOcrText(buffer: Buffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjsLib.getDocument(pdfDocOptions(buffer)).promise;
  const worker = await createWorker("eng");
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const imageBuffer = await renderPageToBuffer(pdf, pageNumber);
      const { data } = await worker.recognize(imageBuffer);
      pageTexts.push(data.text);
    }
  } finally {
    await worker.terminate();
    await pdf.destroy();
  }

  return normalizeText(pageTexts.join("\n"));
}

async function processPdfBuffer(buffer: Buffer, res: express.Response, log: { info: (msg: string) => void; error: (obj: object, msg: string) => void }): Promise<void> {
  try {
    const { text: embeddedText, pageTexts: embeddedPageTexts } = await extractEmbeddedPdfText(buffer);

    if (embeddedText.length > MIN_TEXT_LENGTH) {
      res.json({ text: embeddedText, pageTexts: embeddedPageTexts, length: embeddedText.length, method: "embedded" });
      return;
    }

    log.info("No embedded text found, running server-side OCR…");
    const ocrText = await extractOcrText(buffer);

    if (ocrText.length <= MIN_TEXT_LENGTH) {
      res.status(422).json({
        error: "No readable text could be extracted from this PDF, even with OCR.",
      });
      return;
    }

    res.json({ text: ocrText, length: ocrText.length, method: "ocr" });
  } catch (error) {
    log.error({ err: error }, "Server-side PDF extraction failed");
    res.status(422).json({
      error: error instanceof Error ? error.message : "Could not extract text from this PDF.",
    });
  }
}

router.post(
  "/extract-pdf",
  (req, res, next) => {
    const ct = req.headers["content-type"] ?? "";
    if (ct.includes("multipart/form-data")) {
      upload.single("file")(req, res, next);
    } else {
      next();
    }
  },
  express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "200mb" }),
  async (req, res): Promise<void> => {
    const log = (req as express.Request & { log: { info: (m: string) => void; error: (o: object, m: string) => void } }).log;

    let buffer: Buffer | null = null;

    if ((req as express.Request & { file?: Express.Multer.File }).file) {
      buffer = (req as express.Request & { file?: Express.Multer.File }).file!.buffer;
    } else if (Buffer.isBuffer(req.body) && req.body.byteLength > 0) {
      buffer = req.body;
    }

    if (!buffer) {
      res.status(400).json({ error: "Upload a PDF file to extract text." });
      return;
    }

    await processPdfBuffer(buffer, res, log);
  },
);

export default router;
