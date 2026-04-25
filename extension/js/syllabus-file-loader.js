/**
 * Extract plain text from syllabus files (PDF, DOCX, TXT) for parsing.
 * Depends on vendor/pdf.min.js and vendor/mammoth.browser.min.js (loaded before this file).
 */
(function (global) {
  'use strict';

  function stripNulls(str) {
    return str.replace(/\u0000/g, '');
  }

  function looksLikeBinaryGarbage(str) {
    if (!str || str.length < 40) return false;
    let ctrl = 0;
    const sample = str.slice(0, 4000);
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) ctrl++;
    }
    return ctrl / sample.length > 0.03;
  }

  async function extractFromPdf(arrayBuffer) {
    const pdfjsLib = global.pdfjsLib;
    if (!pdfjsLib || !pdfjsLib.getDocument) {
      throw new Error('PDF library not loaded');
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL && pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');
    }
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const parts = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const textContent = await page.getTextContent();
      const line = textContent.items.map((it) => ('str' in it ? it.str : '')).join(' ');
      parts.push(line);
    }
    return parts.join('\n\n').replace(/\s+\n/g, '\n').trim();
  }

  async function extractFromDocx(arrayBuffer) {
    const mammoth = global.mammoth;
    if (!mammoth || !mammoth.extractRawText) {
      throw new Error('DOCX library not loaded');
    }
    const result = await mammoth.extractRawText({ arrayBuffer });
    return (result.value || '').trim();
  }

  /**
   * @param {File} file
   * @returns {Promise<{ text: string, format: string }>}
   */
  async function extractTextFromFile(file) {
    const name = (file.name || '').toLowerCase();
    const buf = await file.arrayBuffer();

    if (name.endsWith('.txt') || file.type === 'text/plain') {
      const dec = new TextDecoder('utf-8', { fatal: false });
      let text = dec.decode(buf);
      text = stripNulls(text);
      if (looksLikeBinaryGarbage(text)) {
        throw new Error('This file does not look like plain text. Try PDF or DOCX, or paste text.');
      }
      return { text: text.trim(), format: 'text' };
    }

    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      const text = await extractFromPdf(buf);
      if (!text || text.length < 20) {
        throw new Error('Could not read text from this PDF. Try pasting the syllabus text instead.');
      }
      return { text, format: 'pdf' };
    }

    if (
      name.endsWith('.docx') ||
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const text = await extractFromDocx(buf);
      if (!text || text.length < 20) {
        throw new Error('Could not read text from this DOCX. Try pasting the syllabus text instead.');
      }
      return { text, format: 'docx' };
    }

    if (name.endsWith('.doc') && file.type !== 'application/pdf') {
      throw new Error('Older .doc files are not supported. Save as DOCX or PDF, or paste the text.');
    }

    throw new Error('Unsupported file type. Use PDF, DOCX, or TXT, or paste text.');
  }

  global.BSASyllabusFileLoader = {
    extractTextFromFile,
    looksLikeBinaryGarbage,
  };
})(typeof self !== 'undefined' ? self : this);
