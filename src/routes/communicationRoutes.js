import express from 'express';
import {
  archiveAnnouncement, createAnnouncement, deleteLegalDocument, downloadLegalDocument, listAnnouncements, listLegalDocuments,
  listNotifications, markAllNotificationsRead, markNotificationRead, uploadLegalDocument,
} from '../controllers/communicationController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { legalDocumentUpload } from '../middleware/upload.js';
import { eventStream } from '../services/events.js';

export const notificationRoutes = express.Router()
  .use(requireAuth)
  .get('/', listNotifications)
  .patch('/read-all', markAllNotificationsRead)
  .patch('/:id/read', markNotificationRead);

export const announcementRoutes = express.Router()
  .use(requireAuth)
  .get('/', listAnnouncements)
  .post('/', requireAdmin, createAnnouncement)
  .delete('/:id', requireAdmin, archiveAnnouncement);

export const legalDocumentRoutes = express.Router()
  .use(requireAuth, requireAdmin)
  .get('/', listLegalDocuments)
  .post('/', legalDocumentUpload.single('document'), uploadLegalDocument)
  .get('/:id/file', downloadLegalDocument)
  .delete('/:id', deleteLegalDocument);

export const eventRoutes = express.Router().get('/', requireAuth, eventStream);
