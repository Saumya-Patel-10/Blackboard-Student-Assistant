/**
 * Blackboard Student Assistant - Syllabus Parser
 *
 * Parses plain-text syllabus content to extract:
 *  - Grading breakdown (categories + weights)
 *  - Exam dates
 *  - Assignment schedule
 *  - Office hours
 *  - Key policies
 */

const SyllabusParser = {

  parse(text) {
    if (!text || typeof text !== 'string') {
      return { error: 'No text provided' };
    }

    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    return {
      gradingBreakdown: this.extractGradingBreakdown(normalized),
      exams: this.extractExams(normalized),
      assignments: this.extractScheduledItems(normalized),
      officeHours: this.extractOfficeHours(normalized),
      courseInfo: this.extractCourseInfo(normalized),
      schedule: this.extractWeeklySchedule(normalized),
      policies: this.extractPolicies(normalized),
    };
  },

  /**
   * Many syllabi use "40%: Homework" or markdown bullets like "**12%:** Exam 1".
   * The generic regexes stop at `*` (not in character class), so we parse those lines explicitly.
   */
  parsePercentLeadingBulletLines(text, categories, seen) {
    const lines = text.split('\n');
    for (const rawLine of lines) {
      let line = String(rawLine || '')
        .replace(/\*+/g, '')
        .replace(/_{1,2}/g, '')
        .trim();
      line = line.replace(/^\s*[-•·+]\s+/, '').trim();
      if (!line) continue;

      const pctFirst = /^(\d{1,3})\s*%\s*[-–:]\s*(.+)$/.exec(line);
      if (pctFirst) {
        const weight = parseInt(pctFirst[1], 10);
        let category = pctFirst[2].trim().replace(/\s+\([^)]*\)\s*$/, '').trim();
        if (this.isPlausibleCategoryLabel(category)) {
          this.pushGradingCategory(category, weight, categories, seen);
        }
        continue;
      }

      const labelFirst = /^(.+?)\s*[-–:]\s*(\d{1,3})\s*%$/.exec(line);
      if (labelFirst) {
        let category = labelFirst[1].trim().replace(/^\s*[-•·]\s*/, '').trim();
        const weight = parseInt(labelFirst[2], 10);
        if (this.isPlausibleCategoryLabel(category)) {
          this.pushGradingCategory(category, weight, categories, seen);
        }
      }
    }
  },

  isPlausibleCategoryLabel(category) {
    if (!category || category.length < 2 || category.length >= 80) return false;
    const lower = category.toLowerCase();
    if (/^(summary|total|note|notes|see below)\b/.test(lower)) return false;
    return true;
  },

  pushGradingCategory(category, weight, categories, seen) {
    if (weight <= 0 || weight > 100) return;
    category = String(category || '')
      .replace(/\*+/g, '')
      .replace(/_{1,2}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!this.isPlausibleCategoryLabel(category)) return;
    const key = category.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    categories.push({ category, weight });
  },

  /** Strip markdown emphasis so `**12%:**` lines match the same as `12%:` after parsing. */
  normalizeSyllabusMarkup(text) {
    return text
      .split('\n')
      .map((line) => line.replace(/\*+/g, '').replace(/_{1,2}/g, ''))
      .join('\n');
  },

  extractGradingBreakdown(text) {
    const categories = [];
    const seen = new Set();

    const gradingSection = this.extractSection(text, [
      'grading', 'grade breakdown', 'grade distribution',
      'evaluation', 'assessment', 'grading policy', 'grading policies', 'course grades', 'weight'
    ]);

    const searchText = this.normalizeSyllabusMarkup(gradingSection || text);

    this.parsePercentLeadingBulletLines(searchText, categories, seen);

    // Category/weight pairs must stay on one line: `\s*` would match newlines and turn "Summary:\n40%: Homework" into Summary=40%.
    const weightPatterns = [
      /(?:^|\n)\s*([^\n:]+?)\s*[-–:][ \t]*(\d{1,3})\s*%/gm,
      /(\d{1,3})\s*%\s*[-–:][ \t]*([^\n]+?)(?=\s*$|\s*\n)/gm,
      /(?:^|\n)\s*([^\n]+?)\s*\((\d{1,3})%\)/gm,
    ];

    for (const pattern of weightPatterns) {
      let match;
      while ((match = pattern.exec(searchText)) !== null) {
        let category, weight;
        if (/^\d/.test(match[1])) {
          weight = parseInt(match[1], 10);
          category = match[2].trim();
        } else {
          category = match[1].trim();
          weight = parseInt(match[2], 10);
        }

        category = category.replace(/^\s*[-•·]\s*/, '').trim();
        // Weight regex can span lines (e.g. "Grading" heading + "Exam 1 - 12%" on next line); keep the real label line only.
        const lines = category.split(/\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) category = lines[lines.length - 1];

        if (weight > 0 && weight <= 100 && category.length > 1 && category.length < 80) {
          this.pushGradingCategory(category, weight, categories, seen);
        }
      }
    }

    const hasNumberedExamLines = categories.some((c) =>
      /^(exam|test|quiz|midterm)\s*[#.]?\s*\d+/i.test(String(c.category || '').trim())
    );

    // If the syllabus only states "4 exams at 12% each" (no per-exam lines), expand to one row per exam
    // so each gets its own weight and grade field.
    if (!hasNumberedExamLines) {
      const multiExamPatterns = [
        /(\d+)\s*(?:x|×|\*)\s*(\d{1,3})\s*%\s*(?:each|per|a)?/gi,
        /(\d+)\s*(?:exams?|tests?|quizzes?)\s*(?:at|@|of|:)?\s*(\d{1,3})\s*%\s*(?:each|per|ea\.?)/gi,
        /(?:exam|test)\s*grades?\s*(?:\(|:)?\s*(\d+)\s*(?:x|×|\*)\s*(\d{1,3})\s*%/gi,
      ];
      for (const multiExamRe of multiExamPatterns) {
        let em;
        while ((em = multiExamRe.exec(searchText)) !== null) {
          const count = parseInt(em[1], 10);
          const each = parseInt(em[2], 10);
          if (count >= 1 && count <= 20 && each > 0 && each <= 100) {
            const bundleKey = `multi_exam_${count}_${each}`;
            if (seen.has(bundleKey)) continue;
            seen.add(bundleKey);
            for (let i = 1; i <= count; i++) {
              const label = `Exam ${i}`;
              const rowKey = `${label.toLowerCase()}_${each}_${bundleKey}`;
              if (seen.has(rowKey)) continue;
              seen.add(rowKey);
              categories.push({ category: label, weight: each, isFromMultiCount: true });
            }
          }
        }
      }
    }

    const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
    return {
      categories,
      totalWeight,
      isValid: totalWeight >= 90 && totalWeight <= 110,
    };
  },

  extractExams(text) {
    const exams = [];

    const examPatterns = [
      /(?:midterm|exam|test|final)\s*(?:#?\d*)?\s*[-–:]\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,
      /([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s*[-–:]\s*(?:midterm|exam|test|final)/gi,
      /(?:midterm|exam|test|final)\s*(?:#?\d*)?\s*[-–:on]*\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/gi,
      /(?:midterm|exam|test|final)\s*(?:#?\d*)?\s*.*?(?:on|date|scheduled)\s*(?:for)?\s*[-–:]?\s*([A-Za-z]+\s+\d{1,2})/gi,
    ];

    for (const pattern of examPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const fullMatch = match[0];
        const dateStr = match[1];
        const parsed = new Date(dateStr);

        let type = 'Exam';
        if (/final/i.test(fullMatch)) type = 'Final Exam';
        else if (/midterm/i.test(fullMatch)) type = 'Midterm';

        exams.push({
          type,
          dateRaw: dateStr,
          date: isNaN(parsed.getTime()) ? null : parsed.toISOString(),
          context: fullMatch.trim().substring(0, 100),
        });
      }
    }

    return exams;
  },

  extractScheduledItems(text) {
    const items = [];

    const patterns = [
      /(?:homework|hw|assignment|project|lab|quiz)\s*#?\s*(\d+)?\s*[-–:]\s*(?:due\s*)?([A-Za-z]+\s+\d{1,2},?\s*\d{0,4})/gi,
      /(?:due\s*(?:date|by)?)\s*[-–:]?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s*[-–:]?\s*(.*?)(?:\n|$)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const title = match[0].substring(0, 80).trim();
        const dateStr = match[2] || match[1];
        const parsed = new Date(dateStr);

        items.push({
          title,
          dateRaw: dateStr,
          date: isNaN(parsed.getTime()) ? null : parsed.toISOString(),
          type: this.guessItemType(title),
        });
      }
    }

    return items;
  },

  extractOfficeHours(text) {
    const section = this.extractSection(text, [
      'office hours', 'office hour', 'availability', 'consultation'
    ]);

    if (!section) return null;

    const dayTimePattern = /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|M|T|W|Th|F|MW|TR|MWF)\w*\s*[-–:]?\s*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?\s*[-–to]*\s*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?/gi;
    const matches = section.match(dayTimePattern) || [];

    const locationPattern = /(?:room|office|building|location|rm)\s*[-–:]?\s*([A-Z0-9\s.]+)/i;
    const locationMatch = section.match(locationPattern);

    return {
      times: matches.map(m => m.trim()),
      location: locationMatch ? locationMatch[1].trim() : null,
      rawText: section.substring(0, 300),
    };
  },

  extractCourseInfo(text) {
    const lines = text.split('\n').slice(0, 30);
    const header = lines.join('\n');

    const courseNumPattern = /([A-Z]{2,4})\s*(\d{4})/;
    const courseMatch = header.match(courseNumPattern);

    const instructorPatterns = [
      /(?:instructor|professor|prof\.?|dr\.?)\s*[-–:]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
      /(?:taught by|lecturer)\s*[-–:]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    ];

    let instructor = null;
    for (const p of instructorPatterns) {
      const m = header.match(p);
      if (m) { instructor = m[1].trim(); break; }
    }

    const emailMatch = header.match(/[\w.]+@[\w.]+\.\w+/);
    const semesterMatch = text.match(/(Fall|Spring|Summer)\s*\d{4}/i);

    return {
      courseNumber: courseMatch ? `${courseMatch[1]} ${courseMatch[2]}` : null,
      instructor,
      email: emailMatch ? emailMatch[0] : null,
      semester: semesterMatch ? semesterMatch[0] : null,
    };
  },

  extractWeeklySchedule(text) {
    const schedule = [];
    const weekPattern = /week\s*(\d{1,2})\s*[-–:]?\s*(.*?)(?=week\s*\d|$)/gis;

    let match;
    while ((match = weekPattern.exec(text)) !== null) {
      const weekNum = parseInt(match[1]);
      const content = match[2].trim().substring(0, 200);
      const topics = content.split(/\n|;|,/).map(t => t.trim()).filter(t => t.length > 3);

      schedule.push({
        week: weekNum,
        topics: topics.slice(0, 5),
        raw: content,
      });
    }

    return schedule;
  },

  extractPolicies(text) {
    const policies = {};
    const policyKeys = ['late', 'attendance', 'academic integrity', 'plagiarism', 'extra credit'];

    for (const key of policyKeys) {
      const section = this.extractSection(text, [key]);
      if (section) {
        policies[key] = section.substring(0, 300);
      }
    }

    return policies;
  },

  extractSection(text, keywords) {
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (keywords.some(kw => lower.includes(kw))) {
        const sectionLines = [lines[i]];
        for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
          if (lines[j].trim() === '') {
            sectionLines.push(lines[j]);
            continue;
          }
          const isNewSection = /^[A-Z][A-Z\s]{3,}:?\s*$/.test(lines[j]) ||
                                /^#{1,3}\s/.test(lines[j]);
          if (isNewSection) break;
          sectionLines.push(lines[j]);
        }
        return sectionLines.join('\n').trim();
      }
    }
    return null;
  },

  guessItemType(title) {
    const lower = title.toLowerCase();
    if (/exam|midterm|final/.test(lower)) return 'exam';
    if (/quiz/.test(lower)) return 'quiz';
    if (/project/.test(lower)) return 'project';
    if (/lab/.test(lower)) return 'lab';
    if (/discussion|forum/.test(lower)) return 'discussion';
    return 'assignment';
  },
};

if (typeof module !== 'undefined') {
  module.exports = SyllabusParser;
}
