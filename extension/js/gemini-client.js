/**
 * Google Gemini API helpers for syllabus parsing and grade extraction.
 * Used by the background service worker (generateContent REST API).
 */
(function (global) {
  'use strict';

  const DEFAULT_MODEL = 'gemini-2.0-flash';

  function dataUrlToInlinePart(dataUrl) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
    if (!m) return null;
    return {
      inlineData: {
        mimeType: m[1] || 'image/png',
        data: m[2],
      },
    };
  }

  /**
   * @param {string} apiKey
   * @param {string} model
   * @param {Array<{text?: string, inlineData?: { mimeType: string, data: string }}>} parts
   * @param {string} [systemInstruction]
   * @returns {Promise<string>}
   */
  async function generateText(apiKey, model, parts, systemInstruction) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.error?.message || res.statusText || 'Gemini request failed';
      throw new Error(msg);
    }

    const text =
      json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    return text.trim();
  }

  /**
   * @param {string} apiKey
   * @param {string} rawText syllabus or extracted text
   * @param {string|null} gradingImageDataUrl optional data URL of grading table / full page image
   * @returns {Promise<object>} Parsed syllabus object (same shape as SyllabusParser.parse)
   */
  async function parseSyllabusStructured(apiKey, rawText, gradingImageDataUrl) {
    const sys = `You are an assistant that extracts structured data from course syllabi for a student Chrome extension.
Return ONLY valid JSON, no markdown fences. Use this exact shape:
{
  "gradingBreakdown": {
    "categories": [ { "category": "string", "weight": number, "isAggregate": boolean optional } ],
    "totalWeight": number,
    "isValid": boolean
  },
  "exams": [ { "type": "string", "dateRaw": "string|null", "date": "ISO-8601 string|null", "context": "string" } ],
  "assignments": [ { "title": "string", "dateRaw": "string|null", "date": "ISO-8601 string|null", "type": "assignment|exam|quiz|project|lab|discussion" } ],
  "officeHours": { "times": ["string"], "location": "string|null", "rawText": "string" } | null,
  "courseInfo": { "courseNumber": "string|null", "instructor": "string|null", "email": "string|null", "semester": "string|null" },
  "schedule": [ { "week": number, "topics": ["string"], "raw": "string" } ],
  "policies": { "late": "string|null", "attendance": "string|null" }
}
Rules:
- Weights are percentages 0-100. Sum categories to match the syllabus; set isValid true if total is 90-110.
- If the syllabus lists multiple exams each with its own weight (e.g. Exam 1 12%, Exam 2 12%), output a separate category row for EACH exam with that weight — do not combine into one "Exams" row unless the syllabus only gives a single combined exam category.
- Parse dates conservatively; use ISO 8601 in UTC when you can infer a calendar date, else null.
- If the document is scanned or messy, still extract what you can from images and text.
- categories: include Homework, Exams, Quizzes, Projects, Participation, etc. as labeled in the syllabus.`;

    const parts = [{ text: `Syllabus text:\n${rawText || '(no text)'}` }];
    const img = gradingImageDataUrl ? dataUrlToInlinePart(gradingImageDataUrl) : null;
    if (img) parts.push(img);

    const out = await generateText(apiKey, DEFAULT_MODEL, parts, sys);
    return parseJsonLoose(out);
  }

  /**
   * Build the exact grade line format required for weighted calculations: "HW1 - 9/10 HW2 - 10/10"
   * @param {Array<{name:string, score?:number|null, total?:number|null}>} grades
   */
  function formatGradesForCalculationPrompt(grades) {
    const lines = (grades || [])
      .filter((g) => g && g.name && g.score != null && g.total != null && g.total !== 0)
      .map((g) => `${String(g.name).trim()} - ${g.score}/${g.total}`);
    return lines.join(' ');
  }

  /**
   * Ask Gemini to map raw grade lines + syllabus categories to category scores (%).
   * @param {string} apiKey
   * @param {string} categoriesJson JSON array of {category, weight}
   * @param {string} gradeLinesExact format "Name - score/total ..." single line
   * @param {string|null} screenImageDataUrl optional screenshot of grades page
   */
  async function inferCategoryScoresFromGrades(apiKey, categoriesJson, gradeLinesExact, screenImageDataUrl) {
    const sys = `You map individual graded items to syllabus categories and compute each category's average percentage (0-100).
The user will provide grade lines in this EXACT format (space-separated): "HW1 - 9/10 HW2 - 10/10 Exam1 - 45/50"
Average all items that belong to the same syllabus category (e.g. all HW together), then return one score per category.
Return ONLY valid JSON: { "scores": [ { "category": "exact name from input", "weight": number, "score": number|null } ] }
Match category names exactly to the provided list. Use null for score if no items match that category.`;

    const parts = [
      {
        text:
          `Syllabus categories (JSON): ${categoriesJson}\n\n` +
          `Grade lines (use exactly this string for item names and fractions): ${gradeLinesExact || '(none)'}\n\n` +
          'Infer category average scores from the grade lines. If a screenshot is attached, use it to resolve names and scores.',
      },
    ];
    const img = screenImageDataUrl ? dataUrlToInlinePart(screenImageDataUrl) : null;
    if (img) parts.push(img);

    const out = await generateText(apiKey, DEFAULT_MODEL, parts, sys);
    return parseJsonLoose(out);
  }

  function parseJsonLoose(s) {
    let t = String(s || '').trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
    return JSON.parse(t);
  }

  global.BSAGeminiClient = {
    DEFAULT_MODEL,
    generateText,
    parseSyllabusStructured,
    formatGradesForCalculationPrompt,
    inferCategoryScoresFromGrades,
    dataUrlToInlinePart,
  };
})(typeof self !== 'undefined' ? self : this);
