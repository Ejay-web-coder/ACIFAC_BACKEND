import { jest } from '@jest/globals';

// Mock of src/services/memberEmails.js: member emails are never sent.
export const mockMemberEmails = () => ({
  emailMember: jest.fn(async () => ({ sent: false, skipped: true })),
  emailNotifiedUsers: jest.fn(async () => {}),
  isDeliverableAddress: jest.fn(() => true),
  BULK_BATCH_SIZE: 50,
  bulkEmailRecipients: jest.fn(async () => []),
  emailInBulk: jest.fn(async () => 0),
  emailMembersInBulk: jest.fn(async () => 0),
});

// The administrator who records the entries in these tests.
export const ADMIN = { id: 1, username: 'treasurer', role: 'ADMIN' };
