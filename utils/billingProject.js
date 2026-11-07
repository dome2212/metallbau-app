const { dbQuery } = require("./db");
const isPg = !!process.env.DATABASE_URL;
async function projectItems(id) {
  const hoursRes = await (
    isPg
      ? dbQuery(
          `
          SELECT users.username,
                 SUM(CASE WHEN tl_in.type = 'IN' THEN EXTRACT(EPOCH FROM (tl_out.ts - tl_in.timestamp)) / 3600 ELSE 0 END) AS hours
          FROM time_logs tl_in
          JOIN users ON tl_in.user_id = users.id
          LEFT JOIN LATERAL (
            SELECT timestamp AS ts FROM time_logs
            WHERE user_id = tl_in.user_id AND project_id = tl_in.project_id
              AND type = 'OUT' AND timestamp > tl_in.timestamp
            ORDER BY timestamp ASC LIMIT 1
          ) tl_out ON true
          WHERE tl_in.project_id = $1 AND tl_in.type = 'IN'
          GROUP BY users.username
        `,
          [id],
        )
      : dbQuery(
          `
          SELECT u.username,
                 SUM(
                   CASE WHEN tl_in.type = 'IN' THEN
                     (JULIANDAY((
                       SELECT tl_out.timestamp FROM time_logs tl_out
                       WHERE tl_out.user_id = tl_in.user_id
                         AND tl_out.project_id = tl_in.project_id
                         AND tl_out.type = 'OUT'
                         AND tl_out.timestamp > tl_in.timestamp
                       ORDER BY tl_out.timestamp ASC LIMIT 1
                     )) - JULIANDAY(tl_in.timestamp)) * 24
                   ELSE 0 END
                 ) AS hours
          FROM time_logs tl_in
          JOIN users u ON tl_in.user_id = u.id
          WHERE tl_in.project_id = ? AND tl_in.type = 'IN'
          GROUP BY u.username
        `,
          [id],
        )
  ).catch(() => ({ rows: [] }));

  const hourRows = (hoursRes.rows || [])
    .filter((r) => parseFloat(r.hours) > 0)
    .map((r) => ({ ...r, hours: Math.round(parseFloat(r.hours) * 100) / 100 }));

  return hourRows.map((row) => ({
    description: "Arbeitsstunden – " + row.username,
    quantity: row.hours,
    unit: "Std",
    price: 0,
    discount_percent: 0,
  }));
}
module.exports = { projectItems };
