// Philippine mobile numbers are typed many ways: 09171234567, 0917 123 4567,
// 639171234567, +63 917-123-4567, 9171234567. The SMS gateway needs
// +639171234567. Anything else (landlines, several numbers in one field,
// typos) returns null, and no text is sent to it.
export function normalizePhilippineMobile(value) {
  const digits = String(value ?? '').trim().replace(/^\+/, '').replace(/[\s().-]/g, '');
  const match = /^(?:63|0)?(9\d{9})$/.exec(digits);
  return match ? `+63${match[1]}` : null;
}

// "0917 ••• 4567": enough to recognise the number without showing all of it.
export function maskPhilippineMobile(value) {
  const phone = normalizePhilippineMobile(value);
  return phone ? `0${phone.slice(3, 6)} ••• ${phone.slice(-4)}` : null;
}
