// How the patronage refund pool (half of the net surplus, see dividends.js) is
// shared among the members, by a weighted point system:
//   Business volume   70% of the pool. 1 point per PHP 100 of business the
//                     member did with the cooperative in the year, as the net
//                     income counts it (see netIncome.js): machinery rental
//                     and service fees, and loan interest paid. Kadiwa Store
//                     sales are recorded as daily totals without the buyer, so
//                     store purchases cannot be counted per member.
//   Participation     30% of the pool. Points per activity attended (present
//                     or late, final attendance only): a meeting 10, a
//                     community development or educational and training
//                     activity 5.
//   Member's refund = business part x (member's business points / all members' business points)
//                   + participation part x (member's participation points / all members' participation points)
// Each part is shared by its own points, so the 70/30 split holds whatever the
// scale of the points. When no member has points of one kind, the other part
// takes the whole pool. All amounts are integer centavos.
export const BUSINESS_WEIGHT_PERCENT = 70;
export const PARTICIPATION_WEIGHT_PERCENT = 100 - BUSINESS_WEIGHT_PERCENT;
export const PESOS_PER_BUSINESS_POINT = 100;
export const ACTIVITY_POINTS = { meeting: 10, community_development: 5, education_training: 5 };

// a x b / c rounded half up, without floating point (c > 0, a and b >= 0).
function mulDiv(a, b, c) {
  const numerator = BigInt(a) * BigInt(b);
  const denominator = BigInt(c);
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

/** Business points from centavos of business: 1 point per PHP 100, to two decimals. */
export const businessPoints = (cents) => cents / (PESOS_PER_BUSINESS_POINT * 100);

/** Participation points from the activities attended, by category. */
export function participationPoints(attended = {}) {
  return Object.entries(ACTIVITY_POINTS).reduce((sum, [category, points]) => sum + (Number(attended[category]) || 0) * points, 0);
}

/**
 * The member's patronage refund.
 *   poolCents       the patronage refund pool
 *   memberBusiness  the member's business by service, in centavos ({ machinery, loans })
 *   memberAttended  the member's activities attended, by category
 *   totalBusinessCents, totalParticipationPoints   the same, summed over all members
 */
export function computePatronageRefund({ poolCents, memberBusiness = {}, memberAttended = {}, totalBusinessCents, totalParticipationPoints }) {
  const pool = Math.max(0, poolCents);
  const business = Object.values(memberBusiness).reduce((sum, cents) => sum + cents, 0);
  const participation = participationPoints(memberAttended);

  let businessWeight = BUSINESS_WEIGHT_PERCENT;
  if (totalParticipationPoints <= 0) businessWeight = totalBusinessCents > 0 ? 100 : 0;
  else if (totalBusinessCents <= 0) businessWeight = 0;
  const participationWeight = totalBusinessCents > 0 || totalParticipationPoints > 0 ? 100 - businessWeight : 0;

  const businessPool = mulDiv(pool, businessWeight, 100);
  const participationPool = participationWeight > 0 ? pool - businessPool : 0;
  const businessShare = totalBusinessCents > 0 ? business / totalBusinessCents : 0;
  const participationShare = totalParticipationPoints > 0 ? participation / totalParticipationPoints : 0;
  const businessRefund = totalBusinessCents > 0 ? mulDiv(businessPool, business, totalBusinessCents) : 0;
  const participationRefund = totalParticipationPoints > 0 ? mulDiv(participationPool, participation, totalParticipationPoints) : 0;
  return {
    pool,
    weights: { business: businessWeight, participation: participationWeight },
    businessPool, participationPool,
    memberBusiness: { ...memberBusiness, total: business },
    memberAttended: Object.fromEntries(Object.keys(ACTIVITY_POINTS).map((category) => [category, Number(memberAttended[category]) || 0])),
    businessPoints: businessPoints(business),
    participationPoints: participation,
    totalBusinessCents, totalBusinessPoints: businessPoints(totalBusinessCents), totalParticipationPoints,
    businessShare, participationShare,
    // The member's share of the whole pool, the two parts weighted together.
    poolShare: (businessWeight * businessShare + participationWeight * participationShare) / 100,
    businessRefund, participationRefund,
    refund: businessRefund + participationRefund,
  };
}
