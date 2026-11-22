import express from 'express';
import { requireAdmin, requireAuth, requireMember } from '../middleware/auth.js';
import { paymentChannelUpload, paymentProofUpload } from '../middleware/upload.js';
import {
  approveOnlinePayment, getMyOnlinePayments, getPaymentChannelQr, getPaymentProof, listOnlinePayments, listPaymentChannels,
  readOnlinePaymentAgain, rejectOnlinePayment, submitOnlinePayment, updatePaymentChannel,
} from '../controllers/onlinePaymentController.js';

// Pay online (GCash or Maya, with a screenshot): members report payments; the office checks and approves or rejects them.
export const paymentSubmissionRoutes = express.Router()
  .use(requireAuth)
  .get('/me', requireMember, getMyOnlinePayments)
  .post('/', requireMember, paymentProofUpload.single('proof'), submitOnlinePayment)
  .get('/:id/proof', getPaymentProof)
  .use(requireAdmin)
  .get('/', listOnlinePayments)
  .post('/:id/approve', approveOnlinePayment)
  .post('/:id/reject', rejectOnlinePayment)
  .post('/:id/read-again', readOnlinePaymentAgain);

// The cooperative's GCash and Maya accounts: members see the ones that take payments; the office sets them in Settings.
export const paymentChannelRoutes = express.Router()
  .use(requireAuth)
  .get('/', listPaymentChannels)
  .get('/:channel/qr', getPaymentChannelQr)
  .put('/:channel', requireAdmin, paymentChannelUpload.single('qr'), updatePaymentChannel);
