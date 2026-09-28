// Builds the PhilMech "Farm Machinery Utilization Report" and "Cashflow
// Statement of Farm Machinery Operation per Cropping" for one cropping period
// from database rows. Pure (no database access) so it can be unit tested.
// Money is summed in centavos and areas in ten-thousandths of a hectare.
// An implement's services, expenses and balances count under the machine it is
// attached to (the rows arrive with reportMachineId already resolved).
import { centsToString, toCents } from '../utils/money.js';
import { fromScaled, toScaled } from './machineryFees.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const EXPENSE_CATEGORIES = ['fuel', 'labor', 'repair_maintenance', 'other'];

const area = (value) => toScaled(value ?? '0', 4, 'Area');
const areaText = (value) => fromScaled(value, 4);
const peso = (cents) => `₱${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Inclusive date window of the report: the chosen months, else the whole year.
export function reportWindow(year, fromMonth, toMonth) {
  const first = fromMonth || 1;
  const last = toMonth || 12;
  const lastDay = new Date(Date.UTC(year, last, 0)).getUTCDate();
  return {
    from: `${year}-${String(first).padStart(2, '0')}-01`,
    to: `${year}-${String(last).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    label: first === last ? `${MONTHS[first - 1]} ${year}` : `${MONTHS[first - 1]}–${MONTHS[last - 1]} ${year}`,
    monthsChosen: Boolean(fromMonth && toMonth),
  };
}

function clientKey(service) {
  return service.clientCategory === 'member' && service.memberId
    ? `m:${service.memberId}`
    : `n:${String(service.clientName).trim().toLowerCase()}|${String(service.clientAddress || '').trim().toLowerCase()}`;
}

function buildMachine(machine, { services, expenses, balances, rates, implementsList, aggregate, window }) {
  const warnings = [];
  const farmers = { member: new Set(), non_member: new Set() };
  const areaBy = { member: 0n, non_member: 0n };
  const bagsBy = { member: 0n, non_member: 0n };
  let collected = 0;
  let collectibles = 0;
  let billed = 0;

  const clients = services.map((service) => {
    const category = service.clientCategory;
    farmers[category].add(clientKey(service));
    areaBy[category] += area(service.areaHa);
    if (service.totalBags !== null && service.totalBags !== undefined) bagsBy[category] += toScaled(service.totalBags, 2, 'Bags');
    collected += toCents(service.amountPaid);
    collectibles += toCents(service.balance);
    billed += toCents(service.feeAmount);
    return {
      serviceId: service.id,
      machineryId: service.machineryId,
      name: service.clientName,
      address: service.clientAddress || '',
      category: category === 'member' ? 'M' : 'NM',
      serviceType: service.serviceType,
      serviceDate: service.serviceDate,
      unit: service.unit,
      areaHa: areaText(area(service.areaHa)),
      totalBags: service.totalBags ?? null,
      feeBags: service.feeBags ?? null,
      rateUsed: service.rateUsed,
      totalAmount: centsToString(toCents(service.feeAmount)),
      cashCollection: centsToString(toCents(service.amountPaid)),
      paymentStatus: service.paymentStatus,
      accountsReceivable: centsToString(toCents(service.balance)),
    };
  });

  const clientTotals = clients.reduce((totals, row) => ({
    areaHa: totals.areaHa + area(row.areaHa),
    totalAmount: totals.totalAmount + toCents(row.totalAmount),
    cashCollection: totals.cashCollection + toCents(row.cashCollection),
    accountsReceivable: totals.accountsReceivable + toCents(row.accountsReceivable),
  }), { areaHa: 0n, totalAmount: 0, cashCollection: 0, accountsReceivable: 0 });

  const outflows = Object.fromEntries(EXPENSE_CATEGORIES.map((category) => [category, 0]));
  for (const expense of expenses) outflows[expense.category] += toCents(expense.amount);
  const totalOutflows = EXPENSE_CATEGORIES.reduce((sum, category) => sum + outflows[category], 0);
  const operatingExpenses = expenses.reduce((sum, expense) => sum + toCents(expense.amount), 0);

  const beginningCash = balances.reduce((sum, row) => sum + toCents(row.beginningCash), 0);
  const otherIncome = balances.reduce((sum, row) => sum + toCents(row.otherIncome), 0);
  const totalInflows = collected + otherIncome;
  const totalSourceOfCash = beginningCash + totalInflows;

  // Safety nets: the database's own totals must agree with the lists above.
  const summaryArea = area(aggregate?.area?.member) + area(aggregate?.area?.non_member);
  if (aggregate && summaryArea !== clientTotals.areaHa) {
    warnings.push({ level: 'error', code: 'AREA_MISMATCH', message: `Area serviced in the summary (${areaText(summaryArea)} ha) does not match the client list (${areaText(clientTotals.areaHa)} ha).` });
  }
  if (aggregate && toCents(aggregate.expenses ?? '0') !== totalOutflows) {
    warnings.push({ level: 'error', code: 'EXPENSE_MISMATCH', message: `Operating expenses in the summary (${peso(toCents(aggregate.expenses ?? '0'))}) do not match the cash flow outflows (${peso(totalOutflows)}).` });
  }

  // What made the paper report disagree.
  const outsideServices = services.filter((service) => service.serviceDate < window.from || service.serviceDate > window.to);
  if (outsideServices.length) {
    warnings.push({ level: 'warning', code: 'SERVICE_OUTSIDE_MONTHS', message: `${plural(outsideServices.length, 'service')} recorded for this cropping ${outsideServices.length === 1 ? 'is' : 'are'} dated outside ${window.label}: ${outsideServices.map((service) => `${service.clientName} (${service.serviceDate})`).join(', ')}.` });
  }
  const outsideExpenses = expenses.filter((expense) => expense.expenseDate < window.from || expense.expenseDate > window.to);
  if (outsideExpenses.length) {
    warnings.push({ level: 'warning', code: 'EXPENSE_OUTSIDE_MONTHS', message: `${plural(outsideExpenses.length, 'expense')} recorded for this cropping ${outsideExpenses.length === 1 ? 'is' : 'are'} dated outside ${window.label} (${peso(outsideExpenses.reduce((sum, expense) => sum + toCents(expense.amount), 0))}).` });
  }
  const noArea = services.filter((service) => area(service.areaHa) === 0n);
  if (noArea.length) {
    warnings.push({ level: 'warning', code: 'SERVICE_WITHOUT_AREA', message: `${plural(noArea.length, 'service')} ${noArea.length === 1 ? 'has' : 'have'} no area in hectares, so the area serviced is understated: ${noArea.map((service) => service.clientName).join(', ')}.` });
  }
  const overridden = services.filter((service) => service.computedFeeAmount !== null && service.computedFeeAmount !== undefined && toCents(service.computedFeeAmount) !== toCents(service.feeAmount));
  if (overridden.length) {
    warnings.push({ level: 'info', code: 'FEE_CHANGED', message: `${plural(overridden.length, 'fee')} ${overridden.length === 1 ? 'was' : 'were'} changed from the rate: ${overridden.map((service) => `${service.clientName} (${peso(toCents(service.computedFeeAmount))} → ${peso(toCents(service.feeAmount))}: ${service.feeOverrideReason})`).join('; ')}.` });
  }
  const neverPaid = services.filter((service) => toCents(service.balance) > 0 && Number(service.paymentCount || 0) === 0);
  if (neverPaid.length) {
    warnings.push({ level: 'warning', code: 'UNPAID_NO_PAYMENT', message: `${plural(neverPaid.length, 'client')} ${neverPaid.length === 1 ? 'has' : 'have'} not paid anything yet (${peso(neverPaid.reduce((sum, service) => sum + toCents(service.balance), 0))} receivable, no payment date).` });
  }
  if (!balances.length) {
    warnings.push({ level: 'info', code: 'NO_BEGINNING_CASH', message: 'Beginning cash for this cropping has not been entered, so the cash flow starts at ₱0.00.' });
  }

  return {
    machineryId: machine.id,
    name: machine.name,
    type: machine.type,
    deliveryDate: machine.deliveryDate ?? null,
    condition: machine.condition ?? null,
    implements: implementsList,
    rates: rates.map(({ serviceType, unit, memberRate, nonMemberRate, effectiveFrom, effectiveTo }) => ({ serviceType, unit, memberRate, nonMemberRate, effectiveFrom, effectiveTo })),
    summary: {
      farmers: { member: farmers.member.size, nonMember: farmers.non_member.size, total: farmers.member.size + farmers.non_member.size },
      areaHa: { member: areaText(areaBy.member), nonMember: areaText(areaBy.non_member), total: areaText(areaBy.member + areaBy.non_member) },
      bags: { member: fromScaled(bagsBy.member, 2), nonMember: fromScaled(bagsBy.non_member, 2), total: fromScaled(bagsBy.member + bagsBy.non_member, 2) },
      grossIncome: { collected: centsToString(collected), collectibles: centsToString(collectibles), total: centsToString(billed) },
      operatingExpenses: centsToString(operatingExpenses),
      availableFunds: centsToString(billed - operatingExpenses),
    },
    cashFlow: {
      beginningCash: centsToString(beginningCash),
      serviceFeesCollected: centsToString(collected),
      otherIncome: centsToString(otherIncome),
      totalInflows: centsToString(totalInflows),
      totalSourceOfCash: centsToString(totalSourceOfCash),
      outflows: Object.fromEntries(EXPENSE_CATEGORIES.map((category) => [category, centsToString(outflows[category])])),
      totalOutflows: centsToString(totalOutflows),
      netCashFlow: centsToString(totalSourceOfCash - totalOutflows),
    },
    clients,
    clientTotals: {
      areaHa: areaText(clientTotals.areaHa),
      totalAmount: centsToString(clientTotals.totalAmount),
      cashCollection: centsToString(clientTotals.cashCollection),
      accountsReceivable: centsToString(clientTotals.accountsReceivable),
    },
    warnings,
  };
}

export function buildPhilmechReport({ croppingPeriod, year, fromMonth = null, toMonth = null, machines, services, expenses, balances, rates, aggregates = {} }) {
  const window = reportWindow(year, fromMonth, toMonth);
  const byMachine = (rows, id) => rows.filter((row) => row.reportMachineId === id);
  const topLevel = machines.filter((machine) => !machine.parentMachineryId);
  const included = topLevel.filter((machine) => machine.pricingMode === 'per_service'
    || [services, expenses, balances].some((rows) => rows.some((row) => row.reportMachineId === machine.id)));

  return {
    croppingPeriod,
    year,
    fromMonth,
    toMonth,
    window,
    machines: included.map((machine) => buildMachine(machine, {
      services: byMachine(services, machine.id).sort((a, b) => (a.serviceDate < b.serviceDate ? -1 : a.serviceDate > b.serviceDate ? 1 : a.id - b.id)),
      expenses: byMachine(expenses, machine.id),
      balances: byMachine(balances, machine.id),
      rates: byMachine(rates, machine.id).filter((rate) => rate.effectiveFrom <= window.to && (!rate.effectiveTo || rate.effectiveTo >= window.from)),
      implementsList: machines.filter((row) => row.parentMachineryId === machine.id).map((row) => ({ id: row.id, name: row.name })),
      aggregate: aggregates[machine.id] ?? { area: {}, expenses: '0' },
      window,
    })),
  };
}
