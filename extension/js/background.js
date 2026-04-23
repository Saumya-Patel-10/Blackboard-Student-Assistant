/**
 * Blackboard Student Assistant - Background Service Worker
 *
 * Manages alarms for periodic scanning and deadline notifications.
 */

importScripts(
  'syllabus-parser.js',
  'grade-calculator.js',
  'study-planner.js',
  'calendar-integration.js',
  'gemini-client.js'
);

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      settings: {
        blackboardUrl: '',
        autoScan: true,
        scanFrequency: 60,
        notificationsEnabled: true,
        notifyAdvance: 24,
        dailySummary: true,
        autoSyncCalendar: false,
        studyHoursPerDay: 4,
        studyDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
        geminiApiKey: '',
        geminiModel: '',
        useGeminiForSyllabus: false,
      },
      courses: [],
      assignments: [],
      grades: [],
      syllabusData: {},
      courseGoals: {},
      studyPlanProgress: {},
    });
  }

  setupAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarms();
});

function setupAlarms() {
  chrome.storage.local.get('settings', ({ settings }) => {
    chrome.alarms.clearAll();

    if (settings?.notificationsEnabled) {
      chrome.alarms.create('checkDeadlines', { periodInMinutes: 30 });
    }

    if (settings?.dailySummary) {
      chrome.alarms.create('dailySummary', { periodInMinutes: 1440 });
    }

    if (settings?.autoScan) {
      const freq = settings.scanFrequency || 60;
      chrome.alarms.create('autoScan', { periodInMinutes: freq });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkDeadlines') {
    checkUpcomingDeadlines();
  } else if (alarm.name === 'dailySummary') {
    sendDailySummary();
  } else if (alarm.name === 'autoScan') {
    triggerAutoScan();
  }
});

async function checkUpcomingDeadlines() {
  const data = await chrome.storage.local.get(['assignments', 'settings', 'courses']);
  const { assignments = [], settings = {}, courses = [] } = data;
  const now = new Date();
  const advanceHours = settings.notifyAdvance || 24;

  for (const assignment of assignments) {
    const dueIso = assignment.dueDateOverride || assignment.dueDate;
    if (!dueIso || assignment.submitted) continue;

    const due = new Date(dueIso);
    const hoursUntil = (due - now) / (1000 * 60 * 60);

    if (hoursUntil > 0 && hoursUntil <= advanceHours) {
      const notifiedKey = `notified_${assignment.id}`;
      const already = await chrome.storage.local.get(notifiedKey);
      if (already[notifiedKey]) continue;

      const course = courses.find(c => c.id === assignment.courseId);
      const timeStr = formatTimeUntil(hoursUntil);

      chrome.notifications.create(assignment.id, {
        type: 'basic',
        iconUrl: '../icons/icon128.png',
        title: `⏰ Deadline: ${timeStr}`,
        message: `${assignment.title}${course ? ` — ${course.name}` : ''}`,
        priority: hoursUntil < 6 ? 2 : 1,
        buttons: [{ title: 'Open Blackboard' }],
      });

      chrome.storage.local.set({ [notifiedKey]: true });
    }
  }
}

async function sendDailySummary() {
  const data = await chrome.storage.local.get(['assignments', 'courses']);
  const { assignments = [], courses = [] } = data;
  const now = new Date();

  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const dueIso = (a) => a.dueDateOverride || a.dueDate;
  const dueToday = assignments.filter(a =>
    dueIso(a) && !a.submitted && new Date(dueIso(a)) <= todayEnd && new Date(dueIso(a)) > now
  );
  const dueThisWeek = assignments.filter(a =>
    dueIso(a) && !a.submitted && new Date(dueIso(a)) > todayEnd && new Date(dueIso(a)) <= weekEnd
  );

  if (dueToday.length === 0 && dueThisWeek.length === 0) return;

  let message = '';
  if (dueToday.length > 0) {
    message += `Due today: ${dueToday.map(a => a.title).join(', ')}\n`;
  }
  if (dueThisWeek.length > 0) {
    message += `Due this week: ${dueThisWeek.length} more items`;
  }

  chrome.notifications.create('daily-summary', {
    type: 'basic',
    iconUrl: '../icons/icon128.png',
    title: `📋 Daily Summary — ${dueToday.length} due today`,
    message: message.trim(),
    priority: dueToday.length > 0 ? 2 : 1,
  });
}

async function triggerAutoScan() {
  const data = await chrome.storage.local.get(['settings', 'blackboardUrl']);
  const url = data.settings?.blackboardUrl || data.blackboardUrl;
  if (!url) return;

  try {
    const tabs = await chrome.tabs.query({ url: `${url}/*` });
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'scan' }).catch(() => {});
    }
  } catch (_) {}
}

function formatTimeUntil(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 24) return `${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return `${days} day${days > 1 ? 's' : ''}`;
}

function dueIsoForAssignment(a) {
  if (!a) return null;
  return a.dueDateOverride || a.dueDate;
}

function normalizeSyllabusMerge(local, api) {
  const pickBreakdown = () => {
    const a = api?.gradingBreakdown;
    const l = local?.gradingBreakdown;
    if (a?.categories?.length) return a;
    if (l?.categories?.length) return l;
    return a || l || { categories: [], totalWeight: 0, isValid: false };
  };

  const mergeExams = () => {
    const ex = [...(api?.exams || [])];
    for (const e of local?.exams || []) {
      const dup = ex.some(
        (x) =>
          x.type === e.type &&
          (x.dateRaw || '') === (e.dateRaw || '') &&
          (x.date || '') === (e.date || '')
      );
      if (!dup) ex.push(e);
    }
    return ex;
  };

  const mergeAssignments = () => {
    const items = [...(api?.assignments || [])];
    for (const it of local?.assignments || []) {
      const dup = items.some(
        (x) =>
          (x.title || '').trim().toLowerCase() === (it.title || '').trim().toLowerCase() &&
          (x.date || '') === (it.date || '')
      );
      if (!dup) items.push(it);
    }
    return items;
  };

  return {
    gradingBreakdown: pickBreakdown(),
    exams: mergeExams(),
    assignments: mergeAssignments(),
    officeHours: api?.officeHours ?? local?.officeHours ?? null,
    courseInfo: { ...(local?.courseInfo || {}), ...(api?.courseInfo || {}) },
    schedule: (api?.schedule?.length ? api.schedule : local?.schedule) || [],
    policies: { ...(local?.policies || {}), ...(api?.policies || {}) },
  };
}

async function parseSyllabusWithOptionalGemini(text, gradingImageDataUrl) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const apiKey = (settings.geminiApiKey || '').trim();
  const useAi =
    settings.useGeminiForSyllabus === true &&
    !!apiKey &&
    !!globalThis.BSAGeminiClient;
  const trimmed = (text || '').trim();
  const hasImage = !!gradingImageDataUrl;
  const local = trimmed ? SyllabusParser.parse(trimmed) : { error: 'No text provided' };

  if (!useAi) {
    if (!trimmed && hasImage) {
      return {
        error:
          'Image-only syllabus: add syllabus text (paste or PDF), or enable “Use Google AI for syllabus” in Settings and add an API key.',
      };
    }
    return local;
  }

  if (!trimmed && !hasImage) {
    return local;
  }

  try {
    const model = settings.geminiModel || globalThis.BSAGeminiClient.DEFAULT_MODEL;
    const raw = await globalThis.BSAGeminiClient.parseSyllabusStructured(apiKey, trimmed, hasImage ? gradingImageDataUrl : null);
    const merged = trimmed ? normalizeSyllabusMerge(local, raw) : raw;
    merged._source = 'gemini';
    merged._model = model;
    return merged;
  } catch (e) {
    console.warn('[BSA] Gemini syllabus parse failed, using local parser:', e);
    if (trimmed && local && !local.error) {
      local._parseWarning = e.message || String(e);
      return local;
    }
    return {
      error: e.message || String(e),
      _parseWarning: trimmed && local && !local.error ? (e.message || String(e)) : undefined,
    };
  }
}

async function maybeAutoSyncCalendar() {
  const data = await chrome.storage.local.get(['settings', 'assignments', 'courses']);
  const settings = data.settings || {};
  if (!settings.autoSyncCalendar) return;

  let connected = false;
  try {
    connected = await CalendarIntegration.isConnected();
  } catch (_) {
    connected = false;
  }
  if (!connected) return;

  const assignments = data.assignments || [];
  const courses = data.courses || [];
  const now = new Date();
  const deadlines = assignments
    .filter((a) => {
      const d = dueIsoForAssignment(a);
      return d && !a.submitted && new Date(d) > now;
    })
    .sort((a, b) => new Date(dueIsoForAssignment(a)) - new Date(dueIsoForAssignment(b)));

  const events = [];
  const seen = new Set();
  for (const a of deadlines) {
    const course = courses.find((c) => c.id === a.courseId);
    const ev = {
      title: `📝 ${a.title}`,
      course: course?.name || '',
      type: a.type,
      startDate: dueIsoForAssignment(a),
      allDay: false,
      points: a.points,
      url: a.url,
      assignmentId: a.id,
    };
    const k = CalendarIntegration.makeSyncId(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    events.push(ev);
  }

  if (events.length === 0) return;

  try {
    await CalendarIntegration.createMultipleEvents(events);
  } catch (e) {
    console.warn('[BSA] Auto calendar sync failed:', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'scanComplete') {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    maybeAutoSyncCalendar();
  }

  if (msg.action === 'parseSyllabus') {
    (async () => {
      const result = await parseSyllabusWithOptionalGemini(msg.text, msg.gradingImageDataUrl);
      sendResponse(result);
    })();
    return true;
  }

  if (msg.action === 'inferGradesWithGemini') {
    (async () => {
      try {
        const { settings = {} } = await chrome.storage.local.get('settings');
        const apiKey = (settings.geminiApiKey || '').trim();
        if (!apiKey) {
          sendResponse({ success: false, error: 'Add your Google AI API key in extension settings.' });
          return;
        }
        const categories = msg.categories || [];
        const gradeLines = msg.gradeLines || '';
        let screenDataUrl = msg.screenCaptureDataUrl || null;
        if (screenDataUrl && !/^data:/.test(screenDataUrl)) {
          screenDataUrl = `data:image/jpeg;base64,${screenDataUrl}`;
        }
        const raw = await BSAGeminiClient.inferCategoryScoresFromGrades(
          apiKey,
          JSON.stringify(categories.map((c) => ({ category: c.category, weight: c.weight }))),
          gradeLines,
          screenDataUrl
        );
        const scoresArr = raw.scores || [];
        const byCat = new Map(scoresArr.map((s) => [String(s.category || '').toLowerCase(), s.score]));
        const out = categories.map((c) => ({
          category: c.category,
          weight: c.weight,
          score:
            byCat.get(String(c.category || '').toLowerCase()) ??
            scoresArr.find((s) => s.category === c.category)?.score ??
            null,
        }));
        sendResponse({ success: true, suggested: out });
      } catch (e) {
        sendResponse({ success: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.action === 'calculateGrades') {
    const report = GradeCalculator.generateReport(msg.categories);
    sendResponse(report);
    return true;
  }

  if (msg.action === 'suggestCategoryScores') {
    const out = GradeCalculator.suggestCategoryScores(msg.categories, msg.grades);
    sendResponse(out);
    return true;
  }

  if (msg.action === 'calculateNeeded') {
    const result = GradeCalculator.calculateNeeded(msg.categories, msg.targetGrade);
    sendResponse(result);
    return true;
  }

  if (msg.action === 'generatePlan') {
    const result = StudyPlanner.generatePlan(msg.config);
    sendResponse(result);
    return true;
  }

  if (msg.action === 'createCalendarEvent') {
    CalendarIntegration.createEvent(msg.eventData)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'syncCalendarEvents') {
    CalendarIntegration.createMultipleEvents(msg.events)
      .then(results => sendResponse({ success: true, results }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'checkCalendarConnection') {
    CalendarIntegration.isConnected()
      .then(connected => sendResponse({ connected }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (msg.action === 'connectCalendar') {
    CalendarIntegration.getAuthToken(true)
      .then(token => sendResponse({ success: !!token }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'disconnectCalendar') {
    CalendarIntegration.revokeToken()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'refreshAlarms') {
    setupAlarms();
    sendResponse({ success: true });
    return true;
  }

  if (msg.action === 'updateSettings') {
    (async () => {
      try {
        await new Promise((resolve, reject) => {
          chrome.storage.local.set({ settings: msg.settings }, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve();
            }
          });
        });
        const url = msg.settings?.blackboardUrl?.trim();
        if (url) {
          await new Promise((resolve, reject) => {
            chrome.storage.local.set({ blackboardUrl: url.replace(/\/$/, '') }, () => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve();
            });
          });
        }
        setupAlarms();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (btnIdx === 0) {
    chrome.storage.local.get('settings', ({ settings }) => {
      if (settings?.blackboardUrl) {
        chrome.tabs.create({ url: settings.blackboardUrl });
      }
    });
  }
});
