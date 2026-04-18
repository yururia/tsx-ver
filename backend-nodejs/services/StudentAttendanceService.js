/**
 * 学生出欠管理サービス (新スキーマ対応版)
 * 旧 StudentAttendanceService のインターフェースを維持
 */
const { query } = require('../config/database');
const logger = require('../utils/logger');
const UnifiedAttendanceService = require('./UnifiedAttendanceService');
const UnifiedUserService = require('./UnifiedUserService');

class StudentAttendanceService {
  /**
   * 学生出欠記録の作成 (簡易版)
   */
  static async recordAttendance(studentId, timestamp) {
    try {
      const organizationId = 1;
      const userResult = await UnifiedUserService.getUserByIdentifier(organizationId, studentId);
      if (!userResult.success) {
        throw new Error('学生が見つかりません');
      }
      const userId = userResult.data.id;

      const result = await UnifiedAttendanceService.createRecord({
        organization_id: organizationId,
        user_id: userId,
        record_type: 'daily',
        record_date: new Date(timestamp || new Date()).toISOString().split('T')[0],
        check_in_time: new Date(timestamp || new Date()),
        status: 'present',
        source: 'manual'
      });

      if (!result.success) {
        throw new Error(result.message);
      }

      logger.info('学生出欠記録作成成功', { studentId, timestamp });
      return {
        success: true,
        message: '学生出欠記録が保存されました',
        data: { recordId: result.data.id }
      };
    } catch (error) {
      logger.error('学生出欠記録作成エラー:', error.message);
      return {
        success: false,
        message: '学生出欠記録の保存に失敗しました'
      };
    }
  }

  /**
   * QRコード読み取りによる詳細出欠記録の作成
   */
  static async recordQRAttendance(studentId, timestamp, classId = null) {
    try {
      const organizationId = 1;
      const userResult = await UnifiedUserService.getUserByIdentifier(organizationId, studentId);
      if (!userResult.success) {
        throw new Error('学生が見つかりません');
      }
      const userId = userResult.data.id;

      const dateObj = new Date(timestamp);
      const recordDate = dateObj.toISOString().split('T')[0];
      const checkInTimeStr = dateObj.toTimeString().split(' ')[0]; // HH:MM:SS

      let targetClassId = classId;

      // 授業IDが指定されていない場合、履修状況から検索
      if (!targetClassId) {
        const dayOfWeek = dateObj.getDay(); // 0-6
        // schedule_day ENUM mapping
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const scheduleDay = days[dayOfWeek];

        const classes = await query(
          `SELECT c.id 
           FROM classes c
           JOIN enrollments e ON c.id = e.class_id
           WHERE e.user_id = ? 
           AND c.schedule_day = ? 
           AND c.start_time <= ? 
           AND c.end_time >= ?
           AND c.is_active = TRUE
           AND e.status = 'enrolled'`,
          [userId, scheduleDay, checkInTimeStr, checkInTimeStr]
        );

        if (classes.length === 0) {
          throw new Error('現在時刻に該当する履修授業が見つかりません');
        }
        if (classes.length > 1) {
          throw new Error('現在時刻に複数の授業が該当します。選択が必要です');
        }
        targetClassId = classes[0].id;
      }

      // 授業情報を取得（遅刻判定のため）
      const classInfo = await query(
        'SELECT start_time FROM classes WHERE id = ?',
        [targetClassId]
      );

      if (classInfo.length === 0) {
        throw new Error('指定された授業IDが見つかりません');
      }

      const classStartTime = classInfo[0].start_time;
      const status = (checkInTimeStr > classStartTime) ? 'late' : 'present';

      // 既存の記録を確認 (attendance_records テーブル)
      const existing = await query(
        `SELECT * FROM attendance_records 
         WHERE user_id = ? AND record_type = 'class' AND reference_id = ? AND record_date = ?`,
        [userId, targetClassId, recordDate]
      );

      let recordId;
      let action = 'checkin';
      let checkOutTime = null;

      if (existing.length > 0) {
        // 既存記録あり (上書きまたは退出処理)
        recordId = existing[0].id;

        if (existing[0].check_in_time && !existing[0].check_out_time) {
          // 退出処理
          action = 'checkout';
          checkOutTime = dateObj;
          await query(
            'UPDATE attendance_records SET check_out_time = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [checkOutTime, recordId]
          );
          logger.info('QR出席 - 退出処理', { recordId, studentId, classId: targetClassId });
        } else {
          // 再出席（上書き）
          await query(
            'UPDATE attendance_records SET status = ?, check_in_time = ?, check_out_time = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [status, dateObj, recordId]
          );
          logger.info('QR出席 - 再出席（上書き）', { recordId, studentId, classId: targetClassId });
        }
      } else {
        // 新規記録
        const insertResult = await UnifiedAttendanceService.createRecord({
          organization_id: organizationId,
          user_id: userId,
          record_type: 'class',
          reference_id: targetClassId,
          record_date: recordDate,
          status: status,
          check_in_time: dateObj,
          source: 'qr_scan'
        });

        if (!insertResult.success) throw new Error(insertResult.message);
        recordId = insertResult.data.id;

        logger.info('QR出席 - 新規出席', { recordId, studentId, classId: targetClassId });
      }

      return {
        success: true,
        message: `出欠（${action}）を記録しました`,
        data: {
          recordId,
          action,
          status,
          checkInTime: (action === 'checkin') ? dateObj : existing[0].check_in_time,
          checkOutTime
        }
      };

    } catch (error) {
      logger.error('QR出欠記録エラー:', error.message);
      return {
        success: false,
        message: error.message || 'QR出欠の記録に失敗しました'
      };
    }
  }

  /**
   * 学生出欠記録一覧の取得
   */
  static async getAttendanceRecords(options = {}) {
    try {
      const { student_id, date, limit, offset = 0 } = options;

      const organizationId = 1;
      let userId = null;

      if (student_id) {
        const userResult = await UnifiedUserService.getUserByIdentifier(organizationId, student_id);
        if (userResult.success) {
          userId = userResult.data.id;
        } else {
          // ユーザーが見つからない場合は空を返す
          return { success: true, data: { records: [], total: 0 } };
        }
      }

      // UnifiedAttendanceService を使用するが、全学生対象の場合はループが必要？
      // ここでは student_id が指定されている前提、または自力でクエリ

      let sql = `
        SELECT 
          ar.id, 
          u.identifier as student_id, 
          u.name as student_name, 
          ar.check_in_time as timestamp,
          ar.status
        FROM attendance_records ar
        JOIN users u ON ar.user_id = u.id
        WHERE 1=1
      `;
      const params = [];

      if (userId) {
        sql += ' AND ar.user_id = ?';
        params.push(userId);
      }

      if (date) {
        sql += ' AND ar.record_date = ?';
        params.push(date);
      }

      sql += ' ORDER BY ar.record_date DESC, ar.check_in_time DESC';

      if (limit) {
        sql += ' LIMIT ?';
        params.push(parseInt(limit));
      }
      if (offset) {
        sql += ' OFFSET ?';
        params.push(parseInt(offset));
      }

      const records = await query(sql, params);

      // Total count
      let countSql = `
        SELECT COUNT(*) as total 
        FROM attendance_records ar 
        JOIN users u ON ar.user_id = u.id 
        WHERE 1=1
      `;
      const countParams = [];

      if (userId) {
        countSql += ' AND ar.user_id = ?';
        countParams.push(userId);
      }
      if (date) {
        countSql += ' AND ar.record_date = ?';
        countParams.push(date);
      }

      const countResult = await query(countSql, countParams);
      const total = countResult[0].total;

      return {
        success: true,
        data: {
          records,
          total
        }
      };
    } catch (error) {
      logger.error('学生出欠記録一覧取得エラー:', error.message);
      return {
        success: false,
        message: '出欠記録の取得に失敗しました'
      };
    }
  }
}

module.exports = StudentAttendanceService;