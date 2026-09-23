import express from 'express';
import rateLimit from 'express-rate-limit';
import { changePassword, forgotPassword, login, logout, me, resetPassword, updateNotificationPreferences, updateProfile } from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Please wait a while and try again.' },
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many reset attempts. Please try again later.' },
});

router.post('/login', loginLimiter, login);
router.post('/logout', logout);
router.get('/me', requireAuth, me);
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/reset-password', resetLimiter, resetPassword);
router.post('/change-password', requireAuth, changePassword);
router.patch('/profile', requireAuth, updateProfile);
router.patch('/notification-preferences', requireAuth, updateNotificationPreferences);

export default router;
