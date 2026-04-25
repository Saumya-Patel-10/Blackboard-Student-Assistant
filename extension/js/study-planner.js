/**
 * Blackboard Student Assistant - Study Planner
 *
 * Generates personalized study plans based on upcoming deadlines,
 * course goals, and available study time.
 */

const StudyPlanner = {

  dueDateOf(a) {
    if (!a) return null;
    return a.dueDateOverride || a.dueDate;
  },

  generatePlan(config) {
    const {
      assignments = [],
      courses = [],
      goals = {},
      studyHoursPerDay = 4,
      studyDays = ['mon', 'tue', 'wed', 'thu', 'fri'],
    } = config;

    const now = new Date();
    const upcoming = assignments
      .filter(a => this.dueDateOf(a) && new Date(this.dueDateOf(a)) > now && !a.submitted)
      .sort((a, b) => new Date(this.dueDateOf(a)) - new Date(this.dueDateOf(b)));

    if (upcoming.length === 0) {
      return {
        weeks: [],
        summary: 'No upcoming deadlines found. Upload your syllabus or sync with Blackboard to get started.',
      };
    }

    const tasks = upcoming.map(a => this.createTask(a, courses, goals));
    const weeks = this.distributeIntoWeeks(tasks, now, studyHoursPerDay, studyDays);
    const summary = this.generateSummary(weeks, goals);

    return { weeks, summary, totalTasks: tasks.length };
  },

  createTask(assignment, courses, goals) {
    const course = courses.find(c => c.id === assignment.courseId);
    const dueDate = new Date(this.dueDateOf(assignment));
    const now = new Date();
    const daysUntilDue = Math.max(0, Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24)));

    let priority = 3;
    if (daysUntilDue <= 1) priority = 1;
    else if (daysUntilDue <= 3) priority = 2;
    else if (daysUntilDue <= 7) priority = 3;
    else priority = 4;

    if (assignment.type === 'exam' || assignment.type === 'midterm') {
      priority = Math.max(1, priority - 1);
    }

    const goalGrade = goals[assignment.courseId];
    if (goalGrade && goalGrade >= 90) {
      priority = Math.max(1, priority - 1);
    }

    const estimatedHours = this.estimateHours(assignment);

    return {
      id: assignment.id,
      title: assignment.title,
      course: course ? course.name : 'Unknown Course',
      courseColor: course ? course.color : '#6b7280',
      dueDate: this.dueDateOf(assignment),
      daysUntilDue,
      priority,
      estimatedHours,
      type: assignment.type,
      completed: false,
    };
  },

  estimateHours(assignment) {
    const typeHours = {
      exam: 6,
      midterm: 5,
      project: 8,
      assignment: 2,
      quiz: 1.5,
      discussion: 1,
      lab: 2,
      reading: 1,
    };

    let hours = typeHours[assignment.type] || 2;

    if (assignment.points) {
      if (assignment.points >= 100) hours *= 1.5;
      else if (assignment.points >= 50) hours *= 1.2;
    }

    return Math.round(hours * 10) / 10;
  },

  distributeIntoWeeks(tasks, startDate, hoursPerDay, studyDays) {
    const weeks = [];
    const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const availableDays = studyDays.map(d => dayMap[d]);

    const sorted = [...tasks].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(this.dueDateOf(a)) - new Date(this.dueDateOf(b));
    });

    let currentWeekStart = new Date(startDate);
    currentWeekStart.setHours(0, 0, 0, 0);
    const dayOfWeek = currentWeekStart.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    currentWeekStart.setDate(currentWeekStart.getDate() + mondayOffset);

    const maxWeeks = 8;

    for (let w = 0; w < maxWeeks; w++) {
      const weekEnd = new Date(currentWeekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

      const weekTasks = sorted.filter(t => {
        const due = new Date(t.dueDate);
        if (w === 0) return due <= weekEnd;
        const prevWeekEnd = new Date(currentWeekStart);
        prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
        return due > prevWeekEnd && due <= weekEnd;
      });

      if (weekTasks.length > 0 || w < 4) {
        const studyDaysInWeek = availableDays.length;
        const totalAvailableHours = studyDaysInWeek * hoursPerDay;

        const dailyPlan = this.createDailyPlan(weekTasks, availableDays, hoursPerDay, currentWeekStart);

        weeks.push({
          weekNumber: w + 1,
          startDate: currentWeekStart.toISOString(),
          endDate: weekEnd.toISOString(),
          label: this.formatWeekLabel(currentWeekStart, weekEnd),
          tasks: weekTasks,
          dailyPlan,
          totalHoursNeeded: weekTasks.reduce((s, t) => s + t.estimatedHours, 0),
          totalAvailableHours,
          isOverloaded: weekTasks.reduce((s, t) => s + t.estimatedHours, 0) > totalAvailableHours,
        });
      }

      currentWeekStart = new Date(currentWeekStart);
      currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    }

    return weeks.filter(w => w.tasks.length > 0);
  },

  createDailyPlan(tasks, availableDays, hoursPerDay, weekStart) {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const plan = [];

    const sortedTasks = [...tasks].sort((a, b) => a.priority - b.priority);
    let taskIndex = 0;
    let remainingFromPrevTask = 0;
    let currentTask = null;

    for (const dayNum of availableDays) {
      const dayDate = new Date(weekStart);
      const offset = (dayNum - weekStart.getDay() + 7) % 7;
      dayDate.setDate(dayDate.getDate() + offset);

      let hoursLeft = hoursPerDay;
      const dayTasks = [];

      if (currentTask && remainingFromPrevTask > 0) {
        const allocated = Math.min(remainingFromPrevTask, hoursLeft);
        dayTasks.push({
          ...currentTask,
          allocatedHours: allocated,
          detail: `Continue: ${currentTask.title}`,
        });
        hoursLeft -= allocated;
        remainingFromPrevTask -= allocated;
        if (remainingFromPrevTask <= 0) {
          currentTask = null;
          taskIndex++;
        }
      }

      while (hoursLeft > 0 && taskIndex < sortedTasks.length) {
        currentTask = sortedTasks[taskIndex];
        const needed = currentTask.estimatedHours;
        const allocated = Math.min(needed, hoursLeft);

        dayTasks.push({
          ...currentTask,
          allocatedHours: allocated,
          detail: `${currentTask.title} (${currentTask.course})`,
        });

        hoursLeft -= allocated;
        remainingFromPrevTask = needed - allocated;

        if (remainingFromPrevTask <= 0) {
          currentTask = null;
          taskIndex++;
        } else {
          break;
        }
      }

      if (dayTasks.length > 0) {
        plan.push({
          day: dayNames[dayNum],
          date: dayDate.toISOString().split('T')[0],
          tasks: dayTasks,
          totalHours: hoursPerDay - hoursLeft,
        });
      }
    }

    return plan;
  },

  formatWeekLabel(start, end) {
    const opts = { month: 'short', day: 'numeric' };
    return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`;
  },

  generateSummary(weeks, goals) {
    if (weeks.length === 0) return 'No tasks to plan. You\'re all caught up!';

    const totalTasks = weeks.reduce((s, w) => s + w.tasks.length, 0);
    const totalHours = weeks.reduce((s, w) => s + w.totalHoursNeeded, 0);
    const overloaded = weeks.filter(w => w.isOverloaded);

    let summary = `📊 Plan covers ${totalTasks} tasks across ${weeks.length} weeks (~${Math.round(totalHours)} study hours total).`;

    if (overloaded.length > 0) {
      summary += ` ⚠️ ${overloaded.length} week(s) may be overloaded — consider starting early.`;
    }

    const goalEntries = Object.entries(goals).filter(([, g]) => g);
    if (goalEntries.length > 0) {
      summary += ` 🎯 Working toward grade targets in ${goalEntries.length} course(s).`;
    }

    return summary;
  },

  getRecommendations(assignments, currentGrades, goals) {
    const recs = [];
    const now = new Date();

    for (const a of assignments) {
      const dd = this.dueDateOf(a);
      if (!dd || a.submitted) continue;
      const due = new Date(dd);
      const hoursLeft = (due - now) / (1000 * 60 * 60);

      if (hoursLeft < 0) {
        recs.push({ type: 'overdue', priority: 1, message: `"${a.title}" is overdue!`, assignment: a });
      } else if (hoursLeft < 24) {
        recs.push({ type: 'urgent', priority: 1, message: `"${a.title}" is due in less than 24 hours`, assignment: a });
      } else if (hoursLeft < 72) {
        recs.push({ type: 'soon', priority: 2, message: `"${a.title}" is due in ${Math.round(hoursLeft / 24)} days`, assignment: a });
      }
    }

    return recs.sort((a, b) => a.priority - b.priority);
  },
};

if (typeof module !== 'undefined') {
  module.exports = StudyPlanner;
}
