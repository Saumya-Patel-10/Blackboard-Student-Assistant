/**
 * Blackboard Student Assistant - Content Script
 *
 * Runs on Blackboard pages (including Ultra and custom-domain installs
 * like elearning.utdallas.edu) to scrape course data, assignments,
 * deadlines, and grades from the DOM.
 */

(function () {
  'use strict';

  const BSA = {
    courses: [],
    assignments: [],
    grades: [],
    scannedAt: null,

    init() {
      this.waitForPageLoad().then(() => {
        this.showScanIndicator();
        setTimeout(() => this.scan(), 2000);
      });
      this.listenForMessages();
    },

    waitForPageLoad() {
      return new Promise((resolve) => {
        if (document.querySelector('[class*="course"], [data-course-id], #base_listContainer, #content_listContainer')) {
          return resolve();
        }
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          if (document.body.innerText.length > 200 || attempts > 15) {
            clearInterval(interval);
            resolve();
          }
        }, 1000);
      });
    },

    listenForMessages() {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === 'scan') {
          this.scan().then(() => sendResponse({ success: true }));
          return true;
        }
        if (msg.action === 'getPageData') {
          sendResponse({
            courses: this.courses,
            assignments: this.assignments,
            grades: this.grades,
            scannedAt: this.scannedAt,
            url: window.location.href
          });
        }
      });
    },

    async scan() {
      this.showScanIndicator();
      try {
        this.courses = this.scrapeCourses();
        this.assignments = this.scrapeAssignments();
        this.grades = this.scrapeGrades();
        this.scannedAt = new Date().toISOString();

        const merged = await this.mergeWithStoredData({
          courses: this.courses,
          assignments: this.assignments,
          grades: this.grades,
        });
        this.courses = merged.courses;
        this.assignments = merged.assignments;
        this.grades = merged.grades;

        await chrome.storage.local.set({
          courses: this.courses,
          assignments: this.assignments,
          grades: this.grades,
          lastScan: this.scannedAt,
          blackboardUrl: window.location.origin
        });

        chrome.runtime.sendMessage({
          action: 'scanComplete',
          data: {
            coursesCount: this.courses.length,
            assignmentsCount: this.assignments.length,
          }
        });

        this.showToast(
          'Scan Complete',
          `Found ${this.courses.length} courses and ${this.assignments.length} assignments`
        );
      } catch (err) {
        console.error('[BSA] Scan error:', err);
        this.showToast('Scan Error', 'Could not parse Blackboard data. Try refreshing.');
      }
      this.hideScanIndicator();
    },

    async mergeWithStoredData(fresh) {
      const prev = await chrome.storage.local.get(['courses', 'assignments', 'grades']);
      const oldCourses = prev.courses || [];
      const oldAssignments = prev.assignments || [];
      const oldGrades = prev.grades || [];

      const courseById = new Map();
      for (const c of oldCourses) {
        if (c?.id) courseById.set(c.id, c);
      }
      for (const c of fresh.courses) {
        if (c?.id && !courseById.has(c.id)) courseById.set(c.id, c);
      }
      const courses = Array.from(courseById.values());

      const assignmentKey = (a) =>
        `${a.courseId || ''}|${(a.title || '').trim().toLowerCase().substring(0, 120)}`;

      const freshByKey = new Map();
      for (const a of fresh.assignments) {
        const k = assignmentKey(a);
        if (!freshByKey.has(k)) freshByKey.set(k, a);
      }

      const userOverrideByKey = new Map();
      for (const a of oldAssignments) {
        if (a?.userEdited || a?.dueDateOverride) userOverrideByKey.set(assignmentKey(a), a);
      }

      const mergedAssignments = [];
      const seen = new Set();

      for (const [k, freshA] of freshByKey) {
        if (userOverrideByKey.has(k)) {
          const oldA = userOverrideByKey.get(k);
          const merged = { ...freshA, id: oldA.id || freshA.id };
          if (oldA.dueDateOverride) merged.dueDateOverride = oldA.dueDateOverride;
          if (oldA.userEdited) {
            merged.dueDate = oldA.dueDate;
            merged.dueDateRaw = oldA.dueDateRaw;
            merged.userEdited = true;
          }
          mergedAssignments.push(merged);
          userOverrideByKey.delete(k);
        } else {
          mergedAssignments.push(freshA);
        }
        seen.add(k);
      }

      for (const [, a] of userOverrideByKey) {
        mergedAssignments.push(a);
        seen.add(assignmentKey(a));
      }

      for (const a of oldAssignments) {
        if (a?.id?.startsWith('exam_')) {
          const k = assignmentKey(a);
          if (!seen.has(k)) {
            mergedAssignments.push(a);
            seen.add(k);
          }
        }
      }

      const deduped = this.dedupeAssignmentsByKey(mergedAssignments);

      const gradeKey = (g) =>
        `${g.courseId || ''}|${(g.name || '').trim().toLowerCase().substring(0, 80)}`;

      const mergedGrades = [];
      const seenG = new Set();
      for (const g of fresh.grades) {
        const k = gradeKey(g);
        if (seenG.has(k)) continue;
        seenG.add(k);
        mergedGrades.push(g);
      }
      for (const g of oldGrades) {
        const k = gradeKey(g);
        if (!seenG.has(k)) {
          seenG.add(k);
          mergedGrades.push(g);
        }
      }

      return {
        courses,
        assignments: deduped,
        grades: mergedGrades,
      };
    },

    dedupeAssignmentsByKey(assignments) {
      const assignmentKey = (a) =>
        `${a.courseId || ''}|${(a.title || '').trim().toLowerCase().substring(0, 120)}`;
      const byKey = new Map();
      for (const a of assignments) {
        const k = assignmentKey(a);
        const cur = byKey.get(k);
        if (!cur) {
          byKey.set(k, a);
          continue;
        }
        if (a.userEdited && !cur.userEdited) {
          byKey.set(k, { ...a, id: cur.id?.startsWith('asg_') ? cur.id : a.id });
          continue;
        }
        if (cur.userEdited && !a.userEdited) continue;
        let prefer = cur;
        let other = a;
        if (String(a.id || '').startsWith('asg_') && !String(cur.id || '').startsWith('asg_')) {
          prefer = a;
          other = cur;
        }
        const merged = {
          ...prefer,
          dueDate: prefer.dueDate || other.dueDate,
          dueDateRaw: prefer.dueDateRaw || other.dueDateRaw,
          url: prefer.url || other.url,
        };
        byKey.set(k, merged);
      }
      return Array.from(byKey.values());
    },

    scrapeCourses() {
      const courses = [];
      const courseColors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
      const seen = new Set();

      // --- Blackboard Ultra selectors ---
      // Course cards on Ultra dashboard / course list
      const ultraSelectors = [
        'a[href*="/ultra/courses"]',
        'a[href*="/ultra/course"]',
        'a[href*="ultra/courses"]',
        '[class*="course-org-list"] a',
        '[class*="course-list"] a',
        'div[data-course-id]',
        'a[data-analytics-id*="course"]',
        'bb-base-course-org-list a',
      ];

      // --- Blackboard Classic selectors ---
      const classicSelectors = [
        'a[href*="course_id"]',
        '#module\\:_4_1 a',
        '.courseListing a',
        '#div_4_1 a',
        '.portletList-img a',
      ];

      const allSelectors = [...ultraSelectors, ...classicSelectors];

      for (const sel of allSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          els.forEach(el => {
            const text = (el.textContent || '').trim();
            if (!text || text.length < 5) return;
            const href = el.getAttribute('href') || '';
            if (!href) return;

            const key = href + '|' + text.substring(0, 40);
            if (seen.has(key)) return;
            seen.add(key);

            const courseId = this.extractCourseId(href);
            if (!courseId) return;

            courses.push({
              id: courseId,
              name: this.cleanCourseName(text),
              fullName: text,
              url: href.startsWith('http') ? href : window.location.origin + href,
              color: courseColors[courses.length % courseColors.length],
              currentGrade: null,
            });
          });
        } catch (_) {}
      }

      // Fallback: scan the full page text for course-number patterns
      if (courses.length === 0) {
        courses.push(...this.scrapeCoursesFromText());
      }

      return courses;
    },

    scrapeCoursesFromText() {
      const courses = [];
      const courseColors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
      const body = document.body.innerText;

      // Match patterns like "CS 3345.501 - Data Structures and Foundations of Algo"
      // or "2262-UTDAL-CS-3345-SEC501-23678"
      const patterns = [
        /([A-Z]{2,4}\s*\d{4}(?:\.\d{3})?)\s*[-–:]\s*(.+)/g,
        /\d{4}-\w+-([A-Z]{2,4})-(\d{4})-\w+-\d+\s*\n?\s*([A-Z]{2,4}\s+\d{4}\.\d{3}\s*[-–]\s*.+)/g,
      ];

      const seen = new Set();

      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(body)) !== null) {
          let name;
          if (m[3]) {
            name = m[3].trim();
          } else {
            name = (m[1] + ' - ' + m[2]).trim();
          }

          const shortName = name.substring(0, 60);
          if (seen.has(shortName)) continue;
          seen.add(shortName);

          const idPart = (m[1] || m[3] || '').replace(/\s+/g, '');
          courses.push({
            id: 'course_' + idPart + '_' + courses.length,
            name: this.cleanCourseName(shortName),
            fullName: name,
            url: window.location.href,
            color: courseColors[courses.length % courseColors.length],
            currentGrade: null,
          });
        }
      }

      // Also look for course headings in the Grades page
      const headings = document.querySelectorAll('h1, h2, h3, h4, [class*="heading"], [class*="title"]');
      headings.forEach(el => {
        const text = el.textContent.trim();
        const match = text.match(/([A-Z]{2,4}\s*\d{4}(?:\.\d{3})?)\s*[-–:]\s*(.+)/);
        if (match) {
          const name = match[0].substring(0, 60);
          if (!seen.has(name)) {
            seen.add(name);
            courses.push({
              id: 'course_' + match[1].replace(/\s+/g, '') + '_' + courses.length,
              name: this.cleanCourseName(name),
              fullName: match[0],
              url: window.location.href,
              color: courseColors[courses.length % courseColors.length],
              currentGrade: null,
            });
          }
        }
      });

      return courses;
    },

    stableAssignmentId(courseId, title) {
      const t = (title || 'item').trim().toLowerCase().substring(0, 120);
      const slug = t.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 80) || 'item';
      return `asg_${courseId || 'nocourse'}_${slug}`;
    },

    scrapeAssignments() {
      const assignments = [];
      const seen = new Set();

      // Ultra: activity stream, due dates, content items
      const selectors = [
        '[class*="activity"] [class*="item"]',
        '[class*="due-date"]',
        '[class*="upcoming"]',
        '[class*="deadline"]',
        '[class*="assessment"]',
        '[class*="assignment"]',
        // Classic
        '.sortable_item_row',
        '#content_listContainer li',
        '[id*="contentListItem"]',
      ];

      for (const sel of selectors) {
        try {
          document.querySelectorAll(sel).forEach(el => {
            const text = el.textContent.trim();
            if (!text || text.length < 5) return;
            const courseId = this.guessCourseFromUrl();
            const title = (this.extractTitle(el) || text.substring(0, 80)).trim();
            const key = `${courseId}|${title.toLowerCase().substring(0, 100)}`;
            if (seen.has(key)) return;
            seen.add(key);

            const dateStr = this.findDateInElement(el);
            const dueDate = dateStr ? this.parseDate(dateStr) : null;
            const type = this.guessAssignmentType(title);

            assignments.push({
              id: this.stableAssignmentId(courseId, title),
              title,
              dueDate,
              dueDateRaw: dateStr,
              type,
              courseId,
              url: this.extractLink(el),
              submitted: /submitted|graded|complete/i.test(text),
              points: this.extractPoints(text),
            });
          });
        } catch (_) {}
      }

      // Fallback: scan text for due-date patterns
      if (assignments.length === 0) {
        assignments.push(...this.scrapeAssignmentsFromText());
      }

      return assignments;
    },

    scrapeAssignmentsFromText() {
      const assignments = [];
      const body = document.body.innerText;

      const patterns = [
        /(?:^|\n)\s*((?:HW|Homework|Assignment|Quiz|Exam|Project|Lab|Q)\s*#?\d*[^\n]{0,60})\s*\n?\s*(?:Submitted|Due)[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})/gim,
        /(?:^|\n)\s*((?:HW|Homework|Assignment|Quiz|Exam|Project|Lab|Q)\s*#?\d*[^\n]{0,60})/gim,
      ];

      const seen = new Set();
      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(body)) !== null) {
          const title = m[1].trim();
          if (title.length < 2 || seen.has(title)) continue;
          seen.add(title);

          const dateStr = m[2] || null;
          const dueDate = dateStr ? this.parseDate(dateStr) : null;

          const courseId = this.guessCourseFromUrl();
          assignments.push({
            id: this.stableAssignmentId(courseId, title),
            title,
            dueDate,
            dueDateRaw: dateStr,
            type: this.guessAssignmentType(title),
            courseId,
            url: '',
            submitted: /submitted/i.test(m[0]),
            points: this.extractPoints(m[0]),
          });
        }
      }

      return assignments;
    },

    scrapeGrades() {
      const grades = [];

      // Ultra grades page: look for score patterns in the page
      // The grades page shows items like "HW7  Submitted: 3/29/26  10 / 10"
      const allText = document.body.innerText;
      const lines = allText.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Match "10 / 10" or "4.59 / 15" score patterns
        const scoreMatch = line.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
        if (scoreMatch) {
          const score = parseFloat(scoreMatch[1]);
          const total = parseFloat(scoreMatch[2]);

          // Look backwards for the item name
          let name = line.replace(scoreMatch[0], '').trim();
          if (name.length < 2) {
            for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
              const prev = lines[j].trim();
              if (prev.length > 2 && !/submitted|due|date/i.test(prev)) {
                name = prev;
                break;
              }
            }
          }

          // Clean up the name
          name = name.replace(/submitted.*$/i, '').replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/, '').trim();
          if (!name) name = `Item ${grades.length + 1}`;

          grades.push({
            id: `grade_${grades.length}`,
            name: name.substring(0, 80),
            score,
            total,
            percentage: ((score / total) * 100).toFixed(1),
            courseId: this.guessCourseFromUrl(),
          });
        }

        // Also match letter grades like "C+" standalone
        if (/^[ABCDF][+-]?$/.test(line) && i > 0) {
          const prevName = lines[i - 1]?.trim() || lines[i - 2]?.trim();
          if (prevName && prevName.length > 2) {
            grades.push({
              id: `grade_letter_${grades.length}`,
              name: prevName.replace(/submitted.*$/i, '').trim().substring(0, 80),
              score: null,
              total: null,
              percentage: null,
              letterGrade: line,
              courseId: this.guessCourseFromUrl(),
            });
          }
        }
      }

      // Also try DOM-based scraping for classic Blackboard
      const gradeRows = document.querySelectorAll(
        '#grades_wrapper tr, .grade-item, [class*="grade-row"], [class*="graded-item"]'
      );
      gradeRows.forEach((row, idx) => {
        const text = row.textContent;
        const scoreMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
        if (scoreMatch) {
          const score = parseFloat(scoreMatch[1]);
          const total = parseFloat(scoreMatch[2]);
          const cells = row.querySelectorAll('td, span, div');
          const name = cells[0]?.textContent?.trim() || `Item ${grades.length + 1}`;

          grades.push({
            id: `grade_dom_${idx}`,
            name: name.substring(0, 80),
            score,
            total,
            percentage: ((score / total) * 100).toFixed(1),
            courseId: this.guessCourseFromUrl(),
          });
        }
      });

      return grades;
    },

    extractCourseId(href) {
      const patterns = [
        /course_id=(_\d+_\d+)/,
        /ultra\/courses\/([^/\s?]+)/,
        /courses\/([^/\s?]+)/,
        /courseId=([^&\s]+)/,
      ];
      for (const p of patterns) {
        const m = href.match(p);
        if (m) return m[1];
      }
      return null;
    },

    cleanCourseName(name) {
      return name
        .replace(/\s+/g, ' ')
        .replace(/^\d{4}-\w+-[A-Z]+-\d+-\w+-\d+\s*/i, '')
        .replace(/^\d{4}(?:Fall|Spring|Summer)\s*/i, '')
        .trim()
        .substring(0, 60);
    },

    extractTitle(el) {
      const titleEl = el.querySelector(
        'h3, h4, h5, [class*="title"], [class*="name"], [class*="label"], a'
      );
      return titleEl ? titleEl.textContent.trim().substring(0, 100) : null;
    },

    extractLink(el) {
      const a = el.tagName === 'A' ? el : el.querySelector('a');
      if (!a) return '';
      const href = a.getAttribute('href') || '';
      return href.startsWith('http') ? href : (href ? window.location.origin + href : '');
    },

    findDateInElement(el) {
      const text = el.textContent;
      const datePatterns = [
        /(?:due|deadline|by|closes?|submitted)[:\s]*([A-Za-z]+\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
        /(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/,
        /([A-Za-z]+\s+\d{1,2},?\s+\d{4})/,
        /(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/,
      ];

      for (const pattern of datePatterns) {
        const match = text.match(pattern);
        if (match) return match[1];
      }

      const dateEl = el.querySelector('[datetime], time, [class*="date"], [class*="due"]');
      if (dateEl) {
        return dateEl.getAttribute('datetime') || dateEl.textContent.trim();
      }

      return null;
    },

    parseDate(dateStr) {
      if (!dateStr) return null;
      const s = String(dateStr).trim();

      const hasTime =
        /\d{1,2}:\d{2}/.test(s) ||
        /\d{1,2}\s*(am|pm)\b/i.test(s) ||
        /T\d{2}:\d{2}/.test(s);

      let d = new Date(s);
      if (isNaN(d.getTime())) return null;

      if (!hasTime) {
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0, 0);
      }

      return d.toISOString();
    },

    guessAssignmentType(title) {
      const lower = title.toLowerCase();
      if (/exam|midterm|final/i.test(lower)) return 'exam';
      if (/quiz|^q\d/i.test(lower)) return 'quiz';
      if (/homework|hw|assignment|lab/i.test(lower)) return 'assignment';
      if (/project/i.test(lower)) return 'project';
      if (/discussion|forum|post/i.test(lower)) return 'discussion';
      if (/attendance/i.test(lower)) return 'attendance';
      if (/reading|chapter/i.test(lower)) return 'reading';
      return 'assignment';
    },

    extractPoints(text) {
      const m = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
      if (m) return parseFloat(m[2]);
      const pts = text.match(/(\d+)\s*(?:points?|pts)/i);
      return pts ? parseInt(pts[1]) : null;
    },

    guessCourseFromUrl() {
      const url = window.location.href;
      const patterns = [
        /course_id=(_\d+_\d+)/,
        /ultra\/courses\/([^/\s?]+)/,
        /courses\/([^/\s?]+)/,
      ];
      for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
      }
      return null;
    },

    showScanIndicator() {
      if (document.getElementById('bsa-scan-indicator')) return;
      const div = document.createElement('div');
      div.id = 'bsa-scan-indicator';
      div.className = 'bsa-scan-indicator';
      div.innerHTML = '<div class="bsa-scan-spinner"></div> Scanning...';
      document.body.appendChild(div);
    },

    hideScanIndicator() {
      const el = document.getElementById('bsa-scan-indicator');
      if (el) el.remove();
    },

    showToast(title, message) {
      const existing = document.querySelector('.bsa-toast');
      if (existing) existing.remove();

      const toast = document.createElement('div');
      toast.className = 'bsa-toast';
      toast.innerHTML = `
        <div class="bsa-toast-icon">🎓</div>
        <div class="bsa-toast-content">
          <div class="bsa-toast-title">${title}</div>
          <div class="bsa-toast-message">${message}</div>
        </div>
        <button class="bsa-toast-close">✕</button>
      `;
      document.body.appendChild(toast);

      toast.querySelector('.bsa-toast-close').addEventListener('click', () => {
        toast.classList.add('bsa-toast-hide');
        setTimeout(() => toast.remove(), 300);
      });

      setTimeout(() => {
        if (toast.parentNode) {
          toast.classList.add('bsa-toast-hide');
          setTimeout(() => toast.remove(), 300);
        }
      }, 5000);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => BSA.init());
  } else {
    BSA.init();
  }
})();
