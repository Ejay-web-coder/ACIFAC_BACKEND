import { query } from '../config/db.js';
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

export async function kadiwaProductAnalytics(from, to) {
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
       WHERE k.deleted_at IS NULL
       GROUP BY k.id`,
      [from, end]
    ),
    query(
      `SELECT g.name, g.unit, COALESCE(SUM(g.quantity), 0) AS quantity, SUM(g.amount) AS amount, COUNT(DISTINCT s.sale_date) AS sale_days
       FROM kadiwa_sale_goods g JOIN kadiwa_sales s ON s.id = g.sale_id AND s.status = 'completed'
       WHERE s.sale_date BETWEEN $1::date AND $2::date
       GROUP BY g.name, g.unit`,
      [from, end]
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
