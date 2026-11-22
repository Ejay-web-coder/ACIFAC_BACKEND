// Member ID cards (no database access, so they can be unit tested). The QR on
// a card holds only "ACIFAC:" and the member's random code (members.id_token,
// 32 hexadecimal characters), never a name or phone number: a lost card
// reveals nothing, and reissuing a card gives a new code, so the old card
// stops working.

export const ID_QR_PREFIX = 'ACIFAC:';
const CODE = /^[0-9a-f]{32}$/;

/**
 * The member's code from what a scanner read: "ACIFAC:<code>" (or the code
 * alone), in lower case. null when it is not an ACIFAC member ID.
 */
export function parseIdCardCode(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (text.toUpperCase().startsWith(ID_QR_PREFIX)) text = text.slice(ID_QR_PREFIX.length).trim();
  text = text.toLowerCase();
  return CODE.test(text) ? text : null;
}

/**
 * What the QR on the card holds. In capitals, so the QR uses its compact
 * alphanumeric mode: 29 x 29 squares instead of 33 x 33, larger on a small
 * card and easier to scan. Scanned codes are read in any letter case.
 */
export const idCardQrText = (code) => `${ID_QR_PREFIX}${code.toUpperCase()}`;

/**
 * How a member who checks in at `clock` (HH:MM, the cooperative's time) is
 * recorded: present up to the start time, late after it. The Membership
 * Policy asks members to be on time ("On time sa pagdalo sa mga
 * pagpupulong") and gives no grace period.
 */
export function checkInStatus(clock, startTime) {
  return String(clock).slice(0, 5) > String(startTime).slice(0, 5) ? 'late' : 'present';
}
