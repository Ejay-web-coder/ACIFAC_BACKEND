// Unit tests for reading the printed Kadiwa forms back (no database, no AI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readInventoryForm, readSalesForm } from '../src/services/kadiwaFormReading.js';
import { buildAnalysisPrompt, normalizeExtractedData, publicFormDefinitions } from '../src/services/documentRouting.js';

test('inventory form: sizes, units and amounts are normalised', () => {
  const reading = readInventoryForm({
    confidence: '92%', category: 'groceries', lowStockAt: '5', grandTotal: '1,690.00',
    rows: [
      { line: 1, product: 'Century Tuna', sizeValue: '150g', quantity: '24 pcs', sellingPrice: '₱38.00', costPrice: '35', total: '840' },
      { line: 2, product: 'Toyo', sizeValue: '1', sizeUnit: 'l', quantity: '10', unit: 'bottles', sellingPrice: '90', costPrice: '85', total: '850' },
      { line: 3, product: '', quantity: '', sellingPrice: '', costPrice: '' },
    ],
  });
  assert.equal(reading.confidence, 92);
  assert.equal(reading.category, 'Groceries');
  assert.equal(reading.rows.length, 2);
  assert.deepEqual(reading.rows[0], { line: 1, name: 'Century Tuna', sizeValue: '150', sizeUnit: 'g', unit: 'pc', stock: '24', price: '38', costPrice: '35', total: '840' });
  assert.equal(reading.rows[1].sizeUnit, 'L');
  assert.equal(reading.rows[1].unit, 'bottle');
  assert.deepEqual(reading.warnings, []);
});

test('inventory form: wrong line totals, a wrong grand total and products already in stock are pointed out', () => {
  const reading = readInventoryForm({
    grandTotal: '2000',
    rows: [
      { line: 1, product: 'Century Tuna', sizeValue: '150', sizeUnit: 'g', quantity: '24', unit: 'pc', sellingPrice: '38', costPrice: '35', total: '850' },
      { line: 2, product: 'Sardinas', quantity: '10', unit: 'can', sellingPrice: '20', costPrice: '' },
    ],
  }, [{ name: 'CENTURY TUNA', sizeValue: '150.000', sizeUnit: 'g' }]);
  const text = reading.warnings.join('\n');
  assert.match(text, /Line 1 \(Century Tuna\): 24 × PHP 35\.00 = PHP 840\.00, but the form says PHP 850\.00/);
  assert.match(text, /Line 2 \(Sardinas\): the cost price could not be read/);
  assert.match(text, /Line 1 \(Century Tuna\): already in the inventory/);
  assert.match(text, /TOTAL on the form says PHP 2,000\.00/);
});

const GOODS = [
  { name: 'PORK', unit: 'KILO', price: '400.00', category: 'Meat' },
  { name: 'TALONG', unit: 'KILO', price: '100.00', category: 'Vegetables' },
];
const PRODUCTS = [{ id: 'INV-0001', name: 'Century Tuna', label: 'Century Tuna 150 g', price: '38.00', stock: '20', costPrice: '35.00' }];

test('sales form: goods, store items and expenses are matched and checked', () => {
  const reading = readSalesForm({
    confidence: 88, saleDate: '10/20/2026', preparedBy: 'Ana Cruz',
    goods: [
      { name: 'pork', unit: 'kilo', price: '400', quantity: '2.5', amount: '1000' },
      { name: 'Talong', quantity: '', amount: '-' },
      { name: 'Patola', unit: 'kilo', price: '20', quantity: '', amount: '60' },
    ],
    storeItems: [{ inventoryId: 'inv-0001', product: 'Century Tuna 150 g', quantity: '3', amount: '114' }, { product: 'Unknown Soap', quantity: '2' }],
    expenses: [{ description: 'Transportation', amount: '150' }],
    totals: { goodsSold: '1174', expenses: '150', netIncome: '1024' },
  }, GOODS, PRODUCTS);
  assert.equal(reading.saleDate, '2026-10-20');
  assert.deepEqual(reading.goods.map((good) => [good.name, good.category, good.listed]), [['PORK', 'Meat', true], ['PATOLA', 'Other', false]]);
  assert.deepEqual(reading.items, [{ inventoryId: 'INV-0001', label: 'Century Tuna 150 g', quantity: '3' }]);
  assert.deepEqual(reading.expenses, [{ description: 'Transportation', amount: '150' }]);
  assert.equal(reading.totals.goodsSold, '1174.00');
  const text = reading.warnings.join('\n');
  assert.match(text, /PATOLA is not on the printed list/);
  assert.match(text, /Unknown Soap/);
  assert.doesNotMatch(text, /TOTAL GOODS SOLD/);
});

test('sales form: arithmetic that does not add up and a future date are pointed out', () => {
  const reading = readSalesForm({
    saleDate: '2099-01-01',
    goods: [{ name: 'PORK', price: '400', quantity: '2', amount: '900' }],
    storeItems: [{ inventoryId: 'INV-0001', quantity: '30' }],
    expenses: [{ description: 'Ice', amount: '' }],
    totals: { goodsSold: '5000', expenses: '0', netIncome: '4000' },
  }, GOODS, PRODUCTS);
  const text = reading.warnings.join('\n');
  assert.equal(reading.saleDate, '');
  assert.match(text, /PORK: 2 × PHP 400\.00 = PHP 800\.00, but the form says PHP 900\.00/);
  assert.match(text, /only 20 are in stock/);
  assert.match(text, /Expense 1: the amount could not be read/);
  assert.match(text, /TOTAL GOODS SOLD on the form says PHP 5,000\.00/);
  assert.match(text, /is in the future/);
});

test('OCR scanner: the Kadiwa forms are document types with line tables', () => {
  const forms = publicFormDefinitions();
  const inventory = forms.find((form) => form.type === 'Add Inventory Form');
  const sales = forms.find((form) => form.type === 'Kadiwa Daily Sales Form');
  assert.equal(inventory.module, 'kadiwa');
  assert.deepEqual(inventory.tables.map((lines) => lines.id), ['line']);
  assert.deepEqual(sales.tables.map((lines) => lines.id), ['good', 'store', 'expense']);
  assert.ok(sales.fields.some((field) => field.key === 'store3Code'));
  assert.equal(forms.find((form) => form.type === 'Kadiwa Sales Form').legacy, true);

  const prompt = buildAnalysisPrompt('upload');
  assert.match(prompt, /"Add Inventory Form".*KADIWA-INV.*line<n>CostPrice/);
  assert.match(prompt, /"Kadiwa Daily Sales Form".*KADIWA-SALES.*store<n>Code/);
  assert.doesNotMatch(prompt, /"Kadiwa Sales Form"/);
});

test('OCR scanner: empty line cells are left out of the reading', () => {
  const data = normalizeExtractedData('Kadiwa Daily Sales Form', { saleDate: '10/20/2026', good1Name: 'PORK', good1Amount: '₱1,000.00', good2Name: '', store1Code: 'INV-0001', store1Quantity: '3' });
  assert.deepEqual(Object.fromEntries(Object.entries(data).filter(([, value]) => value)), { saleDate: '2026-10-20', good1Name: 'PORK', good1Amount: '1000.00', store1Code: 'INV-0001', store1Quantity: '3' });
  assert.equal('good2Name' in data, false);
  assert.equal('preparedBy' in data, true);
});
