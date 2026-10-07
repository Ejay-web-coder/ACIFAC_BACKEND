-- Store items sold before sales recorded their cost (032) have no cost, so the
-- Sales History cannot show their cost or net income. Each such item gets the
-- cost price its product has now (the one entered when cost prices became
-- required), and its sale's cost of goods and net income are recomputed:
--   net_sales = goods sold - expenses - cost of goods
-- Each sale changed is written to the audit log with its old and new figures.
-- Items whose product still has no cost price are left as they are.
CREATE TEMP TABLE kadiwa_cost_backfill ON COMMIT DROP AS
SELECT i.id AS item_id, i.sale_id, k.cost_price AS unit_cost, ROUND(i.quantity * k.cost_price, 2) AS line_cost
  FROM kadiwa_sale_items i
  JOIN kadiwa_inventory k ON k.id = i.inventory_id
 WHERE i.unit_cost IS NULL AND k.cost_price IS NOT NULL;

CREATE TEMP TABLE kadiwa_cost_backfill_sales ON COMMIT DROP AS
SELECT s.id AS sale_id, s.cost_of_goods AS old_cost, s.net_sales AS old_net, b.cost
  FROM kadiwa_sales s
  JOIN (SELECT sale_id, SUM(line_cost) AS cost FROM kadiwa_cost_backfill GROUP BY sale_id) b ON b.sale_id = s.id;

UPDATE kadiwa_sale_items i
   SET unit_cost = b.unit_cost, line_cost = b.line_cost
  FROM kadiwa_cost_backfill b
 WHERE i.id = b.item_id;

UPDATE kadiwa_sales s
   SET cost_of_goods = b.old_cost + b.cost, net_sales = b.old_net - b.cost
  FROM kadiwa_cost_backfill_sales b
 WHERE s.id = b.sale_id;

INSERT INTO audit_logs (user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, old_values, new_values, details)
SELECT 'System', 'SYSTEM', 'KADIWA_SALE_COST_ADDED', 'Kadiwa', 'kadiwa_sale', b.sale_id,
       'Added the cost of the store items sold in ' || b.sale_id || ' from the products'' cost prices',
       jsonb_build_object('cost_of_goods', b.old_cost, 'net_sales', b.old_net),
       jsonb_build_object('cost_of_goods', b.old_cost + b.cost, 'net_sales', b.old_net - b.cost,
         'items', (SELECT jsonb_agg(jsonb_build_object('item_id', c.item_id, 'unit_cost', c.unit_cost, 'line_cost', c.line_cost) ORDER BY c.item_id)
                     FROM kadiwa_cost_backfill c WHERE c.sale_id = b.sale_id)),
       jsonb_build_object('migration', '033_kadiwa_cost_backfill.sql')
  FROM kadiwa_cost_backfill_sales b;
