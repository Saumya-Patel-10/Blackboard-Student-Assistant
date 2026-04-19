# Blackboard Student Assistant

A **Chrome extension** that helps students stay on top of **Blackboard** (Learn Ultra and classic): it scans open course pages for **deadlines**, **grades**, and **courses**, surfaces them in a compact popup, and adds optional **Google Calendar** sync and **AI-assisted** syllabus parsing via the **Google Gemini API**.

---

## Highlights

- **Deadline awareness** — Aggregates upcoming work from the current Blackboard view, with optional browser notifications before due dates.
- **Grade calculator** — Combines syllabus **category weights** with grades scraped from Blackboard. With a **Gemini API key**, the extension sends grade lines to the model in a fixed format (`HW1 - 9/10 HW2 - 10/10`) and can use a **screenshot of the active tab** so category averages align with what you see on screen.
- **Syllabus intelligence** — Upload **PDF**, **DOCX**, or **plain text**, or attach a **screenshot** of the syllabus. Local heuristics run first; **Gemini** fills gaps for messy PDFs, scans, and images when an API key is configured.
- **Google Calendar** — Sync selected deadlines to your primary calendar. Events carry a **private sync id** so **re-syncing updates the same event** instead of creating duplicates.
- **Study planner** — Builds a simple weekly plan from deadlines and your stated study availability (configured in options).

---

## Installation (development)

1. Clone this repository.
2. Open **Chrome** → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension` folder.
3. Pin the extension and open **Options** to set your institution’s Blackboard base URL if needed.

---

## Configuration

### Blackboard URL

In **Extension options**, set your school’s Blackboard origin (for example `https://elearning.utdallas.edu`). This is used for background auto-scan when that feature is enabled.

### Google AI (Gemini)

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey) (Generative Language API).
2. Paste it under **Google AI (Gemini)** in the options page. The key is stored only in **local extension storage** on your machine.

Without a key, syllabus parsing uses **local text rules** only, and grade fill falls back to **keyword matching** between Blackboard item names and syllabus categories.

### Google Calendar

The extension uses **OAuth2** with the `calendar.events` scope. For **Chrome extension** OAuth clients, register the **extension ID** shown in options with Google Cloud and enable the **Google Calendar API**. Use **Connect** in options to authorize.

**Auto-sync** (optional): when enabled, new scans can push **upcoming** deadlines to Calendar; each logical assignment maps to one Calendar event, **updated** on subsequent syncs rather than duplicated.

---

## How to use

1. **Sign in to Blackboard** in a normal tab. Visit course lists, the activity stream, or the **Grades** page.
2. Open the extension popup and use **refresh** to scan the **active tab**, or rely on automatic scans if configured.
3. **Upload Syllabus** — Pick a course, add file or paste text (or image with Gemini), then **Parse Syllabus**.
4. **Calculate Grades** — Choose a course, optionally set a **target %** (prompted once when you first have data), then **Fill from Blackboard grades (AI)** with the Grades page visible if you use screen capture.
5. **Sync Calendar** — Select deadlines and sync; repeat safely — existing events are **updated** by sync id.

---

## Privacy and security

- **Blackboard data** is processed locally in the browser except when you **opt in** to Gemini (syllabus or grade inference) or **Google Calendar** (events API).
- **Gemini** requests include syllabus text and/or images you provide, formatted grade strings, and optionally a **JPEG capture of the visible tab** when you enable that option.
- Review [Google’s AI terms](https://ai.google.dev/terms) and your institution’s policies before use.

---

## Technical stack

- **Manifest V3** service worker (`background.js`)
- **Content scripts** for DOM scraping on Blackboard / Canvas-style hosts allowed in `manifest.json`
- **pdf.js** and **mammoth** (bundled) for PDF/DOCX text extraction
- **Google Calendar REST API** with `extendedProperties.private` for deduplication
- **Gemini** `generateContent` (REST) for structured JSON extraction

---

## License

This project is provided as-is for educational and productivity use. Ensure compliance with your learning management system’s terms of service and your school’s academic integrity rules.
