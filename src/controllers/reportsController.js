// Rodada 19B: /api/reports/* — weekly report.
const reportService = require('../services/reports/reportService');
const { ok } = require('../utils/apiResponse');

// GET /api/reports/weeks -> last 12 complete weeks
const weeks = async (req, res) => ok(res, { weeks: reportService.listWeeks() });

// GET /api/reports/weekly?week=AAAA-MM-DD (Monday; default = last complete week)
const weekly = async (req, res) => {
  const report = await reportService.buildWeeklyReport(req.userId, req.query.week || null);
  return ok(res, { report, text: reportService.reportText(report) });
};

module.exports = { weeks, weekly };