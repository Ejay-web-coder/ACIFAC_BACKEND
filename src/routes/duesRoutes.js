import express from 'express';
import { requireAdmin, requireAuth, requireMember } from '../middleware/auth.js';
import {
  addTransferFee, chargeMeeting, getMemberDues, getMyDues, listDuesMeetings, listMemberDues, recordDuesPayment, waiveDue,
} from '../controllers/duesController.js';
import { getPushKey, subscribePush, unsubscribePush } from '../controllers/pushController.js';

// Dues under the Membership Policy. A member reads their own; the rest is the office's.
export const duesRoutes = express.Router()
  .use(requireAuth)
  .get('/me', requireMember, getMyDues)
  .use(requireAdmin)
  .get('/', listMemberDues)
  .get('/meetings', listDuesMeetings)
  .post('/meetings/:id/charge', chargeMeeting)
  .get('/members/:id', getMemberDues)
  .post('/payments', recordDuesPayment)
  .post('/transfer-fee', addTransferFee)
  .patch('/:id/waive', waiveDue);

// Phone notifications for the signed-in account (any role).
export const pushRoutes = express.Router()
  .use(requireAuth)
  .get('/key', getPushKey)
  .post('/subscriptions', subscribePush)
  .post('/subscriptions/remove', unsubscribePush);
