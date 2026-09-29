import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  changePassword, forgotPassword, login, logout, me, resetPassword, sendPasswordChangeCode, sessionStatus, updateNotificationPreferences, updateProfile,
  verifyResetCode,
} from '../controllers/authController.js';
import { deleteProfilePhoto, getProfilePhoto, uploadProfilePhoto } from '../controllers/profilePhotoController.js';
import { requireAuth } from '../middleware/auth.js';
import { profilePhotoUpload } from '../middleware/upload.js';

const router = express.Router();

// These in-memory limiters are a coarse per-instance flood guard only. The
// lockout, resend cooldown and attempt limits themselves are enforced in
// PostgreSQL (see loginThrottle.js and the password_reset_codes checks), so
// they hold across server instances, browsers and direct API calls.
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

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RESET_RATE_LIMITED', message: 'Too many verification code requests. Please try again later.' },
});

const verifyCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RESET_CODE_LOCKED', message: 'Too many verification attempts. Please try again later.' },
});

router.post('/login', loginLimiter, login);
router.post('/logout', logout);
router.get('/me', requireAuth, me);
router.get('/session', requireAuth, sessionStatus);
router.post('/forgot-password', forgotLimiter, forgotPassword);
router.post('/verify-reset-code', verifyCodeLimiter, verifyResetCode);
router.post('/reset-password', resetLimiter, resetPassword);
router.post('/change-password/code', requireAuth, forgotLimiter, sendPasswordChangeCode);
router.post('/change-password', requireAuth, changePassword);
router.patch('/profile', requireAuth, updateProfile);
router.patch('/notification-preferences', requireAuth, updateNotificationPreferences);
// Own picture only; see profilePhotoController.
router.get('/profile-photo', requireAuth, getProfilePhoto);
router.post('/profile-photo', requireAuth, profilePhotoUpload.single('photo'), uploadProfilePhoto);
router.delete('/profile-photo', requireAuth, deleteProfilePhoto);

export default router;
