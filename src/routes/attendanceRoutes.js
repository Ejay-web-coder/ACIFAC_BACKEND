import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import {
  cancelActivity,
  createActivity,
  finalizeAttendance,
  getActivity,
  getActivityHistory,
  getAttendanceDashboard,
  getMemberParticipation,
  getParticipationReport,
  listActivities,
  listActivityMembers,
  listAttendanceRecords,
  saveAttendance,
  updateActivity,
} from '../controllers/attendanceController.js';

// Member attendance monitoring, for the office only. Members read their own
// records through GET /api/members/me/attendance.
const router = express.Router();

router.use(requireAuth, requireAdmin);
router.get('/dashboard', getAttendanceDashboard);
router.get('/activities', listActivities);
router.post('/activities', createActivity);
router.get('/activities/:id', getActivity);
router.put('/activities/:id', updateActivity);
router.patch('/activities/:id/cancel', cancelActivity);
router.get('/activities/:id/members', listActivityMembers);
router.put('/activities/:id/attendance', saveAttendance);
router.post('/activities/:id/finalize', finalizeAttendance);
router.get('/activities/:id/history', getActivityHistory);
router.get('/records', listAttendanceRecords);
router.get('/reports/participation', getParticipationReport);
router.get('/members/:memberId', getMemberParticipation);

export default router;
