/**
 * 出欠記録APIルート (v1 互換エンドポイント)
 *
 * ⚠️ このルートは旧 AttendanceService を廃止し、v2 スキーマ対応の
 *    UnifiedAttendanceService を直接呼び出しています。
 *    新規開発では /api/v2/attendance を優先してください。
 *
 * エンドポイント一覧:
 *   POST   /api/attendance            出欠記録の作成
 *   GET    /api/attendance            出欠記録の取得（期間フィルタ付き）
 *   GET    /api/attendance/report     月次レポート
 *   GET    /api/attendance/stats      統計情報
 *   PUT    /api/attendance/:id        出欠記録の更新
 *   DELETE /api/attendance/:id        出欠記録の削除
 */
const express = require('express');
const { body, query, validationResult } = require('express-validator');
const UnifiedAttendanceService = require('../services/UnifiedAttendanceService');
const { authenticate, requireAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/attendance
// 出欠記録の作成
// ─────────────────────────────────────────────────────────────
router.post('/', authenticate, [
    body('date')
        .isISO8601()
        .withMessage('有効な日付を入力してください（例: 2026-04-18）'),
    body('type')
        .isIn(['present', 'absent', 'late', 'early_departure', 'excused'])
        .withMessage('有効な出欠タイプを選択してください'),
    body('timestamp')
        .optional()
        .isISO8601()
        .withMessage('有効なタイムスタンプを入力してください'),
    body('reason')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('理由は500文字以下で入力してください')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: '入力データにエラーがあります',
            errors: errors.array()
        });
    }

    try {
        const { date, type, timestamp, reason } = req.body;
        const organizationId = req.user.organization_id;

        const result = await UnifiedAttendanceService.createRecord({
            organization_id: organizationId,
            user_id: req.user.id,
            record_type: 'daily',          // v1 互換は daily タイプで記録
            record_date: date,
            status: type,
            check_in_time: timestamp || null,
            reason: reason || null,
            source: 'manual',
            created_by: req.user.id
        });

        if (result.success) {
            res.status(201).json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        logger.error('出欠記録作成APIエラー:', error.message);
        res.status(500).json({ success: false, message: 'サーバーエラーが発生しました' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/attendance
// 出欠記録の取得（期間フィルタ付き）
// ─────────────────────────────────────────────────────────────
router.get('/', authenticate, [
    query('userId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('有効なユーザーIDを入力してください'),
    query('startDate')
        .optional()
        .isISO8601()
        .withMessage('有効な開始日を入力してください'),
    query('endDate')
        .optional()
        .isISO8601()
        .withMessage('有効な終了日を入力してください')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: '入力データにエラーがあります',
            errors: errors.array()
        });
    }

    try {
        const { userId, startDate, endDate } = req.query;

        // userId が未指定 or 無効値なら自分自身のIDを使用
        let targetUserId = (userId && userId !== 'undefined' && userId !== 'null')
            ? parseInt(userId)
            : req.user.id;

        // 自分以外の情報を取得しようとする場合は管理者権限が必要
        if (targetUserId !== req.user.id && !['admin', 'owner'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: '他のユーザーの記録を取得する権限がありません'
            });
        }

        const result = await UnifiedAttendanceService.getUserRecords(targetUserId, {
            organization_id: req.user.organization_id,
            start_date: startDate,
            end_date: endDate
        });

        res.json(result);
    } catch (error) {
        logger.error('出欠記録取得APIエラー:', error.message);
        res.status(500).json({ success: false, message: 'サーバーエラーが発生しました' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/attendance/report
// 月次レポートの取得
// ─────────────────────────────────────────────────────────────
router.get('/report', authenticate, [
    query('year')
        .isInt({ min: 2020, max: 2030 })
        .withMessage('有効な年を入力してください'),
    query('month')
        .isInt({ min: 1, max: 12 })
        .withMessage('有効な月を入力してください'),
    query('userId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('有効なユーザーIDを入力してください')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: '入力データにエラーがあります',
            errors: errors.array()
        });
    }

    try {
        const { year, month, userId } = req.query;

        let targetUserId = (userId && userId !== 'undefined' && userId !== 'null')
            ? parseInt(userId)
            : req.user.id;

        // 管理者・教員のみ他ユーザーのレポートを参照可能
        if (targetUserId !== req.user.id && !['admin', 'owner', 'teacher'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: '他のユーザーの記録を取得する権限がありません'
            });
        }

        const result = await UnifiedAttendanceService.getMonthlyReport(
            targetUserId,
            parseInt(year),
            parseInt(month),
            req.user.organization_id
        );

        res.json(result);
    } catch (error) {
        logger.error('月次レポート取得APIエラー:', error.message);
        res.status(500).json({ success: false, message: 'サーバーエラーが発生しました' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/attendance/stats
// 統計情報の取得
// ─────────────────────────────────────────────────────────────
router.get('/stats', authenticate, [
    query('period')
        .optional()
        .isIn(['week', 'month', 'year'])
        .withMessage('period は week / month / year のいずれかを指定してください'),
    query('userId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('有効なユーザーIDを入力してください')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: '入力データにエラーがあります',
            errors: errors.array()
        });
    }

    try {
        const { period = 'month', userId } = req.query;
        const targetUserId = userId ? parseInt(userId) : req.user.id;

        if (targetUserId !== req.user.id && !['admin', 'owner'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: '他のユーザーの記録を取得する権限がありません'
            });
        }

        // period から日付範囲を計算して getUserRecords で取得
        const now = new Date();
        let startDate;
        if (period === 'week') {
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        } else if (period === 'month') {
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).toISOString().split('T')[0];
        } else {
            startDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString().split('T')[0];
        }

        const recordsResult = await UnifiedAttendanceService.getUserRecords(targetUserId, {
            organization_id: req.user.organization_id,
            start_date: startDate
        });

        if (!recordsResult.success) {
            return res.status(500).json(recordsResult);
        }

        // 集計を計算
        const records = recordsResult.data.records || [];
        const summary = {
            period,
            totalRecords: records.length,
            presentCount: records.filter(r => r.status === 'present').length,
            absentCount: records.filter(r => r.status === 'absent').length,
            lateCount: records.filter(r => r.status === 'late').length,
            earlyDepartureCount: records.filter(r => r.status === 'early_departure').length
        };
        summary.attendanceRate = summary.totalRecords > 0
            ? Math.round((summary.presentCount / summary.totalRecords) * 100 * 100) / 100
            : 0;

        res.json({ success: true, data: summary });
    } catch (error) {
        logger.error('統計情報取得APIエラー:', error.message);
        res.status(500).json({ success: false, message: 'サーバーエラーが発生しました' });
    }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/attendance/:id
// 出欠記録の更新
// ─────────────────────────────────────────────────────────────
router.put('/:id', authenticate, [
    body('type')
        .optional()
        .isIn(['present', 'absent', 'late', 'early_departure', 'excused'])
        .withMessage('有効な出欠タイプを選択してください'),
    body('timestamp')
        .optional()
        .isISO8601()
        .withMessage('有効なタイムスタンプを入力してください'),
    body('reason')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('理由は500文字以下で入力してください')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: '入力データにエラーがあります',
            errors: errors.array()
        });
    }

    try {
        const { id } = req.params;
        const { type, timestamp, reason } = req.body;

        // 更新対象を status / check_in_time / reason にマッピング
        const updateData = {};
        if (type) updateData.status = type;
        if (timestamp) updateData.check_in_time = timestamp;
        if (reason !== undefined) updateData.reason = reason;

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ success: false, message: '更新するデータがありません' });
        }

        const { query: dbQuery } = require('../config/database');

        // 自分が作成したレコードか確認（管理者は制限なし）
        const existing = await dbQuery(
            'SELECT id, user_id FROM attendance_records WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: '記録が見つかりません' });
        }
        if (existing[0].user_id !== req.user.id && !['admin', 'owner'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: '更新権限がありません' });
        }

        const fields = Object.keys(updateData).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(updateData), id];
        await dbQuery(
            `UPDATE attendance_records SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            values
        );

        logger.info('出欠記録更新成功', { recordId: id, userId: req.user.id });
        res.json({ success: true, message: '出欠記録が更新されました' });
    } catch (error) {
        logger.error('出欠記録更新APIエラー:', error.message);
        res.status(500).json({ success: false, message: 'サーバーエラーが発生しました' });
    }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/attendance/:id
// 出欠記録の削除
// ─────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { query: dbQuery } = require('../config/database');

        // 自分のレコードか確認（管理者は制限なし）
        const existing = await dbQuery(
            'SELECT id, user_id FROM attendance_records WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: '記録が見つかりません' });
        }
        if (existing[0].user_id !== req.user.id && !['admin', 'owner'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: '削除権限がありません' });
        }

        await dbQuery('DELETE FROM attendance_records WHERE id = ?', [id]);

        logger.info('出欠記録削除成功', { recordId: id, userId: req.user.id });
        res.json({ success: true, message: '出欠記録が削除されました' });
    } catch (error) {
        logger.error('出欠記録削除APIエラー:', error.message);
        res.status(500).json({ success: false, message: 'サーバーエラーが発生しました' });
    }
});

module.exports = router;
