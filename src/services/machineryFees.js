// Fees for per-service machinery jobs (PhilMech utilization report).
// All arithmetic is exact: decimals are parsed into BigInt values with a fixed
// number of decimal places, and results are rounded half-up to centavos.
//   per_ha        fee = area_ha x rate
//   per_100_bags  fee_bags = total_bags x rate / 100, fee = fee_bags x bag_value
//                 (bag_value entered, or kg_per_bag x price_per_kg)
//   per_day       fee = days x rate

export const SERVICE_UNITS = ['per_ha', 'per_100_bags', 'per_day'];
export const CLIENT_CATEGORIES = ['member', 'non_member'];
export const CROPPING_PERIODS = ['1st', '2nd', '3rd'];

export class FeeInputError extends Error {}

const normalizeType = (value) => String(value ?? '').trim().toLowerCase();

// Parses a non-negative decimal into an integer scaled by 10^scale.
export function toScaled(value, scale, label) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new FeeInputError(`${label} must be a number that is zero or more.`);
  const fraction = (match[2] || '').replace(/0+$/, '');
  if (fraction.length > scale) throw new FeeInputError(`${label} allows at most ${scale} decimal places.`);
  return BigInt(match[1] + fraction.padEnd(scale, '0'));
}

export function fromScaled(value, scale) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale ? `.${digits.slice(-scale)}` : ''}`;
}

// Half-up division for non-negative values.
const divRound = (numerator, divisor) => (numerator + divisor / 2n) / divisor;

// The rate whose effective period covers the service date (YYYY-MM-DD strings).
// Rate periods of one service type never overlap (the database enforces it);
// if they somehow did, the most recent start wins.
export function findRateForDate(rates, serviceType, serviceDate) {
  const type = normalizeType(serviceType);
  return rates
    .filter((rate) => normalizeType(rate.serviceType) === type
      && rate.effectiveFrom <= serviceDate
      && (!rate.effectiveTo || rate.effectiveTo >= serviceDate))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] || null;
}

export function rateForClient(rate, clientCategory) {
  if (!CLIENT_CATEGORIES.includes(clientCategory)) throw new FeeInputError('Client category must be member or non-member.');
  return String(clientCategory === 'non_member' ? rate.nonMemberRate : rate.memberRate);
}

// Returns decimal strings ready for NUMERIC columns.
export function computeServiceFee({ unit, rate, areaHa, days, totalBags, bagValue, kgPerBag, pricePerKg }) {
  if (!SERVICE_UNITS.includes(unit)) throw new FeeInputError('Unknown rate unit.');
  const rateScaled = toScaled(rate, 2, 'Rate');
  const result = { rateUsed: fromScaled(rateScaled, 2), feeBags: null, bagValue: null };

  if (unit === 'per_ha') {
    const area = toScaled(areaHa, 4, 'Area (ha)');
    if (area === 0n) throw new FeeInputError('Area (ha) must be more than zero.');
    return { ...result, feeAmount: fromScaled(divRound(area * rateScaled, 10000n), 2) };
  }

  if (unit === 'per_day') {
    const count = Number(days);
    if (!Number.isInteger(count) || count <= 0) throw new FeeInputError('Days must be a whole number of at least 1.');
    return { ...result, feeAmount: fromScaled(BigInt(count) * rateScaled, 2) };
  }

  const bags = toScaled(totalBags, 2, 'Total bags');
  if (bags === 0n) throw new FeeInputError('Total bags must be more than zero.');
  // bags (2 places) x rate (2 places) = 4 places; / 100 bags, back to 2 places.
  const feeBags = divRound(bags * rateScaled, 10000n);
  let value;
  if (bagValue !== undefined && bagValue !== null && String(bagValue).trim() !== '') {
    value = toScaled(bagValue, 2, 'Bag value');
  } else if (kgPerBag !== undefined && kgPerBag !== null && String(kgPerBag).trim() !== '' && pricePerKg !== undefined && pricePerKg !== null && String(pricePerKg).trim() !== '') {
    value = divRound(toScaled(kgPerBag, 2, 'Kg per bag') * toScaled(pricePerKg, 2, 'Price per kg'), 100n);
  } else {
    throw new FeeInputError('Enter the value of one bag, or kg per bag and the price per kg.');
  }
  return {
    ...result,
    feeBags: fromScaled(feeBags, 2),
    bagValue: fromScaled(value, 2),
    feeAmount: fromScaled(divRound(feeBags * value, 100n), 2),
  };
}

// Mirrors the generated columns of machinery_services.
export function paymentSummary(feeAmount, amountPaid) {
  const fee = toScaled(feeAmount, 2, 'Fee');
  const paid = toScaled(amountPaid, 2, 'Amount paid');
  return {
    balance: fromScaled(fee - paid, 2),
    paymentStatus: paid >= fee ? 'full' : paid > 0n ? 'partial' : 'unpaid',
  };
}
