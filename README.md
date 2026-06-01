# Blackboard Student Assistant

A **Chrome extension** that helps students stay on top of **Blackboard** (Learn Ultra and classic): scan deadlines and grades, parse syllabi **locally**, confirm grading weights, calculate course grades, and optionally sync to **Google Calendar**.

---

## Download (ZIP — ready to install)

**Latest release (v1.2.0)** — includes the full `extension` folder and icons:

| File | Link |
|------|------|
| **ZIP in this repo** | [releases/Blackboard-Student-Assistant-v1.2.0.zip](releases/Blackboard-Student-Assistant-v1.2.0.zip) |
| **GitHub auto-ZIP (`main`)** | [Download main branch as ZIP](https://github.com/Saumya-Patel-10/Blackboard-Student-Assistant/archive/refs/heads/main.zip) |

### Install from the ZIP

1. Download and **unzip** the file.
2. Open **Chrome** → `chrome://extensions` → turn on **Developer mode**.
3. Click **Load unpacked** → select the **`extension`** folder inside the unzipped folder.
4. Open **Options** and set your Blackboard URL if needed.

You do **not** need a `.git` folder to run the extension.

---

## Highlights

- **Deadlines** — Scan Blackboard; edit dates under **Update schedule**; optional notifications.
- **Syllabus (local only)** — Upload PDF/DOCX or paste text. Parsing runs **on your device** with **no API**.
- **Confirm grading weights** — After parse, review/edit categories and weights in a confirmation panel. The **grade calculator uses only confirmed weights**.
- **Grade calculator** — Enter scores as **percent** or **earned/total** (e.g. `72/80`). Weights should total ~100%.
- **Google Calendar** — Sync deadlines and exams (optional OAuth in Settings).
- **Gemini (optional)** — Only for **Fill from Blackboard grades** in the calculator, not for syllabus parsing.

---

## Syllabus workflow

1. **Upload Syllabus** → select course → paste text or upload PDF/DOCX → **Parse Syllabus**.
2. The **Confirm grading weights** panel opens with detected categories (e.g. Exam 1–4 at 12% each).
3. Edit names/weights → **Confirm & use for grade calculator**.
4. Open **Calculate Grades** for that course.

You can also use **Enter grading weights manually** without parsing a syllabus, or **Edit grading weights** later from parsed results.

---

## Get the code with Git

```bash
git clone https://github.com/Saumya-Patel-10/Blackboard-Student-Assistant.git
cd Blackboard-Student-Assistant
```

Load the `extension` folder in Chrome as above. The hidden **`.git`** folder is created by `git clone` on your machine — it is **never** uploaded to GitHub.

---

## Configuration

- **Blackboard URL** — Options → your school’s Blackboard origin (e.g. `https://elearning.utdallas.edu`).
- **Google Calendar** — Options → Connect (requires Google Cloud OAuth setup for the extension ID).
- **Gemini API key (optional)** — Options → for AI grade fill from Blackboard only.

---

## Privacy

- Syllabus parsing and most Blackboard scraping stay **in the browser**.
- **Gemini** and **Google Calendar** are used only when you configure them and use those features.

---

## License

Provided as-is for educational use. Comply with your LMS terms and academic integrity policies.
