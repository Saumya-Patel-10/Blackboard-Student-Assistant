/**
 * Blackboard Student Assistant - Grade Calculator
 *
 * Calculates weighted course grades based on grading categories,
 * computes what-if scenarios, and determines needed scores.
 */

const GradeCalculator = {

  /**
   * Map Blackboard grade items to syllabus categories; average multiple items per category.
   * @param {Array<{category:string,weight:number}>} categories
   * @param {Array<{name:string,percentage?:string,score?:number,total?:number}>} grades
   */
  suggestCategoryScores(categories, grades) {
    const list = (grades || []).filter(g => g && g.name);
    const result = categories.map((cat) => ({ ...cat, score: null, matchedItems: [] }));

    for (const g of list) {
      const pct =
        g.percentage != null && g.percentage !== ''
          ? parseFloat(String(g.percentage).replace(/%/g, ''))
          : g.score != null && g.total
            ? (g.score / g.total) * 100
            : null;
      if (pct == null || isNaN(pct)) continue;

      const idx = this.matchGradeToCategory(g.name, categories);
      if (idx >= 0) {
        result[idx].matchedItems.push({ name: g.name, pct });
      }
    }

    for (const row of result) {
      if (row.matchedItems.length === 0) continue;
      const sum = row.matchedItems.reduce((s, m) => s + m.pct, 0);
      row.score = Math.round((sum / row.matchedItems.length) * 100) / 100;
    }

    return result.map(({ category, weight, score }) => ({ category, weight, score }));
  },

  matchGradeToCategory(gradeName, categories) {
    const n = gradeName.toLowerCase();
    for (let i = 0; i < categories.length; i++) {
      const label = (categories[i].category || '').toLowerCase();
      if (this.gradeMatchesCategoryLabel(n, label)) return i;
    }
    return -1;
  },

  gradeMatchesCategoryLabel(gradeNameLower, categoryLabelLower) {
    if (!categoryLabelLower) return false;
    if (/exam|exams|midterm|final|test/.test(categoryLabelLower) && /exam|midterm|final|test|quiz\s*\d/.test(gradeNameLower)) {
      if (/quiz/.test(gradeNameLower) && !/quiz/.test(categoryLabelLower)) return false;
      return true;
    }
    if (/quiz/.test(categoryLabelLower) && /quiz|^q\d|\bquiz\b/.test(gradeNameLower)) return true;
    if (/(homework|assignment|hw)/.test(categoryLabelLower) && /homework|hw\d|assignment|\bhw\b/.test(gradeNameLower)) {
      return true;
    }
    if (/project/.test(categoryLabelLower) && /project/.test(gradeNameLower)) return true;
    if (/lab/.test(categoryLabelLower) && /\blab\b/.test(gradeNameLower)) return true;
    if (/(participat|discussion|attendance)/.test(categoryLabelLower) && /participat|discussion|attendance|forum|post/.test(gradeNameLower)) {
      return true;
    }
    const words = categoryLabelLower.split(/[^a-z0-9]+/).filter(w => w.length > 3);
    for (const w of words) {
      if (gradeNameLower.includes(w)) return true;
    }
    return false;
  },

  /**
   * Parse a grade cell: plain percent (0–100) or fraction earned/total (e.g. 80/100).
   * @param {string|number|null|undefined} raw
   * @returns {{ scorePercent: number|null }}
   */
  parseScoreInput(raw) {
    if (raw === null || raw === undefined) return { scorePercent: null };
    const s = String(raw).trim();
    if (!s) return { scorePercent: null };

    const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
    if (frac) {
      const num = parseFloat(frac[1]);
      const den = parseFloat(frac[2]);
      if (!isFinite(num) || !isFinite(den) || den === 0) return { scorePercent: null };
      return { scorePercent: (num / den) * 100 };
    }

    const n = parseFloat(s.replace(/%/g, ''));
    if (!isNaN(n) && isFinite(n)) return { scorePercent: n };
    return { scorePercent: null };
  },

  syllabusTotalWeight(categories) {
    const list = categories || [];
    return list.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0);
  },

  /**
   * Course % uses the full syllabus scale (weights should sum to ~100).
   * Empty categories contribute 0; scored rows use (score%/100) × weight.
   */
  calculate(categories) {
    const syllabusWeight = this.syllabusTotalWeight(categories);
    if (syllabusWeight <= 0) {
      return { percentage: 0, letter: 'N/A', totalWeight: 0, syllabusTotalWeight: 0 };
    }

    let earnedWeighted = 0;

    for (const cat of categories) {
      if (cat.score !== null && cat.score !== undefined && cat.weight > 0) {
        earnedWeighted += (cat.score / 100) * cat.weight;
      }
    }

    const percentage = (earnedWeighted / syllabusWeight) * 100;

    return {
      percentage: Math.round(percentage * 100) / 100,
      letter: this.toLetter(percentage),
      totalWeight: syllabusWeight,
      syllabusTotalWeight: syllabusWeight,
      weightedScore: Math.round(earnedWeighted * 100) / 100,
    };
  },

  /** Assign short codes (E1, A1, …) for drop lists and exam targeting. */
  assignCategoryCodes(categories) {
    let aCount = 0;
    let eCount = 0;
    let qCount = 0;
    return (categories || []).map((cat) => {
      const name = String(cat.category || '').trim();
      const lower = name.toLowerCase();
      let code;
      const examNum = name.match(/\b(?:exam|test|midterm|final)\s*#?\s*(\d+)\b/i);
      const hwNum = name.match(/\b(?:hw|homework|assignment|assign)\s*#?\s*(\d+)\b/i);
      if (examNum) code = `E${examNum[1]}`;
      else if (/exam|midterm|final/.test(lower)) {
        eCount += 1;
        code = `E${eCount}`;
      } else if (hwNum) code = `A${hwNum[1]}`;
      else if (/homework|assignment|\bhw\b|assignments/.test(lower)) {
        aCount += 1;
        code = `A${aCount}`;
      } else if (/quiz/.test(lower)) {
        qCount += 1;
        code = `Q${qCount}`;
      } else {
        const abbr = (name.replace(/[^a-z0-9]/gi, '').slice(0, 2) || 'OT').toUpperCase();
        code = `${abbr}${eCount + aCount + qCount + 1}`;
      }
      return { ...cat, code };
    });
  },

  parseDroppedCodes(raw) {
    return String(raw || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  },

  filterDroppedCategories(categories, droppedCodes) {
    if (!droppedCodes?.length) return categories || [];
    const drop = new Set(droppedCodes.map((c) => c.toUpperCase()));
    return (categories || []).filter((c) => !drop.has(String(c.code || '').toUpperCase()));
  },

  /**
   * Score (0–100) needed on one category to reach target course %.
   * Other categories use entered scores (empty = 0).
   */
  calculateNeededOnCategory(categories, targetGrade, categoryCode) {
    const code = String(categoryCode || '').trim().toUpperCase();
    const list = categories || [];
    const target = list.find((c) => String(c.code || '').toUpperCase() === code);
    if (!target) {
      return { possible: false, message: `No category with code "${categoryCode}". Check the code column.` };
    }
    const syllabusWeight = this.syllabusTotalWeight(list);
    if (syllabusWeight <= 0) {
      return { possible: false, message: 'No category weights loaded.' };
    }

    let earned = 0;
    for (const cat of list) {
      if (String(cat.code || '').toUpperCase() === code) continue;
      if (cat.score !== null && cat.score !== undefined) {
        earned += (cat.score / 100) * cat.weight;
      }
    }

    const neededWeighted = (targetGrade / 100) * syllabusWeight - earned;
    const neededScore = (neededWeighted / target.weight) * 100;
    const current = (earned / syllabusWeight) * 100;

    if (neededScore > 100) {
      return {
        possible: false,
        neededScore: Math.round(neededScore * 100) / 100,
        neededFraction: null,
        currentPercentage: Math.round(current * 100) / 100,
        targetCategory: target.category,
        targetCode: target.code,
        message: `You would need ${neededScore.toFixed(1)}% on ${target.category} (${target.code}) — above 100%, so ${targetGrade}% may not be achievable with your other scores.`,
      };
    }

    return {
      possible: neededScore >= 0,
      neededScore: Math.round(neededScore * 100) / 100,
      neededFraction: `${neededScore.toFixed(1)}/100`,
      currentPercentage: Math.round(current * 100) / 100,
      targetCategory: target.category,
      targetCode: target.code,
      message:
        neededScore < 0
          ? `You already exceed ${targetGrade}% before ${target.category} (${target.code}). Current course grade from other work: ~${current.toFixed(1)}%.`
          : `To reach ${targetGrade}% overall, you need ${neededScore.toFixed(1)}% on ${target.category} (${target.code}) — about ${neededScore.toFixed(1)}/100 on that item.`,
    };
  },

  calculateNeeded(categories, targetGrade) {
    const syllabusWeight = this.syllabusTotalWeight(categories);
    if (syllabusWeight <= 0) {
      return {
        possible: false,
        neededAverage: null,
        currentPercentage: 0,
        message: 'Add category weights from your syllabus (they should sum to about 100%).',
      };
    }

    let earnedWeighted = 0;
    let remainingWeight = 0;
    const remaining = [];

    for (const cat of categories) {
      if (cat.score !== null && cat.score !== undefined) {
        earnedWeighted += (cat.score / 100) * cat.weight;
      } else {
        remainingWeight += cat.weight;
        remaining.push(cat);
      }
    }

    const current = (earnedWeighted / syllabusWeight) * 100;

    if (remainingWeight === 0) {
      return {
        possible: current >= targetGrade,
        neededAverage: null,
        currentPercentage: Math.round(current * 100) / 100,
        message: current >= targetGrade
          ? `You already have ${current.toFixed(1)}% — you've met your target!`
          : `Your current grade is ${current.toFixed(1)}% with no remaining work.`,
      };
    }

    const neededWeighted = (targetGrade / 100) * syllabusWeight - earnedWeighted;
    const neededAvg = (neededWeighted / remainingWeight) * 100;

    return {
      possible: neededAvg <= 100,
      neededAverage: Math.round(neededAvg * 100) / 100,
      currentPercentage: Math.round(current * 100) / 100,
      remainingCategories: remaining.map(r => r.category),
      message: neededAvg <= 100
        ? `You need an average of ${neededAvg.toFixed(1)}% on remaining work (${remaining.map(r => r.category).join(', ')})`
        : `You would need ${neededAvg.toFixed(1)}% average on remaining work — exceeds 100%, so this target may not be achievable.`,
    };
  },

  whatIf(categories, hypothetical) {
    const merged = categories.map(cat => {
      const hypo = hypothetical.find(h => h.category === cat.category);
      return hypo ? { ...cat, score: hypo.score } : cat;
    });
    return this.calculate(merged);
  },

  toLetter(pct) {
    if (pct >= 97) return 'A+';
    if (pct >= 93) return 'A';
    if (pct >= 90) return 'A-';
    if (pct >= 87) return 'B+';
    if (pct >= 83) return 'B';
    if (pct >= 80) return 'B-';
    if (pct >= 77) return 'C+';
    if (pct >= 73) return 'C';
    if (pct >= 70) return 'C-';
    if (pct >= 67) return 'D+';
    if (pct >= 63) return 'D';
    if (pct >= 60) return 'D-';
    return 'F';
  },

  generateReport(categories) {
    const result = this.calculate(categories);
    const syllabusWeight = result.syllabusTotalWeight ?? this.syllabusTotalWeight(categories);
    const completed = categories.filter(c => c.score !== null && c.score !== undefined);
    const pending = categories.filter(c => c.score === null || c.score === undefined);

    return {
      ...result,
      completedCategories: completed.length,
      totalCategories: categories.length,
      pendingCategories: pending.map(p => p.category),
      breakdown: categories.map(cat => ({
        category: cat.category,
        weight: cat.weight,
        score: cat.score,
        contribution: cat.score !== null && cat.score !== undefined
          ? Math.round(((cat.score / 100) * cat.weight) * 100) / 100
          : null,
        contributionPercentOfCourse: cat.score !== null && cat.score !== undefined && syllabusWeight > 0
          ? Math.round((((cat.score / 100) * cat.weight) / syllabusWeight) * 10000) / 100
          : null,
      })),
    };
  },
};

if (typeof module !== 'undefined') {
  module.exports = GradeCalculator;
}
