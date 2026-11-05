import { query } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { todayDateOnly } from '../utils/dates.js';

// Kadiwa products in Analytics, for a period (from - to, the end at today at
// the latest):
//   bestSellers  what brought in the most money: store items and the day's
//                goods (pork, eggs, vegetables) together, by sales amount
//   runningOut   store items that sold and will run out soon at the period's
//                pace: stock now / (quantity sold / days in the period), or
//                are already at or below their low-stock level

const RUNNING_OUT_DAYS = 14;
const LIST_SIZE = 5;
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const label = (row) => (row.size_value !== null && row.size_unit ? `${row.name} ${Number(row.size_value)} ${row.size_unit}` : row.name);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

// branchId: one branch's products and sales; null for every branch.
export async function kadiwaProductAnalytics(from, to, branchId = null) {
  const today = todayDateOnly();
  const end = to > today ? today : to;
  const days = end < from ? 0 : daysBetween(from, end);
  const [items, goods] = await Promise.all([
    query(
      `SELECT k.id, k.name, k.size_value, k.size_unit, k.unit, k.stock, k.reorder_level,
              COALESCE(SUM(i.quantity) FILTER (WHERE s.sale_date BETWEEN $1::date AND $2::date), 0) AS quantity,
              COALESCE(SUM(i.line_total) FILTER (WHERE s.sale_date BETWEEN $1::date AND $2::date), 0) AS amount,
              COUNT(DISTINCT s.sale_date) FILTER (WHERE s.sale_date BETWEEN $1::date AND $2::date) AS sale_days
       FROM kadiwa_inventory k
       LEFT JOIN kadiwa_sale_items i ON i.inventory_id = k.id
       LEFT JOIN kadiwa_sales s ON s.id = i.sale_id AND s.status = 'completed'
       WHERE k.deleted_at IS NULL AND ($3::int IS NULL OR k.branch_id = $3)
       GROUP BY k.id`,
      [from, end, branchId]
    ),
    query(
      `SELECT g.name, g.unit, COALESCE(SUM(g.quantity), 0) AS quantity, SUM(g.amount) AS amount, COUNT(DISTINCT s.sale_date) AS sale_days
       FROM kadiwa_sale_goods g JOIN kadiwa_sales s ON s.id = g.sale_id AND s.status = 'completed'
       WHERE s.sale_date BETWEEN $1::date AND $2::date AND ($3::int IS NULL OR s.branch_id = $3)
       GROUP BY g.name, g.unit`,
      [from, end, branchId]
    ),
  ]);

  const store = items.rows.map((row) => {
    const quantity = Number(row.quantity);
    const stock = Number(row.stock);
    const perDay = days > 0 ? quantity / days : 0;
    return {
      id: row.id, name: label(row), kind: 'store', unit: row.unit, stock, reorderLevel: Number(row.reorder_level),
      quantity, amount: Number(row.amount), saleDays: Number(row.sale_days),
      perDay: round(perDay), daysLeft: perDay > 0 ? Math.floor(stock / perDay) : null,
    };
  });
  const sold = [...store.filter((item) => item.amount > 0), ...goods.rows.map((row) => ({
    id: null, name: row.name, kind: 'goods', unit: row.unit, quantity: Number(row.quantity), amount: Number(row.amount), saleDays: Number(row.sale_days),
  }))];
  const totalSales = round(sold.reduce((sum, item) => sum + item.amount, 0));

  const bestSellers = sold.sort((a, b) => b.amount - a.amount).slice(0, LIST_SIZE)
    .map((item) => ({ ...item, share: totalSales > 0 ? round((item.amount / totalSales) * 100, 1) : 0 }));
  const runningOut = store
    .filter((item) => item.quantity > 0 && (item.stock <= item.reorderLevel || (item.daysLeft !== null && item.daysLeft <= RUNNING_OUT_DAYS)))
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || b.perDay - a.perDay)
    .slice(0, LIST_SIZE);

  return {
    period: { from, to: end, days },
    summary: { totalSales, storeItems: store.length, storeItemsSold: store.filter((item) => item.quantity > 0).length },
    bestSellers, runningOut,
    runningOutDays: RUNNING_OUT_DAYS,
  };
}

// Kadiwa sales, expenses and net income for the chart, for one branch or every
// branch (branchId null). A period inside one calendar month is shown day by
// day (every day up to today, or the last sale if later, with 0 on days without
// a sale); longer periods month by month. gross is the goods sold; sales (the
// net income) is gross - expenses - costOfGoods.
export async function kadiwaSalesTrend(from, to, branchId = null) {
  const inBranch = '($3::int IS NULL OR ks.branch_id = $3)';
  const result = from.slice(0, 7) === to.slice(0, 7)
    ? await query(`
      WITH days AS (
        SELECT generate_series($1::date, LEAST($2::date, GREATEST(${SQL_TODAY},
                 (SELECT MAX(ks.sale_date) FROM kadiwa_sales ks WHERE ks.sale_date BETWEEN $1::date AND $2::date AND ks.status = 'completed' AND ${inBranch}))), INTERVAL '1 day')::date AS day
      )
      SELECT TO_CHAR(d.day, 'Mon FMDD') AS period,
             COALESCE(SUM(ks.groceries + ks.vegetables + ks.meat), 0) AS gross, COALESCE(SUM(ks.cost_of_goods), 0) AS "costOfGoods",
             COALESCE(SUM(ks.net_sales), 0) AS sales, COALESCE(SUM(ks.total_expenses), 0) AS expenses, COUNT(ks.id)::int AS transactions
      FROM days d LEFT JOIN kadiwa_sales ks ON ks.sale_date = d.day AND ks.status = 'completed' AND ${inBranch}
      GROUP BY d.day ORDER BY d.day`, [from, to, branchId])
    : await query(`
      SELECT TO_CHAR(DATE_TRUNC('month', ks.sale_date), 'Mon YYYY') AS period,
             COALESCE(SUM(ks.groceries + ks.vegetables + ks.meat), 0) AS gross, COALESCE(SUM(ks.cost_of_goods), 0) AS "costOfGoods",
             COALESCE(SUM(ks.net_sales), 0) AS sales, COALESCE(SUM(ks.total_expenses), 0) AS expenses, COUNT(*)::int AS transactions
      FROM kadiwa_sales ks WHERE ks.sale_date BETWEEN $1::date AND $2::date AND ks.status = 'completed' AND ${inBranch}
      GROUP BY DATE_TRUNC('month', ks.sale_date) ORDER BY DATE_TRUNC('month', ks.sale_date)`, [from, to, branchId]);
  return result.rows.map((row) => ({
    period: row.period, gross: Number(row.gross), costOfGoods: Number(row.costOfGoods), sales: Number(row.sales), expenses: Number(row.expenses), transactions: Number(row.transactions),
  }));
}
