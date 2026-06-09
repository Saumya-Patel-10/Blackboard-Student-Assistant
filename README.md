# Blackboard Student Assistant

A **Chrome extension** that helps students stay on top of **Blackboard** (Learn Ultra and classic): it scans open course pages for **deadlines**, **grades**, and **courses**, surfaces them in a compact popup, parses syllabi **locally**, and syncs deadlines to **Google Calendar**.

---

## Highlights

- **Deadline awareness** — Aggregates upcoming work from the current Blackboard view, with optional browser notifications before due dates.
- **Grade calculator** — Combines syllabus **category weights** with grades scraped from Blackboard. **Fill from Blackboard** matches items to categories by name — no API key required.
- **Syllabus intelligence** — Upload **PDF**, **DOCX**, or **plain text**. Parsing runs **locally** on your device; you confirm grading weights before the calculator uses them.
- **Google Calendar** — Sync selected deadlines to your primary calendar. Events carry a **private sync id** so **re-syncing updates the same event** instead of creating duplicates.

---

## Download (install without Git)

**Latest release (v1.5.0)** — all recent fixes in one build:

[Download Blackboard-Student-Assistant-v1.5.0.zip](https://github.com/Saumya-Patel-10/Blackboard-Student-Assistant/raw/cursor/release-v1.5.0-6fe7/releases/Blackboard-Student-Assistant-v1.5.0.zip)

Includes: no API key for grades, Ultra course scanning, closed courses filtered, editable calendar event names, Study Plan removed, UI refresh.

1. Download and unzip the file.
2. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** → select the **`extension`** folder inside the zip.
3. **Reload** the extension after each update (click Reload on `chrome://extensions`).
4. Open Blackboard on your **Courses list** page (where you see all courses), then click the extension **refresh** button.

---

## Installation (development)

1. Clone this repository.
2. Open **Chrome** → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension` folder.
3. Pin the extension and open **Options** to set your institution’s Blackboard base URL if needed.

---

## Configuration

### Blackboard URL

In **Extension options**, set your school’s Blackboard origin (for example `https://elearning.utdallas.edu`). This is used for background auto-scan when that feature is enabled.

### Google Calendar

The extension uses **OAuth2** with the `calendar.events` scope. For **Chrome extension** OAuth clients, register the **extension ID** shown in options with Google Cloud and enable the **Google Calendar API**. Use **Connect** in options to authorize.

**Auto-sync** (optional): when enabled, new scans can push **upcoming** deadlines to Calendar; each logical assignment maps to one Calendar event, **updated** on subsequent syncs rather than duplicated.

---

## How to use

1. **Sign in to Blackboard** and open your **Courses** page (the list showing all enrolled courses — not inside a single course).
2. Open the extension popup and click **refresh** to scan that tab. If you see 0 courses, reload the Blackboard tab once, wait for the course cards to appear, then scan again.
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
