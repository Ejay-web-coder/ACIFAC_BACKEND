import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  changePassword, forgotPassword, login, logout, me, resetPassword, sendPasswordChangeCode, sessionStatus, unlockSession, updateNotificationPreferences, updateProfile,
  verifyResetCode,
} from '../controllers/authController.js';
import { deleteProfilePhoto, getProfilePhoto, uploadProfilePhoto } from '../controllers/profilePhotoController.js';
import { allowSignedOut, requireAuth } from '../middleware/auth.js';
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
  // Says when this device may ask again, like the database limits do.
  message: (req) => {
    const retryAfterSeconds = Math.max(1, Math.ceil(((req.rateLimit?.resetTime?.getTime() ?? Date.now() + 60 * 60 * 1000) - Date.now()) / 1000));
    const minutes = Math.ceil(retryAfterSeconds / 60);
    return {
      success: false,
      code: 'RESET_RATE_LIMITED',
      retryAfterSeconds,
      retryAt: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
      message: `Too many verification code requests. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    };
  },
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
// Signed out is 200 with user null here (see allowSignedOut).
router.get('/me', allowSignedOut, requireAuth, me);
router.get('/session', requireAuth, sessionStatus);
// "Stay logged in" after 20 minutes without activity: the password unlocks the
// session. It counts toward the same per-address flood guard as sign-in.
router.post('/unlock', loginLimiter, unlockSession);
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
