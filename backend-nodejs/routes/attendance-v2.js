/**
 * 統合出欠APIルート (v2 — 新スキーマ専用)
 *
 * ⚠️ このファイルは v2 スキーマ（attendance_records テーブル）専用です。
 *    旧スキーマ互換 (CompatibilityLayer) は廃止し、
 *    UnifiedAttendanceService を直接呼び出します。
 *
 * エンドポイント一覧:
 *   POST   /api/v2/attendance/check-in               チェックイン（出席打刻）
 *   POST   /api/v2/attendance/check-out              チェックアウト（退席打刻）
 *   GET    /api/v2/attendance/today                  今日の出欠状況
 *   GET    /api/v2/attendance/monthly/:year/:month   月次レポート
 *   GET    /api/v2/attendance/stats/daily/:year/:month 日次統計（管理者・教員のみ）
 *   GET    /api/v2/attendance/absence/:date          欠席詳細（管理者・教員のみ）
 */
const express = require('express');
const router = express.Router();
const { param, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const UnifiedAttendanceService = require('../services/UnifiedAttendanceService');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// ヘルパー: organization_id を確実に取得する
// JWT に organization_id が含まれていることを前提とする（orgContext ミドルウェア参照）
// ─────────────────────────────────────────────────────────────
function getOrgId(req) {
    const orgId = req.user?.organization_id;
    if (!orgId) {
        throw new Error('organization_id が取得できません。認証情報を確認してください。');
    }
    return orgId;
}

// ─────────────────────────────────────────────────────────────
// POST /api/v2/attendance/check-in
// チェックイン（出席・出勤打刻）
// ─────────────────────────────────────────────────────────────
router.post('/check-in', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const organizationId = getOrgId(req);

        const result = await UnifiedAttendanceService.checkIn(organizationId, userId, {
            record_type: req.body.record_type || 'work', // 'class' | 'work' | 'event' | 'daily'
            reference_id: req.body.reference_id || null, // 関連する授業ID/イベントID
            source: req.body.source || 'manual',         // 打刻方法
            ip_address: req.ip
        });

        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        logger.error('チェックインAPIエラー:', error.message);
        res.status(500).json({ success: false, message: 'チェックインに失敗しました' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v2/attendance/check-out
// チェックアウト（退席・退勤打刻）
// ─────────────────────────────────────────────────────────────
router.post('/check-out', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const organizationId = getOrgId(req);

        const result = await UnifiedAttendanceService.checkOut(organizationId, userId, {
            record_type: req.body.record_type || 'work',
            reference_id: req.body.reference_id || null
        });

        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        logger.error('チェックアウトAPIエラー:', error.message);
        res.status(500).json({ success: false, message: 'チェックアウトに失敗しました' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v2/attendance/today
// 今日の出欠状況取得（自分自身、または管理者が user_id を指定）
// ─────────────────────────────────────────────────────────────
router.get('/today', authenticate, async (req, res) => {
    try {
        const organizationId = getOrgId(req);

        // 管理者・教員は他ユーザーの情報を参照できる
        const targetUserId = (req.query.user_id && ['admin', 'owner', 'teacher'].includes(req.user.role))
            ? parseInt(req.query.user_id)
            : req.user.id;

        const result = await UnifiedAttendanceService.getTodayStatus(targetUserId, organizationId);
        res.json(result);
    } catch (error) {
        logger.error('今日の出欠状況取得APIエラー:', error.message);
        res.status(500).json({ success: false, message: '今日の出欠状況の取得に失敗しました' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v2/attendance/monthly/:year/:month
// 月次レポート取得（自分自身、または管理者が user_id を指定）
// ─────────────────────────────────────────────────────────────
router.get(
    '/monthly/:year/:month',
    authenticate,
    [
        param('year').isInt({ min: 2000, max: 2100 }).withMessage('年は2000〜2100の整数で指定してください'),
        param('month').isInt({ min: 1, max: 12 }).withMessage('月は1〜12の整数で指定してください')
    ],
    async (req, res) => {
        // バリデーション確認
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: '入力データにエラーがあります', errors: errors.array() });
        }

        try {
            const { year, month } = req.params;
            const organizationId = getOrgId(req);

            // 管理者・教員は他ユーザーのレポートを参照できる
            const targetUserId = (req.query.user_id && ['admin', 'owner', 'teacher'].includes(req.user.role))
                ? parseInt(req.query.user_id)
                : req.user.id;

            const result = await UnifiedAttendanceService.getMonthlyReport(
                targetUserId,
                parseInt(year),
                parseInt(month),
                organizationId
            );

            res.json(result);
        } catch (error) {
            logger.error('月次レポート取得APIエラー:', error.message);
            res.status(500).json({ success: false, message: '月次レポートの取得に失敗しました' });
        }
    }
);

// ─────────────────────────────────────────────────────────────
// GET /api/v2/attendance/stats/daily/:year/:month
// 日次統計取得（管理者・教員のみ）
// ─────────────────────────────────────────────────────────────
router.get(
    '/stats/daily/:year/:month',
    authenticate,
    requireRole(['owner', 'admin', 'teacher']),
    [
        param('year').isInt({ min: 2000, max: 2100 }).withMessage('年は2000〜2100の整数で指定してください'),
        param('month').isInt({ min: 1, max: 12 }).withMessage('月は1〜12の整数で指定してください')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: '入力データにエラーがあります', errors: errors.array() });
        }

        try {
            const { year, month } = req.params;
            const organizationId = getOrgId(req);

            const result = await UnifiedAttendanceService.getDailyStats(
                organizationId,
                parseInt(year),
                parseInt(month)
            );

            res.json(result);
        } catch (error) {
            logger.error('日次統計取得APIエラー:', error.message);
            res.status(500).json({ success: false, message: '日次統計の取得に失敗しました' });
        }
    }
);

// ─────────────────────────────────────────────────────────────
// GET /api/v2/attendance/absence/:date
// 欠席詳細取得（管理者・教員のみ）
// ─────────────────────────────────────────────────────────────
router.get(
    '/absence/:date',
    authenticate,
    requireRole(['owner', 'admin', 'teacher']),
    [
        param('date').isISO8601().withMessage('日付は ISO8601 形式（例: 2026-04-18）で指定してください')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: '入力データにエラーがあります', errors: errors.array() });
        }

        try {
            const { date } = req.params;
            const organizationId = getOrgId(req);

            const result = await UnifiedAttendanceService.getAbsenceDetails(organizationId, date);
            res.json(result);
        } catch (error) {
            logger.error('欠席詳細取得APIエラー:', error.message);
            res.status(500).json({ success: false, message: '欠席詳細の取得に失敗しました' });
        }
    }
);

module.exports = router;
