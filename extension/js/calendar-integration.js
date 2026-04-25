/**
 * Blackboard Student Assistant - Google Calendar Integration
 *
 * Handles OAuth2 authentication and event creation in Google Calendar
 * for deadlines, exams, and class schedules.
 *
 * Uses chrome.identity.getAuthToken when the identity permission is
 * available, otherwise stores a token obtained via manual OAuth flow.
 */

const CalendarIntegration = {

  /** Private extended property key — used to dedupe synced events */
  _SYNC_PROP_KEY: 'bsa_sync_id',

  _cachedToken: null,

  /**
   * Stable id so the same assignment / exam does not create duplicate Calendar rows on re-sync.
   * @param {object} eventData
   * @returns {string}
   */
  makeSyncId(eventData) {
    if (eventData.assignmentId) return `a:${String(eventData.assignmentId)}`;
    if (eventData.syncKey) return `k:${String(eventData.syncKey)}`;
    const rawTitle = String(eventData.title || '').replace(/^📝\s*/, '').trim();
    const course = String(eventData.course || '').trim();
    const start = eventData.startDate ? new Date(eventData.startDate).getTime() : '0';
    const type = String(eventData.type || '');
    return `h:${course}|${rawTitle}|${start}|${type}`;
  },

  async getAuthToken(interactive = true) {
    if (this._cachedToken) return this._cachedToken;

    const stored = await chrome.storage.local.get('gcal_token');
    if (stored.gcal_token) {
      this._cachedToken = stored.gcal_token;
      return this._cachedToken;
    }

    if (typeof chrome.identity !== 'undefined' && chrome.identity.getAuthToken) {
      return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, async (token) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!token) {
            reject(new Error('No OAuth token returned'));
            return;
          }
          this._cachedToken = token;
          try {
            await chrome.storage.local.set({ gcal_token: token });
          } catch (_) {}
          resolve(token);
        });
      });
    }

    if (!interactive) throw new Error('Not connected');
    throw new Error(
      'Google Calendar requires the identity API. Reload the extension or reinstall from the official package.'
    );
  },

  async setToken(token) {
    this._cachedToken = token;
    await chrome.storage.local.set({ gcal_token: token });
  },

  async revokeToken() {
    let token = this._cachedToken;
    if (!token) {
      const stored = await chrome.storage.local.get('gcal_token');
      token = stored.gcal_token;
    }

    try {
      if (token) {
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`);
      }
    } catch (_) {
      // Token may already be invalid
    }

    this._cachedToken = null;
    await chrome.storage.local.remove('gcal_token');

    if (typeof chrome.identity !== 'undefined' && chrome.identity.removeCachedAuthToken && token) {
      try {
        await new Promise((resolve) => {
          chrome.identity.removeCachedAuthToken({ token }, resolve);
        });
      } catch (_) {}
    }

    if (typeof chrome.identity !== 'undefined' && typeof chrome.identity.clearAllCachedAuthTokens === 'function') {
      try {
        await new Promise((resolve) => {
          chrome.identity.clearAllCachedAuthTokens(resolve);
        });
      } catch (_) {}
    }
  },

  async isConnected() {
    try {
      await this.getAuthToken(false);
      return true;
    } catch {
      return false;
    }
  },

  _attachSyncMetadata(event, eventData) {
    const syncId = this.makeSyncId(eventData);
    event.extendedProperties = event.extendedProperties || {};
    event.extendedProperties.private = {
      ...(event.extendedProperties.private || {}),
      [this._SYNC_PROP_KEY]: syncId,
    };
    return syncId;
  },

  /**
   * Find an existing event created by this extension with the same sync id (dedupe).
   */
  async findEventBySyncId(token, syncId) {
    const q = new URLSearchParams({
      privateExtendedProperty: `${this._SYNC_PROP_KEY}=${syncId}`,
      singleEvents: 'true',
      maxResults: '10',
      orderBy: 'startTime',
    });
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q.toString()}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const items = data.items || [];
    return items[0] || null;
  },

  /**
   * Create or update a single event so re-sync does not duplicate rows.
   */
  async createOrUpdateEvent(eventData) {
    const token = await this.getAuthToken(true);

    const baseEvent = {
      summary: eventData.title,
      description: this.buildDescription(eventData),
      start: this.buildDateTime(eventData.startDate, eventData.allDay),
      end: this.buildDateTime(eventData.endDate || eventData.startDate, eventData.allDay),
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 1440 },
        ],
      },
      colorId: this.getColorId(eventData.type),
    };

    if (eventData.recurrence) {
      baseEvent.recurrence = eventData.recurrence;
    }

    const syncId = this._attachSyncMetadata(baseEvent, eventData);
    const existing = await this.findEventBySyncId(token, syncId);

    let response;
    if (existing?.id) {
      response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(existing.id)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(baseEvent),
        }
      );
    } else {
      response = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(baseEvent),
        }
      );
    }

    if (!response.ok) {
      if (response.status === 401) {
        this._cachedToken = null;
        await chrome.storage.local.remove('gcal_token');
        try {
          const t = await new Promise((r) => chrome.identity.getAuthToken({ interactive: false }, r));
          if (t) await new Promise((res) => chrome.identity.removeCachedAuthToken({ token: t }, res));
        } catch (_) {}
        throw new Error('Token expired. Please reconnect Google Calendar.');
      }
      let errMsg = 'Failed to save calendar event';
      try {
        const error = await response.json();
        errMsg = error.error?.message || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }

    return response.json();
  },

  /** @deprecated Prefer createOrUpdateEvent — kept for direct callers */
  async createEvent(eventData) {
    return this.createOrUpdateEvent(eventData);
  },

  async createMultipleEvents(events, onProgress) {
    const results = { success: [], failed: [] };

    for (let i = 0; i < events.length; i++) {
      try {
        const result = await this.createOrUpdateEvent(events[i]);
        const syncId = this.makeSyncId(events[i]);
        results.success.push({ event: events[i], result, syncId });
      } catch (err) {
        results.failed.push({ event: events[i], error: err.message });
      }

      if (onProgress) {
        onProgress(i + 1, events.length);
      }

      if (i < events.length - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    return results;
  },

  buildDescription(eventData) {
    const parts = [];
    if (eventData.course) parts.push(`Course: ${eventData.course}`);
    if (eventData.type) parts.push(`Type: ${eventData.type}`);
    if (eventData.points) parts.push(`Points: ${eventData.points}`);
    if (eventData.url) parts.push(`Link: ${eventData.url}`);
    parts.push('\n📚 Added by Blackboard Student Assistant');
    return parts.join('\n');
  },

  buildDateTime(dateStr, allDay = false) {
    const date = new Date(dateStr);

    if (allDay) {
      return { date: date.toISOString().split('T')[0] };
    }

    return {
      dateTime: date.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },

  getColorId(type) {
    const colors = {
      exam: '11',
      quiz: '6',
      assignment: '9',
      project: '3',
      discussion: '2',
      class: '1',
    };
    return colors[type] || '9';
  },

  assignmentToEvent(assignment, courseName) {
    return {
      title: `📝 ${assignment.title}`,
      course: courseName,
      type: assignment.type,
      startDate: assignment.dueDate,
      allDay: false,
      points: assignment.points,
      url: assignment.url,
      assignmentId: assignment.id,
    };
  },

  examToEvent(exam, courseName) {
    return {
      title: `📕 ${exam.type}: ${courseName}`,
      course: courseName,
      type: 'exam',
      startDate: exam.date,
      allDay: false,
    };
  },

  classToEvent(classInfo) {
    return {
      title: `📖 ${classInfo.courseName}`,
      course: classInfo.courseName,
      type: 'class',
      startDate: classInfo.startTime,
      endDate: classInfo.endTime,
      allDay: false,
      recurrence: classInfo.recurrence || null,
    };
  },
};

if (typeof module !== 'undefined') {
  module.exports = CalendarIntegration;
}
