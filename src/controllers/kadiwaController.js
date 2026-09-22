import { getPool, query } from '../config/db.js';

const inventorySelect = `
  SELECT id, name, category, stock::numeric AS stock, price::numeric AS price,
         reorder_level::numeric AS "reorderLevel", unit
  FROM kadiwa_inventory`;

const salesSelect = `
  SELECT id, created_at AS date, encoder_name AS encoder,
         groceries::numeric AS groceries, vegetables::numeric AS vegetables,
         meat::numeric AS meat, total_expenses::numeric AS "totalExpenses",
         net_sales::numeric AS "netSales", payment_method AS "paymentMethod", status
  FROM kadiwa_sales`;

export async function listKadiwaData(req, res) {
  try {
    const [inventory, sales] = await Promise.all([
      query(`${inventorySelect} ORDER BY name`),
      query(`${salesSelect} ORDER BY created_at DESC`),
    ]);
    return res.json({ inventory: inventory.rows, sales: sales.rows });
  } catch (error) {
    console.error('List Kadiwa data error:', error);
    return res.status(500).json({ message: 'Unable to load Kadiwa store data.' });
  }
}

export async function createKadiwaSale(req, res) {
  try {
    const { encoderName, groceriesPrice = 0, vegetablesPrice = 0, meatPrice = 0, totalExpenses = 0 } = req.body || {};
    const values = [Number(groceriesPrice), Number(vegetablesPrice), Number(meatPrice), Number(totalExpenses)];
    if (!encoderName?.trim() || values.some((value) => !Number.isFinite(value) || value < 0)) {
      return res.status(400).json({ message: 'Encoder name and valid non-negative amounts are required.' });
    }

    const [groceries, vegetables, meat, expenses] = values;
    const id = `S-${new Date().getFullYear()}-${Date.now()}`;
    const result = await query(
      `INSERT INTO kadiwa_sales (id, encoder_name, groceries, vegetables, meat, total_expenses, net_sales, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [id, encoderName.trim(), groceries, vegetables, meat, expenses, groceries + vegetables + meat - expenses, req.user.user_id]
    );
    const sale = await query(`${salesSelect} WHERE id = $1`, [result.rows[0].id]);
    return res.status(201).json({ sale: sale.rows[0] });
  } catch (error) {
    console.error('Create Kadiwa sale error:', error);
    return res.status(500).json({ message: 'Unable to save sale.' });
  }
}

export async function createInventoryItem(req, res) {
  try {
    const { name, category = 'Groceries', stock = 0, price = 0, reorderLevel = 10, unit = 'kg' } = req.body || {};
    const numericValues = [Number(stock), Number(price), Number(reorderLevel)];
    if (!name?.trim() || !['Groceries', 'Vegetables', 'Meat', 'Other'].includes(category) || numericValues.some((value) => !Number.isFinite(value) || value < 0) || !unit?.trim()) {
      return res.status(400).json({ message: 'Valid inventory details are required.' });
    }

    const id = `INV-${Date.now()}`;
    await query(
      `INSERT INTO kadiwa_inventory (id, name, category, stock, price, reorder_level, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name.trim(), category, numericValues[0], numericValues[1], numericValues[2], unit.trim()]
    );
    const item = await query(`${inventorySelect} WHERE id = $1`, [id]);
    return res.status(201).json({ item: item.rows[0] });
  } catch (error) {
    console.error('Create Kadiwa inventory error:', error);
    return res.status(500).json({ message: 'Unable to save inventory item.' });
  }
}

export async function restockInventoryItem(req, res) {
  const client = await getPool().connect();
  try {
    const quantity = Number(req.body?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ message: 'Restock quantity must be greater than zero.' });

    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE kadiwa_inventory SET stock = stock + $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
      [quantity, req.params.id]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Inventory item not found.' });
    }
    await client.query('COMMIT');
    const item = await query(`${inventorySelect} WHERE id = $1`, [req.params.id]);
    return res.json({ item: item.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Restock Kadiwa inventory error:', error);
    return res.status(500).json({ message: 'Unable to restock inventory item.' });
  } finally {
    client.release();
  }
}
