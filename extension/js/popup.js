/**
 * Blackboard Student Assistant - Popup Controller
 *
 * Manages the popup UI, binds events, renders data from storage,
 * and communicates with the background service worker.
 */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /** @returns {number|null} Percent 0–100 from "85", "85%", or "72/80" */
  function parseGradeCellInput(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
    if (frac) {
      const num = parseFloat(frac[1]);
      const den = parseFloat(frac[2]);
      if (!isFinite(num) || !isFinite(den) || den === 0) return null;
      return (num / den) * 100;
    }
    const n = parseFloat(s.replace(/%/g, ''));
    return isNaN(n) || !isFinite(n) ? null : n;
  }

  let appState = {
    courses: [],
    assignments: [],
    grades: [],
    syllabusData: {},
    courseGoals: {},
    settings: {},
    lastScan: null,
    studyPlanProgress: {},
  };

  async function init() {
    await loadData();
    render();
    bindEvents();
  }

  async function loadData() {
    const data = await chrome.storage.local.get([
      'courses', 'assignments', 'grades', 'syllabusData',
      'courseGoals', 'settings', 'lastScan', 'studyPlanProgress'
    ]);
    Object.assign(appState, data);
    if (!appState.settings) appState.settings = {};
    if (appState.assignments?.length) {
      appState.assignments = dedupeAssignmentsForState(appState.assignments);
    }
    mergeManualExamsIntoSyllabusData();
  }

  function dedupeAssignmentsForState(assignments) {
    const keyFn = (a) =>
      `${a.courseId || ''}|${(a.title || '').trim().toLowerCase().substring(0, 120)}`;
    const map = new Map();
    for (const a of assignments) {
      const k = keyFn(a);
      const cur = map.get(k);
      if (!cur) {
        map.set(k, a);
        continue;
      }
      if (a.userEdited && !cur.userEdited) {
        map.set(k, { ...a, id: String(cur.id || '').startsWith('asg_') ? cur.id : a.id });
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
      const ov = prefer.dueDateOverride || other.dueDateOverride;
      if (ov) merged.dueDateOverride = ov;
      map.set(k, merged);
    }
    return Array.from(map.values());
  }

  function effectiveDueDate(a) {
    if (!a) return null;
    if (a.dueDateOverride) return a.dueDateOverride;
    return a.dueDate;
  }

  /** Merge manually entered exams (stored as assignments) into syllabusData for the syllabus summary view. */
  function mergeManualExamsIntoSyllabusData() {
    for (const c of appState.courses || []) {
      const cid = c.id;
      const base = { ...(appState.syllabusData[cid] || {}) };
      const stored = base.exams || [];
      const fromSyllabus = stored.filter(
        (e) => e && !String(e.syncKey || '').startsWith('manual_exam_')
      );
      const manualAssignments = appState.assignments.filter(
        (a) =>
          a.courseId === cid &&
          a.type === 'exam' &&
          (a.source === 'manualExam' || a.examManualId)
      );
      const manualExams = manualAssignments.map((a) => {
        const iso = effectiveDueDate(a);
        return {
          type: a.title || 'Exam',
          dateRaw: a.dateRaw || (iso ? formatDateTime(new Date(iso)) : ''),
          date: iso,
          context: 'Entered manually',
          syncKey: a.examManualId || `manual_exam_${a.id}`,
          assignmentId: a.id,
        };
      });
      base.exams = [...fromSyllabus, ...manualExams];
      appState.syllabusData[cid] = base;
    }
  }

  function calendarEventDedupeKey(ev) {
    const t = (ev.title || '').replace(/^📝\s*/, '').trim().toLowerCase();
    const d = ev.startDate ? new Date(ev.startDate).getTime() : 0;
    return `${(ev.course || '').toLowerCase()}|${t}|${d}`;
  }

  function render() {
    const hasData = appState.courses.length > 0 ||
                    appState.assignments.length > 0 ||
                    appState.grades.length > 0;
    $('#view-onboarding').classList.toggle('hidden', hasData);
    $('#view-dashboard').classList.toggle('hidden', !hasData);
    updateStatusBar();
    updateTargetGradeBanner();

    if (hasData) {
      renderDeadlines();
      renderCourses();
    }
  }

  function updateTargetGradeBanner() {
    const banner = $('#target-grade-banner');
    if (!banner) return;
    const hasData = appState.courses.length > 0 ||
      appState.assignments.length > 0 ||
      appState.grades.length > 0;
    const dismissed = appState.settings?.targetGradeBannerDismissed;
    const show = hasData && !dismissed;
    banner.classList.toggle('hidden', !show);
    const inp = $('#banner-target-grade');
    const def = appState.settings?.defaultTargetGrade;
    if (inp && def != null && !isNaN(def) && inp.value === '') inp.value = String(def);
  }

  function updateStatusBar() {
    const dot = $('#status-dot');
    const text = $('#status-text');

    if (appState.lastScan) {
      const ago = getTimeAgo(new Date(appState.lastScan));
      dot.className = 'status-dot';
      text.textContent = `Last scanned ${ago}`;
    } else {
      dot.className = 'status-dot disconnected';
      text.textContent = 'Not connected to Blackboard';
    }
  }

  function renderDeadlines() {
    const container = $('#deadlines-list');
    const now = new Date();

    const upcoming = appState.assignments
      .filter(a => effectiveDueDate(a) && !a.submitted && new Date(effectiveDueDate(a)) > now)
      .sort((a, b) => new Date(effectiveDueDate(a)) - new Date(effectiveDueDate(b)))
      .slice(0, 5);

    if (upcoming.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎉</div>
          <p>No upcoming deadlines!</p>
        </div>`;
      return;
    }

    container.innerHTML = upcoming.map(a => {
      const due = new Date(effectiveDueDate(a));
      const hoursUntil = (due - now) / (1000 * 60 * 60);
      const urgency = hoursUntil < 24 ? 'urgent' : (hoursUntil < 72 ? 'soon' : 'normal');
      const course = appState.courses.find(c => c.id === a.courseId);

      return `
        <div class="card deadline-card" data-assignment-id="${a.id}">
          <div class="deadline-urgency ${urgency}"></div>
          <div class="deadline-info">
            <div class="deadline-course">${course ? course.name : 'Course'}</div>
            <div class="deadline-title">${escapeHtml(a.title)}</div>
            <div class="deadline-time ${urgency}">
              ${formatDeadline(due, hoursUntil)}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderCourses() {
    const container = $('#courses-list');

    if (appState.courses.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No courses found</p></div>';
      return;
    }

    container.innerHTML = appState.courses.map(c => {
      const grade = c.currentGrade;
      return `
        <div class="course-item" data-course-id="${c.id}">
          <div class="course-color" style="background: ${c.color}"></div>
          <div class="course-name">${escapeHtml(c.name)}</div>
          ${grade ? `<div class="course-grade">${grade}%</div>` : ''}
        </div>`;
    }).join('');
  }

  function bindEvents() {
    // Header buttons
    $('#btn-refresh').addEventListener('click', handleRefresh);
    $('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('#btn-open-blackboard').addEventListener('click', handleOpenBlackboard);

    // Quick actions
    $('#btn-grades').addEventListener('click', () => openPanel('grades'));
    $('#btn-calendar').addEventListener('click', () => openPanel('calendar'));
    $('#btn-plan').addEventListener('click', () => openPanel('plan'));
    $('#btn-syllabus').addEventListener('click', () => openPanel('syllabus'));

    // Panel close buttons
    $$('.panel-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const panelName = btn.dataset.close;
        closePanel(panelName);
      });
    });

    // Overlays close on click
    $$('.panel-overlay').forEach(overlay => {
      overlay.addEventListener('click', () => {
        const id = overlay.id.replace('overlay-', '');
        closePanel(id);
      });
    });

    // Grade calculator
    $('#grade-course-select').addEventListener('change', handleCourseSelectForGrades);
    $('#btn-fill-grades-bb').addEventListener('click', handleFillGradesFromBlackboard);
    $('#btn-save-target-grade')?.addEventListener('click', saveTargetGradeFromBanner);
    $('#btn-dismiss-target-banner')?.addEventListener('click', dismissTargetGradeBanner);
    $('#btn-calc-needed').addEventListener('click', handleCalcNeeded);

    // Calendar
    $$('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', handleCalendarTab);
    });
    $('#btn-sync-selected').addEventListener('click', handleSyncCalendar);

    // Study plan
    $('#btn-generate-plan').addEventListener('click', handleGeneratePlan);

    // Syllabus
    $('#upload-zone').addEventListener('click', () => $('#syllabus-file').click());
    $('#syllabus-file').addEventListener('change', handleSyllabusFile);
    const imgIn = $('#syllabus-image-file');
    if (imgIn) imgIn.addEventListener('change', handleSyllabusImagePick);
    $('#btn-syllabus-pick-image')?.addEventListener('click', () => imgIn?.click());
    $('#btn-syllabus-paste-image')?.addEventListener('click', () => {
      alert('Click inside the syllabus panel, then press Ctrl+V (or Cmd+V) to paste a screenshot.');
    });
    $('#btn-syllabus-clear-image')?.addEventListener('click', clearSyllabusGradingImage);
    $('#panel-syllabus')?.addEventListener('paste', handleSyllabusPanelPaste);
    $('#btn-parse-syllabus').addEventListener('click', handleParseSyllabus);
    $('#syllabus-course-select').addEventListener('change', () => {
      updateSyllabusImagePreviewForCourse($('#syllabus-course-select').value);
    });

    // Deadlines: manual edit + rescan
    $('#btn-manage-deadlines').addEventListener('click', () => {
      openPanel('manage-deadlines');
      populateManageDeadlinesPanel();
    });
    $('#btn-rescan-blackboard').addEventListener('click', handleRescanFromManagePanel);
    $('#btn-add-manual-deadline').addEventListener('click', handleAddManualDeadline);
    $('#manual-dl-type')?.addEventListener('change', () => {
      const t = $('#manual-dl-type')?.value;
      const ph = $('#manual-dl-title');
      if (ph && t === 'exam') ph.placeholder = 'e.g. Exam 2 — Mar 15';
      else if (ph) ph.placeholder = 'e.g. Problem Set 5';
    });

    // Course detail clicks
    document.addEventListener('click', (e) => {
      const courseItem = e.target.closest('.course-item');
      if (courseItem) {
        showCourseDetail(courseItem.dataset.courseId);
      }
    });
  }

  // === Panel Management ===

  function openPanel(name) {
    $(`#overlay-${name}`).classList.add('active');
    $(`#panel-${name}`).classList.add('active');

    if (name === 'grades') populateGradePanel();
    if (name === 'calendar') populateCalendarPanel();
    if (name === 'plan') populatePlanPanel();
    if (name === 'syllabus') populateSyllabusPanel();
    if (name === 'manage-deadlines') populateManageDeadlinesPanel();
  }

  function closePanel(name) {
    $(`#overlay-${name}`).classList.remove('active');
    $(`#panel-${name}`).classList.remove('active');
  }

  // === Grade Calculator ===

  function populateGradePanel() {
    const select = $('#grade-course-select');
    select.innerHTML = '<option value="">Select Course</option>';
    appState.courses.forEach(c => {
      select.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    const tg = $('#target-grade');
    const def = appState.settings?.defaultTargetGrade;
    if (tg && def != null && !isNaN(def) && tg.value === '') {
      tg.value = String(def);
    }
  }

  async function saveTargetGradeFromBanner() {
    const raw = $('#banner-target-grade')?.value;
    const v = parseFloat(raw);
    if (isNaN(v) || v < 0 || v > 100) {
      alert('Enter a target percentage between 0 and 100.');
      return;
    }
    const settings = { ...(appState.settings || {}), defaultTargetGrade: v, targetGradeBannerDismissed: true };
    appState.settings = settings;
    await chrome.storage.local.set({ settings });
    const tg = $('#target-grade');
    if (tg) tg.value = String(v);
    $('#target-grade-banner')?.classList.add('hidden');
  }

  async function dismissTargetGradeBanner() {
    const settings = { ...(appState.settings || {}), targetGradeBannerDismissed: true };
    appState.settings = settings;
    await chrome.storage.local.set({ settings });
    $('#target-grade-banner')?.classList.add('hidden');
  }

  function handleCourseSelectForGrades() {
    const courseId = $('#grade-course-select').value;
    if (!courseId) return;

    const container = $('#grade-categories');
    const syllabus = appState.syllabusData[courseId];

    let categories = [];
    if (syllabus?.gradingBreakdown?.categories?.length > 0) {
      categories = syllabus.gradingBreakdown.categories.map((c) => ({
        category: c.category,
        weight: c.weight,
      }));
    } else {
      const usePlaceholder = window.confirm(
        'No grading breakdown was found for this course. Parse your syllabus on the Syllabus screen first.\n\n' +
          'Use example categories (assignments, exams, participation) as placeholders? Choose Cancel to leave the calculator empty until you parse a syllabus.'
      );
      if (usePlaceholder) {
        categories = [
          { category: 'Assignments', weight: 30 },
          { category: 'Midterm', weight: 25 },
          { category: 'Final Exam', weight: 30 },
          { category: 'Participation', weight: 15 },
        ];
      }
    }

    renderGradeCategoryTable(container, categories, courseId);
  }

  function renderGradeCategoryTable(container, categories, courseId) {
    if (!categories || categories.length === 0) {
      container.innerHTML =
        '<p style="font-size: 13px; color: var(--text-muted); margin-top: 8px;">No categories yet. Open <strong>Upload Syllabus</strong>, paste your syllabus, and click Parse to load weights (including each exam). Then return here and select this course again.</p>';
      container.dataset.categories = '[]';
      container.dataset.courseId = courseId || '';
      $('#grade-result').classList.add('hidden');
      document.getElementById('grade-weight-note')?.remove();
      return;
    }

    const displayValue = (cat) => {
      if (cat.score == null || cat.score === '') return '';
      if (typeof cat.score === 'number' && !isNaN(cat.score)) return String(cat.score);
      return String(cat.score);
    };

    container.innerHTML = `
      <p style="font-size: 11px; color: var(--text-muted); margin-top: 10px;">Enter each grade as a percent (0–100) or as <code style="font-size: 10px;">earned/total</code> (e.g. 72/80). Course grade uses your full syllabus weights (should total ~100%).</p>
      <table class="grade-table">
        <thead>
          <tr>
            <th>Category</th>
            <th>Weight</th>
            <th>Grade</th>
            <th>Points (weight)</th>
            <th>% of course</th>
          </tr>
        </thead>
        <tbody>
          ${categories.map((cat, i) => `
            <tr>
              <td>${escapeHtml(cat.category)}</td>
              <td>${cat.weight}%</td>
              <td><input type="text" class="grade-input" inputmode="decimal" data-index="${i}" placeholder="e.g. 85 or 72/80" value="${escapeHtml(displayValue(cat))}"></td>
              <td class="grade-points-earned" data-index="${i}">—</td>
              <td class="grade-pct-course" data-index="${i}">—</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;

    container.dataset.categories = JSON.stringify(categories.map(({ category, weight }) => ({ category, weight })));
    container.dataset.courseId = courseId || '';
    $('#grade-result').classList.remove('hidden');

    container.querySelectorAll('.grade-input').forEach((input) => {
      input.addEventListener('input', () => {
        const cats = JSON.parse(container.dataset.categories);
        recalculateGrade(cats);
      });
    });

    const cats = JSON.parse(container.dataset.categories);
    recalculateGrade(cats);
  }

  function formatGradeLinesExact(courseGrades) {
    return (courseGrades || [])
      .filter((g) => g && g.name && g.score != null && g.total != null && Number(g.total) !== 0)
      .map((g) => `${String(g.name).trim()} - ${g.score}/${g.total}`)
      .join(' ');
  }

  async function handleFillGradesFromBlackboard() {
    const courseId = $('#grade-course-select').value;
    const container = $('#grade-categories');
    if (!courseId || !container.dataset.categories) return;

    const categories = JSON.parse(container.dataset.categories);
    const courseGrades = appState.grades.filter((g) => g.courseId === courseId);

    if (courseGrades.length === 0) {
      alert('No grades found for this course. Open the course Grades page on Blackboard and tap refresh, then try again.');
      return;
    }

    const gradeLines = formatGradeLinesExact(courseGrades);
    if (!gradeLines) {
      alert('No scored items found (need score/total pairs). Open Grades and scan again.');
      return;
    }

    const { settings = {} } = await chrome.storage.local.get('settings');
    const useAi = !!(settings.geminiApiKey || '').trim();

    if (!useAi) {
      chrome.runtime.sendMessage(
        { action: 'suggestCategoryScores', categories, grades: courseGrades },
        (suggested) => {
          if (chrome.runtime.lastError || !suggested) {
            alert('Could not match grades. Add a Gemini API key in Settings for AI matching, or enter scores manually.');
            return;
          }
          const merged = categories.map((c, i) => ({
            ...c,
            score: suggested[i]?.score != null ? suggested[i].score : null,
          }));
          renderGradeCategoryTable(container, merged, courseId);
        }
      );
      return;
    }

    let screenCaptureDataUrl = null;
    const wantCapture = $('#opt-ai-screen-capture')?.checked !== false;
    if (wantCapture) {
      try {
        screenCaptureDataUrl = await new Promise((resolve, reject) => {
          chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 85 }, (dataUrl) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(dataUrl);
          });
        });
      } catch (e) {
        alert(
          `Could not capture the visible tab: ${e.message || e}\n\n` +
          'Open your course Grades page in this window (active tab), or uncheck screen capture and try again.'
        );
        return;
      }
    }

    chrome.runtime.sendMessage(
      {
        action: 'inferGradesWithGemini',
        categories,
        gradeLines,
        screenCaptureDataUrl,
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          alert(chrome.runtime.lastError.message || 'Extension busy.');
          return;
        }
        if (resp?.success && resp.suggested) {
          const merged = categories.map((c, i) => ({
            ...c,
            score: resp.suggested[i]?.score != null ? resp.suggested[i].score : null,
          }));
          renderGradeCategoryTable(container, merged, courseId);
          return;
        }
        chrome.runtime.sendMessage(
          { action: 'suggestCategoryScores', categories, grades: courseGrades },
          (suggested) => {
            if (chrome.runtime.lastError || !suggested) {
              alert(resp?.error || 'AI grade fill failed. Enter scores manually.');
              return;
            }
            const merged = categories.map((c, i) => ({
              ...c,
              score: suggested[i]?.score != null ? suggested[i].score : null,
            }));
            renderGradeCategoryTable(container, merged, courseId);
          }
        );
      }
    );
  }

  function recalculateGrade(categories) {
    const container = $('#grade-categories');
    const inputs = container ? container.querySelectorAll('.grade-input') : [];
    const cats = categories.map((cat, i) => {
      const raw = inputs[i] ? inputs[i].value : '';
      const score = raw !== '' ? parseGradeCellInput(raw) : null;
      return {
        ...cat,
        score: score !== null && score !== undefined && !isNaN(score) ? Math.round(score * 10000) / 10000 : null,
      };
    });

    chrome.runtime.sendMessage({ action: 'calculateGrades', categories: cats }, (result) => {
      if (!result) return;
      $('#calculated-grade').textContent = `${result.percentage}%`;
      $('#letter-grade').textContent = `Letter Grade: ${result.letter}`;

      const tw = result.syllabusTotalWeight != null ? result.syllabusTotalWeight : result.totalWeight;
      let weightNote = $('#grade-weight-note');
      if (!weightNote && container?.parentElement) {
        weightNote = document.createElement('div');
        weightNote.id = 'grade-weight-note';
        weightNote.style.fontSize = '11px';
        weightNote.style.marginTop = '8px';
        container.parentElement.insertBefore(weightNote, container.nextSibling);
      }
      if (weightNote) {
        const ok = tw >= 90 && tw <= 110;
        weightNote.style.color = ok ? 'var(--text-muted)' : 'var(--warning)';
        weightNote.textContent = `Syllabus weights total: ${Math.round(tw * 100) / 100}%${ok ? ' (≈100% — scale is correct)' : ' — should add to ~100% for a correct course grade.'}`;
      }

      const breakdown = result.breakdown || [];
      breakdown.forEach((row, i) => {
        const pt = container?.querySelector(`.grade-points-earned[data-index="${i}"]`);
        const pc = container?.querySelector(`.grade-pct-course[data-index="${i}"]`);
        if (pt) {
          pt.textContent =
            row.contribution != null && row.contribution !== undefined
              ? row.contribution.toFixed(2)
              : '—';
        }
        if (pc) {
          pc.textContent =
            row.contributionPercentOfCourse != null && row.contributionPercentOfCourse !== undefined
              ? `${row.contributionPercentOfCourse.toFixed(2)}%`
              : '—';
        }
      });
    });
  }

  function handleCalcNeeded() {
    const courseId = $('#grade-course-select').value;
    if (!courseId) return;

    const target = parseFloat($('#target-grade').value);
    if (isNaN(target)) return;

    const categoriesRaw = $('#grade-categories').dataset.categories;
    if (!categoriesRaw) return;

    const categories = JSON.parse(categoriesRaw);
    const inputs = $('#grade-categories')?.querySelectorAll('.grade-input') || [];
    const cats = categories.map((cat, i) => {
      const raw = inputs[i]?.value ?? '';
      const score = raw !== '' ? parseGradeCellInput(raw) : null;
      return {
        ...cat,
        score: score !== null && !isNaN(score) ? score : null,
      };
    });

    chrome.runtime.sendMessage(
      { action: 'calculateNeeded', categories: cats, targetGrade: target },
      (result) => {
        const el = $('#needed-grade-result');
        el.classList.remove('hidden');
        el.textContent = result?.message || 'Could not calculate.';
      }
    );
  }

  // === Calendar ===

  function populateCalendarPanel() {
    renderCalendarEvents('cal-deadlines');
  }

  function handleCalendarTab(e) {
    $$('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    renderCalendarEvents(e.target.dataset.tab);
  }

  function renderCalendarEvents(tab) {
    const container = $('#calendar-events-list');
    const now = new Date();

    if (tab === 'cal-deadlines') {
      mergeManualExamsIntoSyllabusData();
      const deadlines = appState.assignments
        .filter((a) => effectiveDueDate(a) && !a.submitted)
        .sort((a, b) => new Date(effectiveDueDate(a)) - new Date(effectiveDueDate(b)));

      if (deadlines.length === 0) {
        container.innerHTML =
          '<div class="empty-state"><p>No deadlines yet. Scan Blackboard or add items under <strong>Update schedule</strong>.</p></div>';
        return;
      }

      container.innerHTML =
        `<p class="cal-panel-hint" style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">` +
        `Adjust the date and time below, then <strong>Save due date</strong> before syncing. Past dates are included if you still want them on your calendar.</p>` +
        deadlines
          .map((a, i) => {
            const course = appState.courses.find((c) => c.id === a.courseId);
            const due = effectiveDueDate(a);
            const localVal = isoToDatetimeLocalValue(due);
            return `
          <div class="event-preview cal-deadline-row" data-assignment-id="${escapeHtml(a.id)}">
            <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer;">
              <input type="checkbox" checked class="cal-event-check" data-index="${i}" data-type="deadline"
                     style="margin-top: 3px;">
              <div style="flex: 1; min-width: 0;">
                <div class="event-title">${escapeHtml(a.title)}</div>
                <div class="event-date">${formatDateTime(new Date(due))}${course ? ` · ${escapeHtml(course.name)}` : ''}</div>
                <span class="event-type ${a.type}">${escapeHtml(a.type || '')}</span>
                <div class="cal-due-edit" style="margin-top: 8px;">
                  <span style="font-size: 11px; color: var(--text-muted);">Date &amp; time for Google Calendar</span>
                  <input type="datetime-local" class="cal-due-input" data-aid="${escapeHtml(a.id)}" value="${localVal}"
                    style="width: 100%; margin-top: 4px; padding: 6px; background: var(--bg-input); border: 1px solid var(--border); color: var(--text); border-radius: 8px; font-size: 12px;">
                  <button type="button" class="btn-sm-inline cal-save-due" data-aid="${escapeHtml(a.id)}" style="margin-top: 6px;">Save due date</button>
                </div>
              </div>
            </label>
          </div>`;
          })
          .join('');

      container.querySelectorAll('.cal-save-due').forEach((btn) => {
        btn.addEventListener('click', () => saveCalendarDueOverride(btn.dataset.aid));
      });
    } else if (tab === 'cal-exams') {
      mergeManualExamsIntoSyllabusData();
      const allExams = [];
      for (const [courseId, data] of Object.entries(appState.syllabusData)) {
        if (data.exams) {
          const course = appState.courses.find((c) => c.id === courseId);
          data.exams.forEach((exam, ei) => {
            const hasDate = !!(exam.date && !isNaN(new Date(exam.date).getTime()));
            allExams.push({
              ...exam,
              courseName: course?.name || 'Course',
              courseId,
              _examIndex: ei,
            });
          });
        }
      }

      if (allExams.length === 0) {
        container.innerHTML =
          '<div class="empty-state"><p>No exams listed yet. Parse a syllabus or add exam dates under <strong>Update schedule</strong> → Add exam.</p></div>';
        return;
      }

      container.innerHTML =
        `<p class="cal-panel-hint" style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">` +
        `Set or fix the exam time below, then <strong>Save</strong>. Only exams with a saved date are synced.</p>` +
        allExams
          .map((exam, i) => {
            const iso = exam.date && !isNaN(new Date(exam.date).getTime()) ? exam.date : '';
            const localVal = isoToDatetimeLocalValue(iso);
            const aid = exam.assignmentId ? escapeHtml(exam.assignmentId) : '';
            const eidx = exam.assignmentId ? '' : String(exam._examIndex);
            return `
        <div class="event-preview cal-exam-row">
          <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer;">
            <input type="checkbox" ${iso ? 'checked' : ''} class="cal-event-check" data-index="${i}" data-type="exam"
                   style="margin-top: 3px;">
            <div style="flex: 1; min-width: 0;">
              <div class="event-title">${escapeHtml(exam.type)} — ${escapeHtml(exam.courseName)}</div>
              <div class="event-date">${escapeHtml(exam.dateRaw || (iso ? formatDateTime(new Date(iso)) : 'No date — set below'))}</div>
              <span class="event-type exam">Exam</span>
              <div class="cal-due-edit" style="margin-top: 8px;">
                <span style="font-size: 11px; color: var(--text-muted);">Exam date &amp; time</span>
                <input type="datetime-local" class="cal-exam-datetime" value="${localVal}"
                  style="width: 100%; margin-top: 4px; padding: 6px; background: var(--bg-input); border: 1px solid var(--border); color: var(--text); border-radius: 8px; font-size: 12px;">
                <button type="button" class="btn-sm-inline cal-save-exam" data-assignment-id="${aid}" data-syllabus-exam-index="${eidx}" data-course-id="${escapeHtml(exam.courseId)}" style="margin-top: 6px;">Save</button>
              </div>
            </div>
          </label>
        </div>`;
          })
          .join('');

      container.querySelectorAll('.cal-save-exam').forEach((btn) => {
        btn.addEventListener('click', () => saveExamDateFromCalendarPanel(btn));
      });
    } else {
      container.innerHTML = '<div class="empty-state"><p>Class schedule sync coming from syllabus data. Upload a syllabus to get started.</p></div>';
    }
  }

  async function saveCalendarDueOverride(assignmentId) {
    const input = [...document.querySelectorAll('input.cal-due-input')].find(
      (el) => el.dataset.aid === assignmentId
    );
    const iso = datetimeLocalToIso(input?.value);
    if (!iso) {
      alert('Pick a valid date and time.');
      return;
    }
    const idx = appState.assignments.findIndex((a) => a.id === assignmentId);
    if (idx === -1) return;
    appState.assignments[idx] = {
      ...appState.assignments[idx],
      dueDateOverride: iso,
      userEdited: true,
    };
    await chrome.storage.local.set({ assignments: appState.assignments });
    const st = $('#calendar-status');
    st.classList.remove('hidden');
    st.style.color = 'var(--success)';
    st.textContent = 'Due date saved for calendar.';
  }

  async function saveExamDateFromCalendarPanel(btn) {
    const row = btn.closest('.cal-exam-row');
    const input = row?.querySelector('input.cal-exam-datetime');
    const iso = datetimeLocalToIso(input?.value);
    if (!iso) {
      alert('Pick a valid date and time for this exam.');
      return;
    }
    const courseId = btn.dataset.courseId;
    const assignmentId = btn.dataset.assignmentId;
    const syllabusIdx = btn.dataset.syllabusExamIndex;

    if (assignmentId) {
      const idx = appState.assignments.findIndex((a) => a.id === assignmentId);
      if (idx === -1) return;
      appState.assignments[idx] = {
        ...appState.assignments[idx],
        dueDate: iso,
        dueDateOverride: null,
        dateRaw: formatDateTime(new Date(iso)),
        userEdited: true,
      };
      await chrome.storage.local.set({ assignments: appState.assignments });
    } else if (syllabusIdx !== '' && courseId) {
      const ei = parseInt(syllabusIdx, 10);
      const data = appState.syllabusData[courseId] || {};
      const exams = [...(data.exams || [])];
      if (!exams[ei]) {
        alert('Could not find this exam entry. Try parsing the syllabus again.');
        return;
      }
      exams[ei] = {
        ...exams[ei],
        date: iso,
        dateRaw: formatDateTime(new Date(iso)),
      };
      appState.syllabusData[courseId] = { ...data, exams };
      await chrome.storage.local.set({ syllabusData: appState.syllabusData });

      const examAsgId = `exam_${courseId}_syllabus_${ei}`;
      const existingIdx = appState.assignments.findIndex((a) => a.id === examAsgId);
      const examRow = {
        id: examAsgId,
        title: exams[ei].type || 'Exam',
        dueDate: iso,
        type: 'exam',
        courseId,
        submitted: false,
        points: null,
        source: 'syllabus',
        userEdited: true,
      };
      if (existingIdx >= 0) {
        appState.assignments[existingIdx] = { ...appState.assignments[existingIdx], ...examRow };
      } else {
        appState.assignments.push(examRow);
      }
      await chrome.storage.local.set({ assignments: appState.assignments });
    }

    mergeManualExamsIntoSyllabusData();
    const st = $('#calendar-status');
    st.classList.remove('hidden');
    st.style.color = 'var(--success)';
    st.textContent = 'Exam date saved.';
    renderCalendarEvents('cal-exams');
  }

  async function handleSyncCalendar() {
    const checked = $$('.cal-event-check:checked');
    if (checked.length === 0) return;

    const statusEl = $('#calendar-status');
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'Connecting to Google Calendar...';
    statusEl.style.color = 'var(--text-muted)';

    const events = [];
    const seenKeys = new Set();
    mergeManualExamsIntoSyllabusData();

    const deadlines = appState.assignments
      .filter((a) => effectiveDueDate(a) && !a.submitted)
      .sort((a, b) => new Date(effectiveDueDate(a)) - new Date(effectiveDueDate(b)));

    checked.forEach((cb) => {
      const type = cb.dataset.type;
      const idx = parseInt(cb.dataset.index, 10);

      if (type === 'deadline') {
        if (deadlines[idx]) {
          const a = deadlines[idx];
          const course = appState.courses.find((c) => c.id === a.courseId);
          const startDate = effectiveDueDate(a);
          const ev = {
            title: `📝 ${a.title}`,
            course: course?.name || '',
            type: a.type,
            startDate,
            allDay: false,
            points: a.points,
            url: a.url,
            assignmentId: a.id,
          };
          const k = calendarEventDedupeKey(ev);
          if (seenKeys.has(k)) return;
          seenKeys.add(k);
          events.push(ev);
        }
      } else if (type === 'exam') {
        const allExams = [];
        for (const [courseId, data] of Object.entries(appState.syllabusData)) {
          if (data.exams) {
            const course = appState.courses.find((c) => c.id === courseId);
            data.exams.forEach((exam, ei) => {
              allExams.push({ ...exam, courseName: course?.name || 'Course', courseId, _ei: ei });
            });
          }
        }
        const exam = allExams[idx];
        if (!exam || !exam.date || isNaN(new Date(exam.date).getTime())) return;
        const startDate = exam.date;
        const ev = {
          title: `📘 ${exam.type || 'Exam'}`,
          course: exam.courseName || '',
          type: 'exam',
          startDate,
          allDay: false,
          syncKey: exam.assignmentId
            ? `manual_exam_${exam.assignmentId}`
            : `syllabus_exam_${exam.courseId}_${exam._ei}`,
        };
        const k = `${ev.syncKey}|${new Date(startDate).getTime()}`;
        if (seenKeys.has(k)) return;
        seenKeys.add(k);
        events.push(ev);
      }
    });

    if (events.length === 0) {
      statusEl.style.color = 'var(--warning)';
      statusEl.textContent = 'No events to sync. Save a date for each item you selected.';
      return;
    }

    chrome.runtime.sendMessage(
      { action: 'syncCalendarEvents', events },
      (response) => {
        if (response?.success) {
          const r = response.results;
          statusEl.style.color = 'var(--success)';
          statusEl.textContent = `✅ Synced ${r.success.length} events!${r.failed.length > 0 ? ` (${r.failed.length} failed)` : ''}`;
        } else {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = `❌ ${response?.error || 'Failed to sync. Check calendar connection in settings.'}`;
        }
      }
    );
  }

  // === Study Plan ===

  function populatePlanPanel() {
    const container = $('#course-goals');
    container.innerHTML = appState.courses.map(c => {
      const current = appState.courseGoals[c.id] || '';
      return `
        <div class="goal-input-group">
          <span style="font-size: 13px; min-width: 100px; color: var(--text);">${escapeHtml(c.name)}</span>
          <select class="goal-select" data-course-id="${c.id}">
            <option value="" ${!current ? 'selected' : ''}>No goal</option>
            <option value="90" ${current == 90 ? 'selected' : ''}>A (90%+)</option>
            <option value="80" ${current == 80 ? 'selected' : ''}>B (80%+)</option>
            <option value="70" ${current == 70 ? 'selected' : ''}>C (70%+)</option>
            <option value="60" ${current == 60 ? 'selected' : ''}>D (60%+)</option>
          </select>
        </div>`;
    }).join('');
  }

  async function handleGeneratePlan() {
    const goals = {};
    $$('.goal-select').forEach(sel => {
      if (sel.value) goals[sel.dataset.courseId] = parseInt(sel.value);
    });

    appState.courseGoals = goals;
    await chrome.storage.local.set({ courseGoals: goals });

    const settings = appState.settings || {};

    chrome.runtime.sendMessage({
      action: 'generatePlan',
      config: {
        assignments: appState.assignments,
        courses: appState.courses,
        goals,
        studyHoursPerDay: settings.studyHoursPerDay || 4,
        studyDays: settings.studyDays || ['mon', 'tue', 'wed', 'thu', 'fri'],
      }
    }, (plan) => {
      renderStudyPlan(plan);
    });
  }

  function renderStudyPlan(plan) {
    const container = $('#study-plan-output');

    if (!plan || plan.weeks.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p>${plan?.summary || 'No tasks to plan.'}</p>
        </div>`;
      return;
    }

    let html = `<p style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">${escapeHtml(plan.summary)}</p>`;

    for (const week of plan.weeks) {
      html += `
        <div class="plan-week">
          <div class="plan-week-header">
            Week ${week.weekNumber}: ${week.label}
            ${week.isOverloaded ? '<span style="color: var(--warning);"> ⚠️ Heavy</span>' : ''}
          </div>`;

      for (const task of week.tasks) {
        const isCompleted = appState.studyPlanProgress[task.id];
        html += `
          <div class="plan-task">
            <div class="plan-checkbox ${isCompleted ? 'checked' : ''}" data-task-id="${task.id}"></div>
            <div class="plan-task-info">
              <div class="plan-task-name ${isCompleted ? 'completed' : ''}">${escapeHtml(task.title)}</div>
              <div class="plan-task-detail">
                ${escapeHtml(task.course)} · ${task.type} · ~${task.estimatedHours}h
                · Due ${formatDate(new Date(task.dueDate))}
              </div>
            </div>
          </div>`;
      }

      html += `
          <div class="progress-bar">
            <div class="progress-fill ${week.isOverloaded ? 'warning' : 'good'}"
                 style="width: ${Math.min(100, (week.totalHoursNeeded / week.totalAvailableHours) * 100)}%">
            </div>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
            ${week.totalHoursNeeded.toFixed(1)}h planned / ${week.totalAvailableHours}h available
          </div>
        </div>`;
    }

    container.innerHTML = html;

    container.querySelectorAll('.plan-checkbox').forEach(cb => {
      cb.addEventListener('click', async () => {
        const taskId = cb.dataset.taskId;
        const isChecked = cb.classList.toggle('checked');
        const taskName = cb.nextElementSibling.querySelector('.plan-task-name');
        taskName.classList.toggle('completed', isChecked);

        appState.studyPlanProgress[taskId] = isChecked;
        await chrome.storage.local.set({ studyPlanProgress: appState.studyPlanProgress });
      });
    });
  }

  // === Syllabus ===

  function populateSyllabusPanel() {
    const select = $('#syllabus-course-select');
    select.innerHTML = '<option value="">Select Course</option>';
    appState.courses.forEach(c => {
      const hasSyllabus = !!appState.syllabusData[c.id];
      select.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)}${hasSyllabus ? ' ✓' : ''}</option>`;
    });
    updateSyllabusImagePreviewForCourse(select.value);
    select.onchange = () => {
      updateSyllabusImagePreviewForCourse(select.value);
      const cid = select.value;
      mergeManualExamsIntoSyllabusData();
      if (cid && appState.syllabusData[cid]) {
        renderSyllabusResults(appState.syllabusData[cid]);
      } else {
        $('#syllabus-results')?.classList.add('hidden');
      }
    };
    const cid = select.value;
    mergeManualExamsIntoSyllabusData();
    if (cid && appState.syllabusData[cid]) {
      renderSyllabusResults(appState.syllabusData[cid]);
    }
  }

  function setSyllabusGradingPreviewDataUrl(dataUrl) {
    const wrap = $('#syllabus-image-wrap');
    const img = $('#syllabus-grading-preview');
    if (!wrap || !img) return;
    img.src = dataUrl;
    wrap.classList.remove('hidden');
  }

  function clearSyllabusGradingImage() {
    const wrap = $('#syllabus-image-wrap');
    const img = $('#syllabus-grading-preview');
    if (img) img.removeAttribute('src');
    if (wrap) wrap.classList.add('hidden');
    const courseId = $('#syllabus-course-select')?.value;
    if (courseId && appState.syllabusData[courseId]) {
      delete appState.syllabusData[courseId].gradingScaleImage;
      chrome.storage.local.set({ syllabusData: appState.syllabusData });
    }
  }

  function updateSyllabusImagePreviewForCourse(courseId) {
    const wrap = $('#syllabus-image-wrap');
    const img = $('#syllabus-grading-preview');
    const dataUrl = courseId && appState.syllabusData[courseId]?.gradingScaleImage;
    if (dataUrl && img && wrap) {
      img.src = dataUrl;
      wrap.classList.remove('hidden');
    } else if (img && wrap) {
      img.removeAttribute('src');
      wrap.classList.add('hidden');
    }
  }

  function handleSyllabusPanelPaste(ev) {
    const items = ev.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        ev.preventDefault();
        const f = item.getAsFile();
        if (f) {
          const r = new FileReader();
          r.onload = () => setSyllabusGradingPreviewDataUrl(r.result);
          r.readAsDataURL(f);
          const st = $('#syllabus-file-status');
          st.classList.remove('hidden');
          st.className = 'syllabus-status success';
          st.textContent = 'Image pasted — it will be saved with this course. Add text below if needed, then Parse.';
        }
        break;
      }
    }
  }

  function handleSyllabusImagePick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = () => setSyllabusGradingPreviewDataUrl(r.result);
    r.readAsDataURL(file);
  }

  async function handleSyllabusFile(e) {
    const file = e.target.files[0];
    const statusEl = $('#syllabus-file-status');
    e.target.value = '';

    if (!file) return;

    if (file.type && file.type.startsWith('image/')) {
      const r = new FileReader();
      r.onload = () => {
        setSyllabusGradingPreviewDataUrl(r.result);
        statusEl.classList.remove('hidden');
        statusEl.className = 'syllabus-status success';
        statusEl.textContent = 'Image loaded — saved with course when you parse. Optionally paste syllabus text below.';
      };
      r.readAsDataURL(file);
      return;
    }

    const loader = (typeof globalThis !== 'undefined' ? globalThis : window).BSASyllabusFileLoader;
    if (!loader || typeof loader.extractTextFromFile !== 'function') {
      statusEl.className = 'syllabus-status error';
      statusEl.textContent = 'File support failed to load. Reload the extension or paste text instead.';
      statusEl.classList.remove('hidden');
      return;
    }

    statusEl.classList.remove('hidden', 'error', 'success');
    statusEl.classList.add('muted');
    statusEl.textContent = `Reading ${file.name}…`;

    try {
      const { text, format } = await loader.extractTextFromFile(file);
      $('#syllabus-text').value = text;
      statusEl.className = 'syllabus-status success';
      statusEl.textContent =
        format === 'text'
          ? 'Loaded plain text.'
          : `Extracted text from ${format.toUpperCase()}. Review below, then click Parse Syllabus.`;
    } catch (err) {
      statusEl.className = 'syllabus-status error';
      statusEl.textContent = err.message || 'Could not read this file. Try PDF, DOCX, TXT, or paste text.';
    }
  }

  async function handleParseSyllabus() {
    const courseId = $('#syllabus-course-select').value;
    let text = $('#syllabus-text').value.trim();
    const parseBtn = $('#btn-parse-syllabus');
    const statusEl = $('#syllabus-file-status');

    if (!courseId) {
      alert('Please select a course first.');
      return;
    }
    const hasGradingImage = $('#syllabus-grading-preview')?.src?.startsWith('data:');
    if (!text && !hasGradingImage) {
      alert('Paste syllabus text, upload a PDF/DOCX, or attach a syllabus image (screenshot).');
      return;
    }

    const loader = (typeof globalThis !== 'undefined' ? globalThis : window).BSASyllabusFileLoader;
    if (text && loader?.looksLikeBinaryGarbage?.(text)) {
      statusEl.classList.remove('hidden');
      statusEl.className = 'syllabus-status error';
      statusEl.textContent =
        'This still looks like raw binary. Upload a PDF/DOCX (we extract text) or paste from the syllabus.';
      return;
    }

    const prevLabel = parseBtn.textContent;
    parseBtn.disabled = true;
    parseBtn.textContent = 'Parsing…';

    const gradingImageDataUrl =
      $('#syllabus-grading-preview')?.src?.startsWith('data:') ? $('#syllabus-grading-preview').src : null;

    chrome.runtime.sendMessage({ action: 'parseSyllabus', text, gradingImageDataUrl }, async (result) => {
      parseBtn.disabled = false;
      parseBtn.textContent = prevLabel;

      const err = chrome.runtime.lastError;
      if (err) {
        statusEl.classList.remove('hidden');
        statusEl.className = 'syllabus-status error';
        statusEl.textContent = err.message || 'Extension busy. Try again.';
        return;
      }

      if (!result || result.error) {
        statusEl.classList.remove('hidden');
        statusEl.className = 'syllabus-status error';
        statusEl.textContent = 'Could not parse syllabus. Check the text and try again, or paste a different section.';
        return;
      }

      appState.syllabusData[courseId] = result;
      await chrome.storage.local.set({ syllabusData: appState.syllabusData });
      mergeManualExamsIntoSyllabusData();

      const imgPrev = $('#syllabus-grading-preview');
      if (imgPrev?.src?.startsWith('data:')) {
        result.gradingScaleImage = imgPrev.src;
      }

      if (result.exams?.length > 0) {
        const examAssignments = result.exams
          .filter(e => e.date)
          .map((e, ei) => ({
            id: `exam_${courseId}_syllabus_${ei}`,
            title: e.type,
            dueDate: e.date,
            type: 'exam',
            courseId,
            submitted: false,
            points: null,
            source: 'syllabus',
          }));

        const existing = new Set(
          appState.assignments
            .filter(a => a.courseId === courseId && effectiveDueDate(a))
            .map(a => `${(a.title || '').trim().toLowerCase()}|${effectiveDueDate(a)}`)
        );
        const toAdd = examAssignments.filter(
          a => !existing.has(`${(a.title || '').trim().toLowerCase()}|${a.dueDate}`)
        );
        appState.assignments = [...appState.assignments, ...toAdd];
        await chrome.storage.local.set({ assignments: appState.assignments });
      }

      statusEl.classList.remove('hidden');
      statusEl.className = 'syllabus-status success';
      statusEl.textContent =
        result._source === 'gemini'
          ? 'Syllabus parsed with Google AI. Results are below.'
          : 'Syllabus parsed locally (no API). Results are below.';

      renderSyllabusResults(result);
      render();
    });
  }

  // === Manage deadlines (manual edit + rescan) ===

  function isoToDatetimeLocalValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function datetimeLocalToIso(localStr) {
    if (!localStr) return null;
    const d = new Date(localStr);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function populateManageDeadlinesPanel() {
    const courseSel = $('#manual-dl-course');
    courseSel.innerHTML = '<option value="">Select course</option>';
    appState.courses.forEach((c) => {
      courseSel.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });

    const container = $('#manage-deadlines-list');
    const withDates = appState.assignments
      .filter((a) => effectiveDueDate(a))
      .sort((a, b) => new Date(effectiveDueDate(a)) - new Date(effectiveDueDate(b)));

    if (withDates.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><p>No dated items yet. Add one below or rescan Blackboard.</p></div>';
      return;
    }

    container.innerHTML = withDates
      .map((a) => {
        const course = appState.courses.find((c) => c.id === a.courseId);
        const dlVal = isoToDatetimeLocalValue(effectiveDueDate(a));
        return `
          <div class="deadline-manage-row" data-assignment-id="${escapeHtml(a.id)}">
            <div class="deadline-manage-title">${escapeHtml(a.title)}</div>
            <div class="deadline-manage-meta">${escapeHtml(course ? course.name : 'Course')} · <span class="event-type ${a.type}" style="position:static;">${escapeHtml(a.type || 'assignment')}</span>${a.userEdited ? ' · edited manually' : ''}</div>
            <label for="dl-edit-${escapeHtml(a.id)}">Due</label>
            <input type="datetime-local" id="dl-edit-${escapeHtml(a.id)}" class="dl-datetime" value="${dlVal}">
            <div class="deadline-manage-actions">
              <button type="button" class="btn-sm-inline" data-save-dl="${escapeHtml(a.id)}">Save date</button>
              <button type="button" class="btn-danger-outline" data-remove-dl="${escapeHtml(a.id)}">Remove</button>
            </div>
          </div>`;
      })
      .join('');

    container.querySelectorAll('[data-save-dl]').forEach((btn) => {
      btn.addEventListener('click', () => saveDeadlineEdit(btn.dataset.saveDl));
    });
    container.querySelectorAll('[data-remove-dl]').forEach((btn) => {
      btn.addEventListener('click', () => removeDeadline(btn.dataset.removeDl));
    });
  }

  async function saveDeadlineEdit(assignmentId) {
    const row = [...document.querySelectorAll('.deadline-manage-row')].find(
      (el) => el.getAttribute('data-assignment-id') === assignmentId
    );
    const input = row?.querySelector('.dl-datetime');
    const iso = datetimeLocalToIso(input?.value);
    if (!iso) {
      alert('Pick a valid date and time.');
      return;
    }

    const idx = appState.assignments.findIndex((a) => a.id === assignmentId);
    if (idx === -1) return;

    appState.assignments[idx] = {
      ...appState.assignments[idx],
      dueDate: iso,
      userEdited: true,
    };
    delete appState.assignments[idx].dueDateOverride;

    await chrome.storage.local.set({
      assignments: appState.assignments,
      [`notified_${assignmentId}`]: false,
    });

    const st = $('#manage-deadlines-status');
    st.classList.remove('hidden');
    st.className = 'syllabus-status success';
    st.textContent = 'Date saved.';
    render();
    populateManageDeadlinesPanel();
  }

  async function removeDeadline(assignmentId) {
    if (!confirm('Remove this deadline from your list?')) return;
    appState.assignments = appState.assignments.filter((a) => a.id !== assignmentId);
    await chrome.storage.local.remove(`notified_${assignmentId}`);
    await chrome.storage.local.set({ assignments: appState.assignments });
    mergeManualExamsIntoSyllabusData();
    await chrome.storage.local.set({ syllabusData: appState.syllabusData });

    const st = $('#manage-deadlines-status');
    st.classList.remove('hidden');
    st.className = 'syllabus-status muted';
    st.textContent = 'Removed.';
    render();
    populateManageDeadlinesPanel();
  }

  async function handleAddManualDeadline() {
    const courseId = $('#manual-dl-course').value;
    const title = $('#manual-dl-title').value.trim();
    const when = $('#manual-dl-when').value;
    const itemType = $('#manual-dl-type')?.value === 'exam' ? 'exam' : 'assignment';

    if (!courseId) {
      alert('Select a course.');
      return;
    }
    if (!title) {
      alert('Enter a title.');
      return;
    }
    const iso = datetimeLocalToIso(when);
    if (!iso) {
      alert('Pick a date and time.');
      return;
    }

    const id = `manual_${courseId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const examManualId =
      itemType === 'exam' ? `manual_exam_${courseId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined;

    appState.assignments.push({
      id,
      title,
      dueDate: iso,
      type: itemType,
      courseId,
      submitted: false,
      points: null,
      userEdited: true,
      source: itemType === 'exam' ? 'manualExam' : 'manual',
      examManualId,
      dateRaw: formatDateTime(new Date(iso)),
    });
    await chrome.storage.local.set({ assignments: appState.assignments });
    mergeManualExamsIntoSyllabusData();
    await chrome.storage.local.set({ syllabusData: appState.syllabusData });

    $('#manual-dl-title').value = '';
    $('#manual-dl-when').value = '';

    const st = $('#manage-deadlines-status');
    st.classList.remove('hidden');
    st.className = 'syllabus-status success';
    st.textContent = itemType === 'exam' ? 'Exam added. It appears under Calendar → Exams too.' : 'Item added.';
    render();
    populateManageDeadlinesPanel();
  }

  async function handleRescanFromManagePanel() {
    const st = $('#manage-deadlines-status');
    st.classList.remove('hidden', 'error', 'success');
    st.classList.add('muted');
    st.textContent = 'Scanning open Blackboard tab…';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const savedUrl = appState.settings?.blackboardUrl || appState.blackboardUrl || '';

      if (!tab || !(isBlackboardUrl(tab.url) || (savedUrl && tab.url?.startsWith(savedUrl)))) {
        st.className = 'syllabus-status error';
        st.textContent = 'Open a Blackboard page in this window, then try Rescan again.';
        return;
      }

      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'scan' }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      });

      await new Promise((r) => setTimeout(r, 2000));
      await loadData();
      render();
      populateManageDeadlinesPanel();

      st.className = 'syllabus-status success';
      st.textContent = 'Rescan complete. Review your deadlines below.';
    } catch (e) {
      st.className = 'syllabus-status error';
      st.textContent =
        e.message?.includes('Could not establish connection')
          ? 'Reload the Blackboard tab and try again.'
          : (e.message || 'Scan failed.');
    }
  }

  function renderSyllabusResults(data) {
    const container = $('#syllabus-results');
    container.classList.remove('hidden');

    mergeManualExamsIntoSyllabusData();
    const courseId = $('#syllabus-course-select')?.value;
    const merged =
      courseId && appState.syllabusData[courseId]
        ? { ...data, ...appState.syllabusData[courseId], exams: appState.syllabusData[courseId].exams || data.exams }
        : data;

    let html = '<div class="section-title" style="margin-top: 0;">📊 Parsed Results</div>';
    if (merged._parseWarning) {
      html += `<div style="font-size: 11px; color: var(--warning); margin-bottom: 8px;">⚠️ ${escapeHtml(merged._parseWarning)} (local parser used)</div>`;
    } else if (merged._source === 'gemini') {
      html += `<div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">Parsed with Google AI${merged._model ? ` (${escapeHtml(merged._model)})` : ''}.</div>`;
    } else {
      html += `<div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">Parsed on your device (no syllabus API call).</div>`;
    }

    if (merged.courseInfo?.courseNumber || merged.courseInfo?.instructor) {
      html += `<div class="card" style="cursor: default;">`;
      if (merged.courseInfo.courseNumber) html += `<div style="font-size: 13px;"><strong>Course:</strong> ${escapeHtml(merged.courseInfo.courseNumber)}</div>`;
      if (merged.courseInfo.instructor) html += `<div style="font-size: 13px;"><strong>Instructor:</strong> ${escapeHtml(merged.courseInfo.instructor)}</div>`;
      if (merged.courseInfo.email) html += `<div style="font-size: 13px;"><strong>Email:</strong> ${escapeHtml(merged.courseInfo.email)}</div>`;
      if (merged.courseInfo.semester) html += `<div style="font-size: 13px;"><strong>Semester:</strong> ${escapeHtml(merged.courseInfo.semester)}</div>`;
      html += `</div>`;
    }

    if (merged.gradingScaleImage) {
      html += `<div class="section-title">Grading scale (image)</div>`;
      html += `<div class="card" style="cursor: default; padding: 8px;"><img src="${merged.gradingScaleImage}" alt="Grading scale" style="max-width: 100%; border-radius: 8px;"></div>`;
    }

    if (merged.gradingBreakdown?.categories?.length > 0) {
      html += `<div class="section-title">Grading Breakdown</div>`;
      html += `<table class="grade-table"><thead><tr><th>Category</th><th>Weight</th></tr></thead><tbody>`;
      for (const cat of merged.gradingBreakdown.categories) {
        html += `<tr><td>${escapeHtml(cat.category)}</td><td>${cat.weight}%</td></tr>`;
      }
      html += `</tbody></table>`;
      if (!merged.gradingBreakdown.isValid) {
        html += `<div style="font-size: 11px; color: var(--warning);">⚠️ Weights total ${merged.gradingBreakdown.totalWeight}% (expected ~100%)</div>`;
      }
    }

    if (merged.exams?.length > 0) {
      html += `<div class="section-title">Exam Dates</div>`;
      merged.exams.forEach((e) => {
        const manual = e.context === 'Entered manually';
        html += `<div class="card" style="cursor: default;"><strong>${escapeHtml(e.type)}</strong>${manual ? ' <span style="font-size:11px;color:var(--text-muted);">(manual)</span>' : ''}<br><span style="color: var(--text-muted); font-size: 12px;">${escapeHtml(e.dateRaw || 'Date TBD')}</span></div>`;
      });
    }

    if (merged.officeHours) {
      html += `<div class="section-title">Office Hours</div>`;
      html += `<div class="card" style="cursor: default; font-size: 13px;">${escapeHtml(merged.officeHours.rawText)}</div>`;
    }

    container.innerHTML = html;
  }

  // === Course Detail ===

  function showCourseDetail(courseId) {
    const course = appState.courses.find(c => c.id === courseId);
    if (!course) return;

    $('#course-detail-title').textContent = course.name;

    const assignments = appState.assignments.filter(a => a.courseId === courseId);
    const grades = appState.grades.filter(g => g.courseId === courseId);
    const syllabus = appState.syllabusData[courseId];
    const now = new Date();

    let html = '';

    const upcoming = assignments
      .filter(a => effectiveDueDate(a) && new Date(effectiveDueDate(a)) > now && !a.submitted)
      .sort((a, b) => new Date(effectiveDueDate(a)) - new Date(effectiveDueDate(b)));

    if (upcoming.length > 0) {
      html += '<div class="section-title">Upcoming</div>';
      upcoming.forEach(a => {
        const due = new Date(effectiveDueDate(a));
        const hoursUntil = (due - now) / (1000 * 60 * 60);
        html += `
          <div class="card" style="cursor: default;">
            <div style="font-size: 13px; font-weight: 600;">${escapeHtml(a.title)}</div>
            <div style="font-size: 12px; color: var(--text-muted);">
              ${formatDeadline(due, hoursUntil)} · <span class="event-type ${a.type}" style="position: static;">${a.type}</span>
            </div>
          </div>`;
      });
    }

    if (grades.length > 0) {
      html += '<div class="section-title">Grades</div>';
      html += '<table class="grade-table"><thead><tr><th>Item</th><th>Score</th><th>%</th></tr></thead><tbody>';
      grades.forEach(g => {
        html += `<tr><td>${escapeHtml(g.name)}</td><td>${g.score}/${g.total}</td><td>${g.percentage}%</td></tr>`;
      });
      html += '</tbody></table>';
    }

    if (syllabus) {
      html += '<div class="section-title">Syllabus Data</div>';
      html += '<div class="card" style="cursor: default; font-size: 12px; color: var(--text-muted);">Syllabus parsed ✓</div>';
    }

    if (!html) {
      html = '<div class="empty-state"><p>No data yet for this course. Visit the course page on Blackboard or upload a syllabus.</p></div>';
    }

    $('#course-detail-body').innerHTML = html;
    openPanel('course-detail');
  }

  // === Actions ===

  function isBlackboardUrl(url) {
    if (!url) return false;
    const bbPatterns = [
      'blackboard.com',
      'elearning.utdallas.edu',
      'instructure.com',
      'learn.', 'elearning.', 'bb.',
      'blackboard', 'ultra/course', 'ultra/grades',
    ];
    const lower = url.toLowerCase();
    return bbPatterns.some(p => lower.includes(p));
  }

  async function handleRefresh() {
    const dot = $('#status-dot');
    const text = $('#status-text');
    dot.className = 'status-dot scanning';
    text.textContent = 'Scanning...';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const savedUrl = appState.settings?.blackboardUrl || appState.blackboardUrl || '';

      if (tab && (isBlackboardUrl(tab.url) || (savedUrl && tab.url?.startsWith(savedUrl)))) {
        chrome.tabs.sendMessage(tab.id, { action: 'scan' }, async () => {
          await new Promise(r => setTimeout(r, 2500));
          await loadData();
          render();
        });
      } else {
        text.textContent = 'Navigate to Blackboard first';
        dot.className = 'status-dot disconnected';
        setTimeout(updateStatusBar, 3000);
      }
    } catch {
      text.textContent = 'Could not connect to Blackboard tab';
      dot.className = 'status-dot disconnected';
    }
  }

  function handleOpenBlackboard() {
    const url = appState.settings?.blackboardUrl || appState.blackboardUrl || 'https://www.blackboard.com';
    chrome.tabs.create({ url });
  }

  // === Utilities ===

  function formatDeadline(date, hoursUntil) {
    if (hoursUntil < 1) return `Due in ${Math.round(hoursUntil * 60)} min`;
    if (hoursUntil < 24) return `Due in ${Math.round(hoursUntil)} hours`;
    if (hoursUntil < 48) return `Due tomorrow at ${formatTime(date)}`;
    const days = Math.round(hoursUntil / 24);
    return `Due in ${days} days · ${formatDate(date)}`;
  }

  function formatDate(date) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function formatDateTime(date) {
    return `${formatDate(date)} · ${formatTime(date)}`;
  }

  function getTimeAgo(date) {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
