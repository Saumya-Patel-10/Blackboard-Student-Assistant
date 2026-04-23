/**
 * Blackboard Student Assistant - Options Page Controller
 */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /** Avoid crashes if options.html is missing elements (old cached build or edited HTML). */
  function onClick(sel, handler) {
    const el = $(sel);
    if (el) el.addEventListener('click', handler);
  }

  async function init() {
    try {
      const extId = chrome.runtime.id;
      const idEl = $('#ext-id-display');
      if (idEl) idEl.textContent = extId;

      const data = await chrome.storage.local.get('settings');
      const settings = data.settings || {};

      const bb = $('#opt-bb-url');
      if (bb && settings.blackboardUrl) bb.value = settings.blackboardUrl;

      const autoScan = $('#opt-auto-scan');
      if (autoScan && settings.autoScan !== undefined) autoScan.checked = settings.autoScan;

      const scanFreq = $('#opt-scan-freq');
      if (scanFreq && settings.scanFrequency) scanFreq.value = String(settings.scanFrequency);

      const notifEn = $('#opt-notif-enabled');
      if (notifEn && settings.notificationsEnabled !== undefined) notifEn.checked = settings.notificationsEnabled;

      const notifAdv = $('#opt-notif-advance');
      if (notifAdv && settings.notifyAdvance) notifAdv.value = String(settings.notifyAdvance);

      const daily = $('#opt-daily-summary');
      if (daily && settings.dailySummary !== undefined) daily.checked = settings.dailySummary;

      const autoCal = $('#opt-auto-sync-cal');
      if (autoCal && settings.autoSyncCalendar !== undefined) autoCal.checked = settings.autoSyncCalendar;

      const studyH = $('#opt-study-hours');
      if (studyH && settings.studyHoursPerDay) studyH.value = String(settings.studyHoursPerDay);

      const gemK = $('#opt-gemini-key');
      if (gemK && settings.geminiApiKey) gemK.value = settings.geminiApiKey;
      const gemM = $('#opt-gemini-model');
      if (gemM && settings.geminiModel) gemM.value = settings.geminiModel;
      const gemSyl = $('#opt-gemini-syllabus');
      if (gemSyl && settings.useGeminiForSyllabus !== undefined) gemSyl.checked = !!settings.useGeminiForSyllabus;

      if (settings.studyDays) {
        $$('.day-btn').forEach(btn => {
          btn.classList.toggle('active', settings.studyDays.includes(btn.dataset.day));
        });
      }

      await checkCalendarStatus();
      bindEvents();
    } catch (e) {
      console.error('[BSA options]', e);
    }
  }

  function bindEvents() {
    onClick('#btn-save-options', saveSettings);
    onClick('#btn-connect-gcal', handleCalendarButton);
    onClick('#btn-copy-ext-id', async () => {
      try {
        await navigator.clipboard.writeText(chrome.runtime.id);
        showSavedToast('Extension ID copied');
      } catch (_) {
        showSavedToast('Could not copy');
      }
    });
    onClick('#btn-export', exportData);
    onClick('#btn-clear-data', clearData);

    $$('.day-btn').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });
  }

  async function saveSettings() {
    const prev = (await chrome.storage.local.get('settings')).settings || {};

    const studyDays = [];
    $$('.day-btn.active').forEach(btn => studyDays.push(btn.dataset.day));

    const elBb = $('#opt-bb-url');
    const elAuto = $('#opt-auto-scan');
    const elFreq = $('#opt-scan-freq');
    const elNotif = $('#opt-notif-enabled');
    const elAdv = $('#opt-notif-advance');
    const elDaily = $('#opt-daily-summary');
    const elCal = $('#opt-auto-sync-cal');
    const elStudy = $('#opt-study-hours');
    const elGemK = $('#opt-gemini-key');
    const elGemM = $('#opt-gemini-model');
    const elGemSyl = $('#opt-gemini-syllabus');

    if (!elBb || !elAuto || !elFreq || !elNotif || !elAdv || !elDaily || !elCal || !elStudy) {
      alert('Settings page is incomplete. Reload the extension (chrome://extensions → Reload) so options.html matches the latest version.');
      return;
    }

    const newGemKey = elGemK ? elGemK.value.trim() : '';
    const newGemModel = elGemM ? elGemM.value.trim() : '';

    const settings = {
      blackboardUrl: elBb.value.trim().replace(/\/$/, ''),
      autoScan: elAuto.checked,
      scanFrequency: parseInt(elFreq.value, 10) || 60,
      notificationsEnabled: elNotif.checked,
      notifyAdvance: parseInt(elAdv.value, 10) || 24,
      dailySummary: elDaily.checked,
      autoSyncCalendar: elCal.checked,
      studyHoursPerDay: parseInt(elStudy.value, 10) || 4,
      studyDays,
      geminiApiKey: newGemKey || prev.geminiApiKey || '',
      geminiModel: newGemModel || prev.geminiModel || '',
      useGeminiForSyllabus: elGemSyl ? elGemSyl.checked : false,
    };

    try {
      await new Promise((resolve, reject) => {
        chrome.storage.local.set({ settings }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      if (settings.blackboardUrl) {
        await new Promise((resolve, reject) => {
          chrome.storage.local.set({ blackboardUrl: settings.blackboardUrl }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
      }
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'refreshAlarms' }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      showSavedToast();
    } catch (err) {
      alert(`Could not save settings: ${err.message || err}`);
    }
  }

  async function checkCalendarStatus() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'checkCalendarConnection' }, (resp) => {
        const err = chrome.runtime.lastError;
        const statusEl = $('#gcal-status');
        const btn = $('#btn-connect-gcal');

        if (!statusEl || !btn) {
          resolve(false);
          return;
        }

        if (err) {
          statusEl.textContent = 'Could not check status';
          statusEl.style.color = '#f59e0b';
          btn.textContent = 'Connect';
          btn.className = 'btn btn-primary';
          btn.dataset.mode = 'connect';
          resolve(false);
          return;
        }

        if (resp?.connected) {
          statusEl.textContent = 'Connected ✓';
          statusEl.style.color = '#10b981';
          btn.textContent = 'Disconnect';
          btn.className = 'btn btn-danger';
          btn.dataset.mode = 'disconnect';
        } else {
          statusEl.textContent = 'Not connected';
          statusEl.style.color = '';
          btn.textContent = 'Connect';
          btn.className = 'btn btn-primary';
          btn.dataset.mode = 'connect';
        }
        resolve(!!resp?.connected);
      });
    });
  }

  function explainGoogleConnectError(raw) {
    const msg = (raw || '').toLowerCase();
    if (msg.includes('access_denied') || msg.includes('403')) {
      return (
        'Google returned access_denied (403).\n\n' +
        'Most often:\n' +
        '• Your OAuth app is in "Testing" — add your Google account under OAuth consent screen → Test users.\n' +
        '• Or you clicked Block / didn\'t finish the consent screen — try Connect again and choose Allow.\n\n' +
        'Open Google Cloud → OAuth consent screen → Audience → Test users → Add your email.'
      );
    }
    return raw || 'Unknown error';
  }

  async function handleCalendarButton() {
    const btn = $('#btn-connect-gcal');
    if (!btn) return;
    if (btn.dataset.mode === 'disconnect') {
      btn.textContent = 'Disconnecting...';
      btn.disabled = true;
      chrome.runtime.sendMessage({ action: 'disconnectCalendar' }, (resp) => {
        btn.disabled = false;
        if (chrome.runtime.lastError || !resp?.success) {
          alert(`Could not disconnect: ${chrome.runtime.lastError?.message || resp?.error || 'Unknown error'}`);
        }
        checkCalendarStatus();
      });
      return;
    }

    btn.textContent = 'Connecting...';
    btn.disabled = true;

    chrome.runtime.sendMessage({ action: 'connectCalendar' }, (resp) => {
      btn.disabled = false;
      const err = chrome.runtime.lastError;
      if (err || !resp?.success) {
        const raw = err?.message || resp?.error || 'Unknown error';
        alert(
          `Could not connect to Google Calendar.\n\n${explainGoogleConnectError(raw)}\n\n` +
          'Also verify: Extension ID above matches your Chrome extension OAuth client in Google Cloud, ' +
          'and Calendar API is enabled.'
        );
      }
      checkCalendarStatus();
    });
  }

  async function exportData() {
    const data = await chrome.storage.local.get(null);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `student-assistant-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function clearData() {
    if (!confirm('Are you sure? This will delete all your courses, grades, and settings.')) return;
    if (!confirm('This action cannot be undone. Continue?')) return;

    await chrome.storage.local.clear();
    await chrome.storage.local.set({
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
      },
    });

    showSavedToast('Data cleared!');
    setTimeout(() => location.reload(), 1000);
  }

  function showSavedToast(message = 'Settings saved!') {
    const existing = document.querySelector('.saved-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'saved-toast';
    toast.textContent = `✓ ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
