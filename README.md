# Blackboard Student Assistant

A Chrome extension (Manifest V3) that helps students manage coursework on **Blackboard Learn** (Ultra and classic). It scans open Blackboard pages for courses, assignments, and grades; parses syllabi **locally** on your device; lets you **confirm** grading weights before calculations; and optionally syncs deadlines and exams to **Google Calendar**.

All core workflows run in the browser. No account signup, no cloud backend, and no API keys are required for syllabus parsing or grade calculation.

---

## Table of contents

- [Download and install](#download-and-install)
- [Quick start](#quick-start)
- [Features](#features)
- [Grade calculator](#grade-calculator)
- [Syllabus parsing](#syllabus-parsing)
- [Deadlines and calendar](#deadlines-and-calendar)
- [Study planner](#study-planner)
- [Settings](#settings)
- [Project structure](#project-structure)
- [Privacy](#privacy)
- [Development](#development)
- [License](#license)

---

## Download and install

### Option A — Release ZIP (recommended)

| Resource | Link |
|----------|------|
| **v1.3.0 ZIP** (extension + icons) | [releases/Blackboard-Student-Assistant-v1.3.0.zip](releases/Blackboard-Student-Assistant-v1.3.0.zip) |
| **Latest `main` branch** | [Download as ZIP](https://github.com/Saumya-Patel-10/Blackboard-Student-Assistant/archive/refs/heads/main.zip) |

**Install steps**

1. Download and unzip the archive.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the **`extension`** folder (the one that contains `manifest.json`).
5. Pin the extension from the toolbar.
6. Open **Settings** (gear icon in the popup) and set your institution’s Blackboard URL.

You do **not** need Git or a `.git` folder to use the extension. A `.git` folder is only created if you clone the repository for development.

### Option B — Clone with Git

```bash
git clone https://github.com/Saumya-Patel-10/Blackboard-Student-Assistant.git
cd Blackboard-Student-Assistant
```

Then load the `extension` folder in Chrome as described above.

---

## Quick start

1. **Sign in to Blackboard** in a normal Chrome tab (course list, activity stream, or Grades).
2. Open the extension popup and click **refresh** to scan the active tab.
3. **Upload Syllabus** for each course: paste text or upload PDF/DOCX → **Parse Syllabus** → review and **Confirm grading weights**.
4. Open **Calculate Grades**, select the course, enter scores, and view your course grade.
5. Optional: use **Update schedule** to fix due dates, add exams manually, or **Sync Calendar** to push events to Google Calendar.

---

## Features

### Blackboard scanning

- Detects **courses**, **assignments**, and **grades** from pages you visit on supported Blackboard / Instructure hosts.
- Stores data locally in Chrome (`chrome.storage.local`).
- Optional **auto-scan** and **deadline notifications** (configurable in Settings).
- **Rescan** from **Update schedule** when Blackboard changes.

### Syllabus parsing (local only)

- Accepts **plain text**, **PDF**, and **DOCX** (via bundled pdf.js and mammoth).
- Extracts on your device:
  - **Grading breakdown** (categories and weights, including multiple exams such as Exam 1–4 at 12% each)
  - **Exam dates** (when present in text)
  - Course info, office hours, and policies (when detectable)
- **No external API** is used for syllabus parsing.
- After parsing, you **must confirm** weights in the confirmation panel before the grade calculator uses them.

### Grade calculator

- Uses **confirmed syllabus weights** (should total about 100%).
- Accepts grades as a **percentage** (e.g. `85`) or **earned/total** (e.g. `72/80`).
- Supports **dropped assignments/exams** by short codes (see [Grade calculator](#grade-calculator)).
- Two calculation modes: **Course grade** and **Score needed on exam**.
- Optional **Fill from Blackboard** matches scanned grade items to categories by name (no API key).

### Schedule management

- **Update schedule**: edit due dates after a scan, remove items, or **rescan Blackboard**.
- Add items manually as **assignment** or **exam**.
- Manual exams appear in **Calendar → Exams** and in the syllabus summary for that course.

### Google Calendar sync

- Sync selected **deadlines** and **exams** to your primary Google Calendar.
- Edit date/time in the sync panel before pushing.
- Re-sync **updates** existing events (deduplicated by a private sync id), so repeats do not create duplicates.
- Optional **auto-sync** after scans (Settings).

### Study planner

- Set per-course grade goals and study availability in Settings.
- Generates a simple weekly plan from upcoming deadlines.

---

## Grade calculator

Open **Calculate Grades** from the popup dashboard.

### Prerequisites

- Parse a syllabus and **Confirm grading weights**, or use **Enter grading weights manually** on the Syllabus screen.
- Select the course in the grade calculator dropdown.

### Category codes

Each row has a **Code** used for drops and exam targeting:

| Type | Example codes |
|------|----------------|
| Exams | `E1`, `E2`, `E3`, `E4` |
| Assignments / homework | `A1`, `A2`, `A3` |
| Quizzes | `Q1`, `Q2` |
| Other | Short abbreviation (e.g. `AT1` for Attendance) |

Codes are assigned automatically from category names (e.g. “Exam 1” → `E1`).

### Dropped items

Before calculating, indicate whether any items are dropped:

- **No drops** — all categories count toward the course grade.
- **Yes — drop items** — enter codes separated by commas or spaces, e.g. `E1, A2, A3`.

Dropped categories are excluded from the weighted total. The table shows **dropped** in the points column for those rows.

### Mode: Course grade

- Default mode; updates as you enter grades.
- Course percentage = sum of (score% × weight) ÷ sum of **active** weights (after drops).
- Shows letter grade, points earned per category, and each category’s share of the course grade.
- A note appears when active weights do not total about **100%**.

### Mode: Score needed on exam

Use this to answer: *“What do I need on Exam 2 to reach 90% in the course?”*

1. Enter grades for all completed work in the table.
2. Switch to **Score needed on exam**.
3. Select the **exam** from the dropdown.
4. Enter your **target course %** and click **Calculate**.

The result shows the score needed on that exam (as a percent and as `X/100`), based on your other entered grades and active weights.

### Fill from Blackboard

Click **Fill from Blackboard (match names)** after scanning the Grades page on Blackboard. The extension maps Blackboard item names to syllabus categories using keyword rules. You can edit any cell afterward.

---

## Syllabus parsing

1. Open **Upload Syllabus** and select a course.
2. Paste syllabus text, upload **PDF/DOCX/TXT**, or attach a grading-table screenshot for **reference only** (not sent anywhere).
3. Click **Parse Syllabus** (runs locally).
4. The **Confirm grading weights** panel opens:
   - Edit category names and weights.
   - Add or remove rows.
   - Aim for a total of about **100%**.
5. Click **Confirm & use for grade calculator**.

You can reopen **Edit grading weights** from the parsed results at any time.

**Supported grading text formats** include:

- `40%: Homework` and markdown-style `**12%:** Exam 1`
- `Exam 1 - 12%` / `Homework: 40%`
- `4 exams at 12% each` (expanded into separate Exam 1–4 rows when no numbered lines exist)

---

## Deadlines and calendar

### Update schedule

- Lists scanned and manual items with editable **due date/time**.
- **Rescan Blackboard** refreshes from the tab you have open.
- **Add date manually** — choose **Assignment** or **Exam**, course, title, and datetime.

### Sync Calendar

1. Open **Sync Calendar** from the dashboard.
2. **Deadlines** tab — adjust times, save, select items, sync.
3. **Exams** tab — set exam times (from syllabus or manual entry), save, select, sync.
4. Connect Google Calendar once in **Settings** (OAuth).

---

## Study planner

1. Open **Study Plan** from the dashboard.
2. Set a target grade per course (optional).
3. Configure study hours and days in **Settings**.
4. Click **Generate Study Plan** for a week-by-week outline based on deadlines.

---

## Settings

Open via the gear icon in the popup or **Extension options**.

| Setting | Description |
|---------|-------------|
| **Blackboard URL** | Your school’s Blackboard origin (e.g. `https://elearning.utdallas.edu`). |
| **Auto-scan** | Scan when you visit Blackboard (optional). |
| **Scan frequency** | How often background checks run. |
| **Notifications** | Browser alerts before deadlines. |
| **Daily summary** | Morning summary of due work. |
| **Google Calendar** | Connect / disconnect; optional auto-sync. |
| **Study plan** | Hours per day and preferred study days. |
| **Export / Clear data** | Backup or reset all stored extension data. |

**Google Calendar setup** requires a Google Cloud project with the Calendar API enabled and a Chrome extension OAuth client whose Application ID matches the extension ID shown in Settings.

---

## Project structure

```
Blackboard-Student-Assistant/
├── README.md
├── releases/
│   └── Blackboard-Student-Assistant-v1.3.0.zip
└── extension/
    ├── manifest.json          # Extension manifest (MV3)
    ├── icons/                   # Toolbar icons
    ├── pages/
    │   ├── popup.html           # Main popup UI
    │   └── options.html         # Settings page
    ├── css/                     # Styles
    ├── js/
    │   ├── popup.js             # Popup logic and UI
    │   ├── background.js        # Service worker, alarms, messaging
    │   ├── content-script.js    # Blackboard page scraping
    │   ├── syllabus-parser.js   # Local syllabus text parser
    │   ├── syllabus-file-loader.js
    │   ├── grade-calculator.js  # Weighted grade math
    │   ├── calendar-integration.js
    │   ├── study-planner.js
    │   └── options.js
    └── vendor/                  # pdf.js, mammoth (bundled)
```

---

## Privacy

| Data | Where it goes |
|------|----------------|
| Blackboard scrape results | Stored locally in your browser only |
| Syllabus text and parsed weights | Stored locally; parsed on device |
| Grades you enter | Stored locally; calculated on device |
| Google Calendar | Sent to Google only if you connect and sync |
| External servers | Blackboard (when you browse), Google Calendar (if enabled) |

The extension does not require an API key for syllabus parsing or grade calculation. Review your institution’s LMS and academic integrity policies before use.

---

## Development

**Requirements:** Google Chrome (or Chromium), Developer mode enabled.

**Load unpacked:** point Chrome at the `extension` folder.

**Version:** see `extension/manifest.json` (currently **1.3.0**).

**Supported hosts** (content scripts): `*.blackboard.com`, `*.instructure.com`, and configured institution URLs in the manifest.

After code changes, click **Reload** on `chrome://extensions`.

---

## License

This project is provided as-is for educational and personal productivity use. Ensure compliance with your learning management system’s terms of service and your school’s academic integrity rules.

---

## Repository

https://github.com/Saumya-Patel-10/Blackboard-Student-Assistant
