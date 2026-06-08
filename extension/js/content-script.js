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
          this.scan().then(() => sendResponse({
            success: true,
            coursesCount: this.courses.length,
            assignmentsCount: this.assignments.length,
            gradesCount: this.grades.length,
          }));
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
        await this.waitForPageLoad();
        await this.waitForCourseSignals();

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
      for (const c of this.filterActiveCourses(fresh.courses)) {
        if (c?.id && !courseById.has(c.id)) courseById.set(c.id, c);
      }

      const courses = this.filterActiveCourses(Array.from(courseById.values()));

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

    /** Walk document + open shadow roots (Blackboard Ultra uses web components). */
    queryAllDeep(selector, root = document) {
      const results = [];
      const visit = (node) => {
        if (!node) return;
        if (node.querySelectorAll) {
          try {
            node.querySelectorAll(selector).forEach((el) => results.push(el));
          } catch (_) {}
        }
        const children = node.children || [];
        for (const child of children) visit(child);
        if (node.shadowRoot) visit(node.shadowRoot);
      };
      visit(root);
      return results;
    },

    waitForCourseSignals() {
      return new Promise((resolve) => {
        let attempts = 0;
        const tick = () => {
          attempts++;
          if (this.hasCourseSignals() || attempts >= 12) return resolve();
          setTimeout(tick, 400);
        };
        setTimeout(tick, 300);
      });
    },

    hasCourseSignals() {
      const probes = [
        '[data-course-id]',
        'a[href*="course"]',
        'bb-base-course-org-list',
        '[class*="course-card"]',
        '[class*="course-list"]',
        '[class*="course-org"]',
        '#content_listContainer',
      ];
      return probes.some((sel) => this.queryAllDeep(sel).length > 0);
    },

    isClosedCourse(course) {
      const name = (course?.name || course?.fullName || '').replace(/\s+/g, ' ').trim();
      if (!name) return true;
      if (/^closed$/i.test(name)) return true;
      if (/^unavailable$/i.test(name)) return true;
      if (/^archived$/i.test(name)) return true;
      // Status-only label with no course code (e.g. "Closed · Spring 2024")
      if (/^closed\b/i.test(name) && !/[A-Z]{2,5}\s*\d{3,4}/i.test(name)) return true;
      return false;
    },

    isClosedCourseElement(el) {
      if (!el) return false;
      if (el.getAttribute('aria-disabled') === 'true') return true;

      const label = (el.getAttribute('aria-label') || '').trim();
      if (label && /^closed\b/i.test(label) && !/[A-Z]{2,5}\s*\d{3,4}/i.test(label)) {
        return true;
      }

      const cls = (el.className || '').toString().toLowerCase();
      if (/\bclosed\b/.test(cls) || /\bunavailable\b/.test(cls) || /\barchived\b/.test(cls)) {
        const titleEl = el.querySelector('[class*="title"], [class*="name"], h2, h3, h4');
        const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title || this.isClosedCourse({ name: title })) return true;
      }

      const statusEl = el.querySelector(
        '[class*="status"], [class*="badge"], [class*="label"], [class*="state"]'
      );
      if (statusEl && /^closed$/i.test((statusEl.textContent || '').trim())) {
        const titleEl = el.querySelector('[class*="title"], [class*="name"], h2, h3, h4');
        const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title || /^closed$/i.test(title)) return true;
      }

      const compact = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^closed$/i.test(compact)) return true;

      return false;
    },

    filterActiveCourses(courses) {
      return (courses || []).filter((c) => !this.isClosedCourse(c));
    },

    addCourse(courses, seen, course, courseColors) {
      if (!course?.id || !course?.name) return;
      if (this.isClosedCourse(course)) return;

      const cleaned = this.cleanCourseName(course.name);
      if (this.isClosedCourse({ name: cleaned })) return;

      const key = `${course.id}|${cleaned.substring(0, 60).toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      courses.push({
        id: course.id,
        name: cleaned,
        fullName: course.fullName || course.name,
        url: course.url || window.location.href,
        color: courseColors[courses.length % courseColors.length],
        currentGrade: null,
      });
    },

    scrapeCoursesFromDataAttributes(courses, seen, courseColors) {
      const attrEls = this.queryAllDeep('[data-course-id]');
      attrEls.forEach((el) => {
        if (this.isClosedCourseElement(el)) return;

        const courseId = (el.getAttribute('data-course-id') || '').trim();
        if (!courseId) return;

        const link = el.closest('a[href]') || el.querySelector('a[href]');
        const href = link?.getAttribute('href') || '';
        const titleEl = el.querySelector(
          '[class*="title"], [class*="name"], [class*="course-title"], h2, h3, h4, span'
        );
        let name =
          (el.getAttribute('aria-label') || '').trim() ||
          (titleEl?.textContent || '').trim() ||
          (el.textContent || '').trim();

        name = name.replace(/\s+/g, ' ').substring(0, 120);
        if (!name || name.length < 3) return;

        this.addCourse(courses, seen, {
          id: courseId,
          name,
          fullName: name,
          url: href
            ? (href.startsWith('http') ? href : window.location.origin + href)
            : window.location.href,
        }, courseColors);
      });
    },

    scrapeCoursesFromLinks(courses, seen, courseColors) {
      const linkSelectors = [
        'a[href*="/ultra/course"]',
        'a[href*="/ultra/courses"]',
        'a[href*="ultra/courses"]',
        'a[href*="course_id"]',
        'a[href*="courseId"]',
        'a[href*="/courses/"]',
        '[class*="course-org-list"] a[href]',
        '[class*="course-list"] a[href]',
        '[class*="course-card"] a[href]',
        'a[data-analytics-id*="course"]',
        'bb-base-course-org-list a[href]',
        '#module\\:_4_1 a[href]',
        '.courseListing a[href]',
        '#div_4_1 a[href]',
        '.portletList-img a[href]',
        '#content_listContainer a[href]',
      ];

      for (const sel of linkSelectors) {
        try {
          this.queryAllDeep(sel).forEach((el) => {
            if (this.isClosedCourseElement(el)) return;

            const href = el.getAttribute('href') || '';
            if (!href || href === '#' || href.startsWith('javascript:')) return;

            const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
            if (!text || text.length < 3) return;

            const courseId = this.extractCourseId(href) || this.extractCourseIdFromText(text);
            if (!courseId) return;

            this.addCourse(courses, seen, {
              id: courseId,
              name: text.substring(0, 120),
              fullName: text,
              url: href.startsWith('http') ? href : window.location.origin + href,
            }, courseColors);
          });
        } catch (_) {}
      }
    },

    scrapeCoursesFromCards(courses, seen, courseColors) {
      const cardSelectors = [
        '[class*="course-card"]',
        '[class*="CourseCard"]',
        '[class*="course-tile"]',
        '[class*="courseTile"]',
        '[role="listitem"]',
        'li[class*="course"]',
      ];

      for (const sel of cardSelectors) {
        this.queryAllDeep(sel).forEach((card) => {
          if (this.isClosedCourseElement(card)) return;

          const dataId =
            card.getAttribute('data-course-id') ||
            card.closest('[data-course-id]')?.getAttribute('data-course-id');
          const link = card.querySelector('a[href]') || (card.tagName === 'A' ? card : null);
          const href = link?.getAttribute('href') || '';
          const titleEl = card.querySelector(
            '[class*="title"], [class*="name"], h2, h3, h4, strong'
          );
          let name =
            (card.getAttribute('aria-label') || '').trim() ||
            (titleEl?.textContent || '').trim() ||
            (link?.textContent || '').trim() ||
            (card.textContent || '').trim();

          name = name.replace(/\s+/g, ' ').substring(0, 120);
          if (!name || name.length < 5) return;

          const courseId =
            dataId ||
            (href ? this.extractCourseId(href) : null) ||
            this.extractCourseIdFromText(name);
          if (!courseId) return;

          this.addCourse(courses, seen, {
            id: courseId,
            name,
            fullName: name,
            url: href
              ? (href.startsWith('http') ? href : window.location.origin + href)
              : window.location.href,
          }, courseColors);
        });
      }
    },

    scrapeCourses() {
      const courses = [];
      const courseColors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
      const seen = new Set();

      this.scrapeCoursesFromDataAttributes(courses, seen, courseColors);
      this.scrapeCoursesFromLinks(courses, seen, courseColors);
      this.scrapeCoursesFromCards(courses, seen, courseColors);

      if (courses.length === 0) {
        courses.push(...this.scrapeCoursesFromText());
      }

      return this.filterActiveCourses(courses);
    },

    scrapeCoursesFromText() {
      const courses = [];
      const courseColors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
      const seen = new Set();

      const sources = [
        document.body.innerText,
        ...this.queryAllDeep('[class*="course"]').map((el) => el.innerText || ''),
      ].join('\n');

      const patterns = [
        /([A-Z]{2,5}\s*\d{4}(?:\.\d{3})?)\s*[-–:]\s*(.{3,80})/g,
        /([A-Z]{2,5}\s*\d{4}(?:\.\d{3})?)\s+([A-Za-z][^\n]{3,80})/g,
        /\d{4}-\w+-([A-Z]{2,5})-(\d{4})-\w+-\d+\s*\n?\s*([A-Z]{2,5}\s+\d{4}(?:\.\d{3})?\s*[-–]\s*.+)/g,
      ];

      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(sources)) !== null) {
          let name;
          if (m[3]) {
            name = m[3].trim();
          } else if (m[2] && !/^\d/.test(m[2])) {
            name = (m[1] + ' - ' + m[2]).trim();
          } else {
            name = (m[1] + ' - ' + m[2]).trim();
          }

          if (name.length < 5 || /^(Courses|Activity|Grades|Calendar)$/i.test(name)) continue;

          const shortName = name.substring(0, 80);
          const key = shortName.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          const idPart = (m[1] || '').replace(/\s+/g, '') || `text_${courses.length}`;
          courses.push({
            id: 'course_' + idPart,
            name: this.cleanCourseName(shortName),
            fullName: name,
            url: window.location.href,
            color: courseColors[courses.length % courseColors.length],
            currentGrade: null,
          });
        }
      }

      const headings = this.queryAllDeep('h1, h2, h3, h4, [class*="heading"], [class*="title"]');
      headings.forEach((el) => {
        const text = (el.textContent || '').trim();
        const match = text.match(/([A-Z]{2,5}\s*\d{4}(?:\.\d{3})?)\s*[-–:]\s*(.+)/);
        if (match) {
          const name = match[0].substring(0, 80);
          const key = name.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            courses.push({
              id: 'course_' + match[1].replace(/\s+/g, ''),
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
      if (!href) return null;
      const patterns = [
        /course_id=(_\d+_\d+)/i,
        /course_id%3D(_\d+_\d+)/i,
        /ultra\/course\/(_\d+_\d+)/i,
        /ultra\/courses\/([^/\s?#]+)/i,
        /\/courses\/([^/\s?#]+)/i,
        /courseId=([^&\s#]+)/i,
        /contextId=(_\d+_\d+)/i,
      ];
      for (const p of patterns) {
        const m = href.match(p);
        if (m) return decodeURIComponent(m[1]);
      }
      return null;
    },

    extractCourseIdFromText(text) {
      const bbId = text.match(/(_\d+_\d+)/);
      if (bbId) return bbId[1];
      const code = text.match(/([A-Z]{2,5}\s*\d{4}(?:\.\d{3})?)/);
      if (code) return 'course_' + code[1].replace(/\s+/g, '');
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
