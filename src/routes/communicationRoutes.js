import express from 'express';
import {
  createAnnouncement, deleteAnnouncement, deleteLegalDocument, downloadLegalDocument, listAnnouncements, listLegalDocuments,
  listNotifications, markAllNotificationsRead, markAnnouncementDone, markNotificationRead, updateLegalDocument, uploadLegalDocument,
} from '../controllers/communicationController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { legalDocumentUpload } from '../middleware/upload.js';
import { changesSince, eventStream } from '../services/events.js';

export const notificationRoutes = express.Router()
  .use(requireAuth)
  .get('/', listNotifications)
  .patch('/read-all', markAllNotificationsRead)
  .patch('/:id/read', markNotificationRead);

export const announcementRoutes = express.Router()
  .use(requireAuth)
  .get('/', listAnnouncements)
  .post('/', requireAdmin, createAnnouncement)
  .patch('/:id/done', requireAdmin, markAnnouncementDone)
  .delete('/:id', requireAdmin, deleteAnnouncement);

// The About page's Policy and Legal Documents: administrators see and manage
// them all; everyone else sees only the ones shown to members.
export const legalDocumentRoutes = express.Router()
  .use(requireAuth)
  .get('/', listLegalDocuments)
  .post('/', requireAdmin, legalDocumentUpload.single('document'), uploadLegalDocument)
  .get('/:id/file', downloadLegalDocument)
  .patch('/:id', requireAdmin, updateLegalDocument)
  .delete('/:id', requireAdmin, deleteLegalDocument);

export const eventRoutes = express.Router().get('/', requireAuth, eventStream).get('/changes', requireAuth, changesSince);
