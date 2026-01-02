/**
 * RYAN - Session Orchestrator
 * Analyzes phases, milestones, todos, bugs and recommends what to work on
 */

const db = require('../lib/db');

async function getSessionRecommendation() {
  const query = `
    WITH milestone_phases AS (
      SELECT 
        g.name as milestone,
        g.target_date,
        g.priority as milestone_priority,
        gr.phase_id,
        gr.is_critical,
        EXTRACT(DAY FROM g.target_date - CURRENT_DATE) as days_until
      FROM dev_project_goals g
      JOIN dev_goal_requirements gr ON gr.goal_id = g.id
      WHERE g.status = 'active'
    ),
    phase_work AS (
      SELECT 
        ph.id as phase_id,
        p.name as project,
        ph.phase_num,
        ph.name as phase_name,
        ph.status,
        COALESCE(t.todo_count, 0) as open_todos,
        COALESCE(b.bug_count, 0) as open_bugs
      FROM dev_project_phases ph
      JOIN dev_projects p ON ph.project_id = p.id
      LEFT JOIN (
        SELECT phase_id, COUNT(*) as todo_count 
        FROM dev_ai_todos WHERE status NOT IN ('completed','done') 
        GROUP BY phase_id
      ) t ON t.phase_id = ph.id
      LEFT JOIN (
        SELECT phase_id, COUNT(*) as bug_count 
        FROM dev_ai_bugs WHERE status = 'open' 
        GROUP BY phase_id
      ) b ON b.phase_id = ph.id
    ),
    blocked AS (
      SELECT 
        d.phase_id,
        p2.name || ' P' || ph2.phase_num as blocked_by
      FROM dev_phase_dependencies d
      JOIN dev_project_phases ph2 ON d.depends_on_phase_id = ph2.id
      JOIN dev_projects p2 ON ph2.project_id = p2.id
      WHERE ph2.status NOT IN ('finalized', 'completed')
      AND d.dependency_type = 'blocks'
    )
    SELECT 
      pw.project,
      pw.phase_num,
      pw.phase_name,
      pw.status,
      pw.open_todos,
      pw.open_bugs,
      mp.milestone,
      mp.days_until,
      mp.is_critical,
      bl.blocked_by,
      CASE 
        WHEN bl.blocked_by IS NOT NULL THEN -100
        WHEN pw.status = 'in_progress' THEN 50
        ELSE 0
      END +
      CASE WHEN mp.days_until <= 14 THEN 40
           WHEN mp.days_until <= 30 THEN 25
           WHEN mp.days_until <= 60 THEN 10
           ELSE 0 END +
      pw.open_bugs * 10 +
      pw.open_todos * 5 +
      CASE WHEN mp.is_critical THEN 20 ELSE 0 END as priority_score
    FROM phase_work pw
    LEFT JOIN milestone_phases mp ON mp.phase_id = pw.phase_id
    LEFT JOIN blocked bl ON bl.phase_id = pw.phase_id
    WHERE pw.phase_num <= 3
    ORDER BY priority_score DESC, pw.project, pw.phase_num
    LIMIT 15;
  `;

  try {
    const result = await db.query(query);
    return formatRecommendation(result.rows);
  } catch (err) {
    console.error('Ryan error:', err);
    return { error: err.message };
  }
}

function formatRecommendation(rows) {
  const active = rows.filter(r => r.milestone && r.priority_score > 0 && !r.blocked_by);
  const blocked = rows.filter(r => r.blocked_by);
  const nextMilestone = active[0]?.milestone || 'None';
  const daysUntil = active[0]?.days_until || '?';

  let output = `
══════════════════════════════════════════════════════════
  RYAN - SESSION RECOMMENDATION
══════════════════════════════════════════════════════════

ACTIVE MILESTONE: ${nextMilestone} (${daysUntil} days)

WORK ON TODAY (priority order):
`;

  active.slice(0, 5).forEach((r, i) => {
    const work = [];
    if (r.open_bugs > 0) work.push(`${r.open_bugs} bugs`);
    if (r.open_todos > 0) work.push(`${r.open_todos} todos`);
    const workStr = work.length ? ` [${work.join(', ')}]` : '';
    output += `  ${i+1}. ${r.project} P${r.phase_num} - ${r.phase_name.substring(0,35)}${workStr}\n`;
    output += `     Status: ${r.status} | Score: ${r.priority_score}\n`;
  });

  if (blocked.length > 0) {
    output += `\nBLOCKED (skip today):\n`;
    blocked.forEach(r => {
      output += `  ✗ ${r.project} P${r.phase_num} ← blocked by ${r.blocked_by}\n`;
    });
  }

  output += `══════════════════════════════════════════════════════════\n`;
  
  return { text: output, data: { active, blocked, milestone: nextMilestone, daysUntil } };
}

module.exports = { getSessionRecommendation };
