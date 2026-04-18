/**
 * QRコードサービス
 *
 * 責務:
 *   - QRコードの生成・検証・無効化
 *   - QRコードスキャンによる出席打刻（IP検証付き）
 *
 * データ書き込み先:
 *   - QRコード情報: qr_codes テーブル
 *   - 出席打刻記録: attendance_records テーブル（v2スキーマ）
 *     ⛔ 旧テーブル (student_attendance_records) への書き込みは廃止されました
 */
const { query } = require('../config/database');
const logger = require('../utils/logger');
const StudentAttendanceService = require('./StudentAttendanceService');
const SecurityService = require('./SecurityService');
const UnifiedAttendanceService = require('./UnifiedAttendanceService');
const uuid = require('uuid');

/**
 * 曜日展開名を取得するヘルパー関数
 * @param {Date} date
 * @returns {'sunday'|'monday'|...|'saturday'}
 */
const getDayOfWeek = (date) => {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return days[date.getDay()];
};

/**
 * 共通: 時限設定を基に遅刻判定を行う
 *
 * 同じ判定ロジックが QRService / AttendanceService / StudentAttendanceService
 * の3箇所に分散していたため、ここに一元化する。
 *
 * @param {string} currentTime - 'HH:MM:SS' 形式の現在時刻
 * @param {Array}  timeSlots   - organization_time_slots テーブルの列
 * @param {number} lateLimitMinutes - 遅刻許容時間（分）
 * @param {string} locationName - ログ/メッセージ用の場所名
 * @returns {{ status: string, message: string }}
 */
function determineAttendanceStatusFromTimeSlots(currentTime, timeSlots, lateLimitMinutes, locationName) {
    if (!timeSlots || timeSlots.length === 0) {
        // 時限設定がない場合は出席扱い
        return { status: 'present', message: `${locationName}で出席を記録しました` };
    }

    // HH:MM:SS → 分単位に変換するヘルパー
    const toMinutes = (timeStr) => {
        const [h, m] = timeStr.split(':').map(Number);
        return h * 60 + m;
    };

    const currentMinutes = toMinutes(currentTime);
    const firstStartMinutes = toMinutes(timeSlots[0].start_time);
    const lastEndMinutes = toMinutes(timeSlots[timeSlots.length - 1].end_time);

    // 最初の時限より前 = 早来・出席扱い
    if (currentMinutes < firstStartMinutes) {
        return { status: 'present', message: `${locationName}で出席を記録しました` };
    }

    // 最後の時限終了後 = 遅刻扩大解釈(授業時間外)
    if (currentMinutes > lastEndMinutes) {
        return {
            status: 'late',
            message: `${locationName}で遅刻として記録しました（授業時間外: ${currentTime}）`
        };
    }

    // 各時限内で記録時刻を確認
    for (const slot of timeSlots) {
        const slotStart = toMinutes(slot.start_time);
        const slotEnd = toMinutes(slot.end_time);

        if (currentMinutes >= slotStart && currentMinutes <= slotEnd) {
            // 時限内: 遅刻許容時間内かどうかで判定
            if (currentMinutes > slotStart + lateLimitMinutes) {
                return {
                    status: 'late',
                    message: `${locationName}で遅刻として記録しました（${slot.period_name || slot.period_number + '限'}: ${lateLimitMinutes}分以上遅れ）`
                };
            }
            return { status: 'present', message: `${locationName}で出席を記録しました（${slot.period_name || slot.period_number + '限'}）` };
        }
    }

    // 時限の間（休憩時間等）= 遅刻扩大解釈
    return {
        status: 'late',
        message: `${locationName}で遅刻として記録しました（時限外: ${currentTime}）`
    };
}

class QRService {
  /**
   * 場所ベースのQRコードを生成（管理者のみ）
   * @param {Object} data - QRコードデータ
   * @param {number} createdBy - 作成者ID（管理者）
   * @returns {Promise<Object>} 生成結果
   */
  static async generateLocationQRCode(data, createdBy) {
    try {
      const QRCode = require('qrcode');
      const { locationName, locationDescription, expiresAt } = data;

      if (!locationName) {
        return {
          success: false,
          message: '場所名は必須です'
        };
      }

      // 作成者のorganization_idを取得
      const userResult = await query('SELECT organization_id FROM users WHERE id = ?', [createdBy]);
      const organizationId = userResult[0]?.organization_id || 1; // デフォルト値として1を使用

      // ユニークなQRコードを生成
      const code = `LOC_${uuid.v4()}`;

      // データベースに保存
      const sql = `
        INSERT INTO qr_codes (code, location_name, location_description, created_by, expires_at, is_active, organization_id)
        VALUES (?, ?, ?, ?, ?, TRUE, ?)
      `;

      const result = await query(sql, [
        code,
        locationName,
        locationDescription || null,
        createdBy,
        expiresAt || null,
        organizationId
      ]);

      // QRコード画像を生成
      const qrImage = await QRCode.toDataURL(code, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        width: 400,
        margin: 2
      });

      logger.info('場所ベースQRコードを生成しました', { locationName, code });

      return {
        success: true,
        message: 'QRコードを生成しました',
        data: {
          id: result.insertId,
          qr_code: code,
          qr_image: qrImage,
          location_name: locationName,
          description: locationDescription,
          is_active: true,
          created_at: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('QRコード生成エラー:', error);
      return {
        success: false,
        message: 'QRコードの生成に失敗しました',
        error: error.message
      };
    }
  }

  /**
   * 既存の generateQRCode (グループID用、後方互換性のため残す)
   */
  static async generateQRCode(data) {
    try {
      const QRCode = require('qrcode');
      const { groupId, format = 'json' } = data;

      if (!groupId) {
        return {
          success: false,
          message: 'グループIDが必要です'
        };
      }

      // QRコードデータの生成
      const qrData = {
        type: 'attendance',
        groupId: groupId,
        timestamp: new Date().toISOString(),
        version: '1.0'
      };

      let qrString;
      if (format === 'json') {
        qrString = JSON.stringify(qrData);
      } else {
        qrString = `ATTENDANCE_GROUP_${groupId}_${Date.now()}`;
      }

      // QRコード画像を生成
      const qrImage = await QRCode.toDataURL(qrString, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        width: 300
      });

      logger.info('QRコードを生成しました', { groupId });

      return {
        success: true,
        data: {
          qrData: qrString,
          qrImage: qrImage,
          groupId: groupId
        }
      };
    } catch (error) {
      logger.error('QRコード生成エラー:', error.message);
      return {
        success: false,
        message: 'QRコードの生成に失敗しました'
      };
    }
  }

  static async verifyQRCode(qrData) {
    try {
      if (!qrData) {
        return {
          success: false,
          message: 'QRコードデータが提供されていません'
        };
      }

      // QRコードデータの検証
      let parsedData;
      try {
        parsedData = JSON.parse(qrData);
      } catch (e) {
        // JSONでない場合は文字列として扱う
        if (qrData.startsWith('SCHOOL_ATTENDANCE')) {
          return {
            success: true,
            data: {
              valid: true,
              type: 'school_attendance'
            }
          };
        }
        return {
          success: false,
          message: '無効なQRコード形式です'
        };
      }

      // QRコードデータの検証
      if (parsedData.type === 'attendance' && parsedData.groupId) {
        return {
          success: true,
          data: {
            valid: true,
            type: 'attendance',
            groupId: parsedData.groupId
          }
        };
      }

      return {
        success: false,
        message: '無効なQRコードです'
      };
    } catch (error) {
      logger.error('QRコード検証エラー:', error.message);
      return {
        success: false,
        message: 'QRコードの検証に失敗しました'
      };
    }
  }
  /**
   * QRコードスキャン（IP検証付き、新システム用）
   * @param {Object} data - スキャンデータ
   * @param {string} ipAddress - スキャン元IPアドレス
   * @param {string} userAgent - ユーザーエージェント
   * @returns {Promise<Object>} スキャン結果
   */
  static async scanQRCodeWithIPValidation(data, ipAddress, userAgent) {
    try {
      const { qrCode, studentId } = data;
      const scanTime = new Date();

      // 1. IPアドレス検証
      const ipCheck = await SecurityService.isIPAllowed(ipAddress);

      if (!ipCheck.allowed) {
        // IPが許可されていない場合、ログに記録して拒否
        await SecurityService.logScan({
          qrCodeId: null,
          studentId,
          ipAddress,
          isAllowed: false,
          userAgent,
          result: 'ip_denied',
          errorMessage: '許可されていないネットワークからのアクセスです'
        });

        return {
          success: false,
          message: '指定のWi-Fiネットワークに接続してください',
          error: 'IP_NOT_ALLOWED'
        };
      }

      // 2. QRコードの検証
      const qrCodeData = await query(
        'SELECT * FROM qr_codes WHERE code = ? AND is_active = TRUE',
        [qrCode]
      );

      if (qrCodeData.length === 0) {
        await SecurityService.logScan({
          qrCodeId: null,
          studentId,
          ipAddress,
          isAllowed: true,
          userAgent,
          result: 'invalid_qr',
          errorMessage: '無効なQRコードです'
        });

        return {
          success: false,
          message: '無効なQRコードです'
        };
      }

      const qrCodeInfo = qrCodeData[0];

      // 有効期限チェック
      if (qrCodeInfo.expires_at && new Date(qrCodeInfo.expires_at) < scanTime) {
        await SecurityService.logScan({
          qrCodeId: qrCodeInfo.id,
          studentId,
          ipAddress,
          isAllowed: true,
          userAgent,
          result: 'error',
          errorMessage: 'QRコードの有効期限が切れています'
        });

        return {
          success: false,
          message: 'QRコードの有効期限が切れています'
        };
      }

      // 3. 学生の現在の授業セッションを検索（新しいclass_sessionsテーブルを使用）
      const currentDate = scanTime.toISOString().split('T')[0];
      const currentTime = scanTime.toTimeString().split(' ')[0];

      const sessionSql = `
        SELECT 
          cs.id, cs.subject_id, cs.class_date, cs.start_time, cs.end_time,
          s.subject_name, cs.teacher_name, cs.room,
          t.group_id
        FROM class_sessions cs
        JOIN subjects s ON cs.subject_id = s.id
        JOIN timetables t ON cs.timetable_id = t.id
        JOIN group_members gm ON t.group_id = gm.group_id
        WHERE gm.student_id = ?
          AND cs.class_date = ?
          AND cs.start_time <= ?
          AND cs.end_time >= ?
          AND cs.is_cancelled = FALSE
          AND gm.status = 'active'
        ORDER BY cs.start_time ASC
        LIMIT 1
      `;

      const sessions = await query(sessionSql, [studentId, currentDate, currentTime, currentTime]);

      if (sessions.length === 0) {
        await SecurityService.logScan({
          qrCodeId: qrCodeInfo.id,
          studentId,
          ipAddress,
          isAllowed: true,
          userAgent,
          result: 'error',
          errorMessage: '現在時刻に該当する授業が見つかりません'
        });

        return {
          success: false,
          message: '現在時刻に該当する授業が見つかりません'
        };
      }

      const session = sessions[0];

      // 4. 出欠ステータスを判定（時刻ベース）
      const AttendanceService = require('./AttendanceService');
      const status = await AttendanceService.determineAttendanceStatus(
        scanTime,
        session.start_time,
        session.class_date
      );

      // 5. 出欠記録を作成/更新
      const recordSql = `
        INSERT INTO detailed_attendance_records 
        (student_id, class_id, attendance_date, status, check_in_time)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          status = VALUES(status),
          check_in_time = VALUES(check_in_time)
      `;

      await query(recordSql, [
        studentId,
        session.id,
        currentDate,
        status,
        scanTime
      ]);

      // 6. スキャンログに記録
      await SecurityService.logScan({
        qrCodeId: qrCodeInfo.id,
        studentId,
        ipAddress,
        isAllowed: true,
        userAgent,
        result: 'success',
        errorMessage: null
      });

      logger.info('QRスキャン成功', { studentId, sessionId: session.id, status });

      return {
        success: true,
        message: `出席を記録しました（${status === 'present' ? '出席' : status === 'late' ? '遅刻' : status}）`,
        data: {
          status,
          sessionInfo: {
            subjectName: session.subject_name,
            teacherName: session.teacher_name,
            room: session.room,
            startTime: session.start_time
          },
          location: qrCodeInfo.location_name
        }
      };
    } catch (error) {
      logger.error('QRスキャンエラー:', error);
      return {
        success: false,
        message: 'QRコードスキャンの処理に失敗しました',
        error: error.message
      };
    }
  }

  /**
   * QRコードスキャンによる出席打刻（メインエントリーポイント）
   *
   * 処理フロー:
   *   1. QRコードの形式検証 (LOC_ または SCHOOL_ATTENDANCE)
   *   2. QRコードのDB検証（有効期限を含む）
   *   3. スキャンしたユーザーの情報取得
   *   4. 現在時刻・曜日から該当授業を検索
   *   5. 出席記録を attendance_records テーブルに保存
   *
   * ⚠️ 旧テーブル (student_attendance_records / students) への書き込みは廃止
   *
   * @param {Object} data
   * @param {string} data.qr_data    - QRコード文字列
   * @param {string} [data.timestamp] - スキャン時刻（省略時は現在時刻）
   * @param {number} data.scanned_by  - スキャンしたユーザーの users.id
   */
  static async scanQRCode(data) {
    try {
      const { qr_data, timestamp, scanned_by } = data;

      logger.info('QRスキャン開始', { qr_data, scanned_by });

      // ── 1. QRコードの形式検証 ─────────────────────────────────────
      if (!qr_data) {
        return { success: false, message: 'QRコードデータが空です' };
      }

      // LOC_ は場所ベース、SCHOOL_ATTENDANCE はレガシーフォーマット
      const isLocationBased = qr_data.startsWith('LOC_');
      if (!isLocationBased && !qr_data.startsWith('SCHOOL_ATTENDANCE')) {
        return { success: false, message: '無効なQRコード形式です' };
      }

      // ── 2. DBでQRコードを検証（有効期限を含む）──────────────
      let qrRecord = null;
      if (isLocationBased) {
        const qrRows = await query(
          'SELECT id, location_name, expires_at, organization_id FROM qr_codes WHERE code = ? AND is_active = TRUE',
          [qr_data]
        );

        if (qrRows.length === 0) {
          logger.warn('QRコードが見つからない', { qr_data });
          return { success: false, message: '無効または期限切れのQRコードです' };
        }
        if (qrRows[0].expires_at && new Date(qrRows[0].expires_at) < new Date()) {
          return { success: false, message: 'このQRコードは有効期限が切れています' };
        }

        qrRecord = qrRows[0];
        logger.info('QRコード検証成功', { location_name: qrRecord.location_name });
      }

      // ── 3. スキャンしたユーザー情報を取得 ────────────────────
      const userRows = await query(
        'SELECT id, organization_id, role, identifier, name FROM users WHERE id = ?',
        [scanned_by]
      );

      if (!userRows[0]) {
        return { success: false, message: 'ユーザー情報が取得できませんでした' };
      }

      const user = userRows[0];

      if (user.role !== 'student') {
        return { success: false, message: '学生としてログインしてください' };
      }

      // v2スキーマでは users.identifier が学籍番号に相当する
      const studentIdentifier = user.identifier;
      if (!studentIdentifier) {
        return {
          success: false,
          message: '学籍番号（識別子）が設定されていません。プロフィールから設定してください。'
        };
      }

      // ── 4. 現在時刻・曜日から該当授業を検索 ─────────────
      const scanTime = timestamp ? new Date(timestamp) : new Date();
      const currentTime = scanTime.toTimeString().split(' ')[0]; // HH:MM:SS
      const dayOfWeek = getDayOfWeek(scanTime);

      logger.info('QRスキャン 授業検索', { studentIdentifier, dayOfWeek, currentTime });

      // enrollments で user_id を参照する（v2スキーマ）
      const classes = await query(
        `SELECT c.*, s.subject_name
         FROM classes c
         JOIN subjects s ON c.subject_id = s.id
         JOIN enrollments e ON c.id = e.class_id
         WHERE e.user_id = ?
           AND c.schedule_day = ?
           AND c.start_time <= ?
           AND c.end_time >= ?
           AND c.is_active = TRUE
           AND e.status = 'enrolled'
         ORDER BY c.start_time ASC`,
        [user.id, dayOfWeek, currentTime, currentTime]
      );

      logger.info('QRスキャン 授業検索結果', { classCount: classes.length });

      // 授業が複数ある場合はフロントで選択させる
      if (classes.length > 1) {
        return {
          success: true,
          requiresSelection: true,
          message: '複数の授業が見つかりました。選択してください。',
          data: { classes }
        };
      }

      // 授業が1つの場合は StudentAttendanceService で記録する
      if (classes.length === 1) {
        const result = await StudentAttendanceService.recordQRAttendance(
          studentIdentifier,
          timestamp,
          classes[0].id
        );
        logger.info('QRスキャン 出席記録完了', { result });
        return result;
      }

      // ── 5. 該当授業なし → 場所ベースの出席として記録 ─────────
      logger.info('QRスキャン: 該当授業なし、場所ベース出席として記録');

      const locationName = qrRecord?.location_name || '不明な場所';
      const attendanceDate = scanTime.toISOString().split('T')[0];
      const organizationId = user.organization_id;

      // 時限設定を取得して遅刻判定（共通ヘルパー関数を使用）
      let attendanceStatus = 'present';
      let statusMessage = `${locationName}で出席を記録しました`;

      try {
        // 組織設定から遅刻許容時間と時限定義を取得
        const [settingsRow] = await query(
          'SELECT late_limit_minutes FROM system_settings WHERE organization_id = ? AND setting_key = ?',
          [organizationId, 'late_limit_minutes']
        );
        const lateLimitMinutes = parseInt(settingsRow?.setting_value) || 15;

        const timeSlots = await query(
          'SELECT * FROM organization_time_slots WHERE organization_id = ? ORDER BY period_number',
          [organizationId]
        );

        // 共通ヘルパー関数で遅刻判定(同じロジックをQRService内に重複記述しない)
        const judgement = determineAttendanceStatusFromTimeSlots(
          currentTime, timeSlots, lateLimitMinutes, locationName
        );
        attendanceStatus = judgement.status;
        statusMessage = judgement.message;
      } catch (settingsError) {
        // 設定取得失敗時はデフォルト（出席）のまま続行
        logger.warn('QRスキャン: 時限設定取得失敗、出席として記録:', settingsError.message);
      }

      // ── 6. v2スキーマの attendance_records に一元保存 ──────────
      //    ⛔ 旧テーブル (student_attendance_records) への書き込みはしない
      const recordResult = await UnifiedAttendanceService.createRecord({
        organization_id: organizationId,
        user_id: user.id,
        record_type: 'daily',          // 場所ベースは daily タイプ
        reference_id: qrRecord?.id || null,
        record_date: attendanceDate,
        status: attendanceStatus,
        check_in_time: scanTime.toISOString().slice(0, 19).replace('T', ' '),
        source: 'qr_scan',
        source_id: qrRecord?.id || null,
        ip_address: null             // ルートハンドラから渡す場合は req.ip を使用
      });

      logger.info('QRスキャン: 場所ベース出席記録完了', {
        userId: user.id,
        locationName,
        attendanceDate,
        status: attendanceStatus
      });

      return {
        success: true,
        status: attendanceStatus,
        message: statusMessage,
        logicalDate: attendanceDate,
        location: locationName,
        recordId: recordResult.data?.id
      };
    } catch (error) {
      logger.error('QRコードスキャンエラー:', {
        message: error.message,
        stack: error.stack,
        code: error.code
      });
      return {
        success: false,
        message: error.message || 'QRコードスキャンの処理に失敗しました'
      };
    }
  }
  /**
   * QRコード一覧を取得
   * @param {Object} options - 検索オプション
   * @returns {Promise<Object>} QRコード一覧
   */
  static async getQRCodes(options = {}) {
    try {
      const { activeOnly = true, limit = 50, offset = 0 } = options;

      // パラメータを確実に整数に変換
      const limitInt = parseInt(limit, 10) || 50;
      const offsetInt = parseInt(offset, 10) || 0;

      let sql = `
        SELECT 
          qr.id, qr.code, qr.location_name, qr.location_description,
          qr.is_active, qr.created_at, qr.expires_at,
          u.name as created_by_name
        FROM qr_codes qr
        LEFT JOIN users u ON qr.created_by = u.id
        WHERE 1=1
      `;

      if (activeOnly) {
        sql += ' AND qr.is_active = TRUE';
      }

      sql += ' ORDER BY qr.created_at DESC';

      // LIMIT と OFFSET を直接クエリに埋め込む（整数として検証済み）
      sql += ` LIMIT ${limitInt}`;
      if (offsetInt > 0) {
        sql += ` OFFSET ${offsetInt}`;
      }

      const results = await query(sql, []);

      return {
        success: true,
        data: results
      };
    } catch (error) {
      logger.error('QRコード一覧取得エラー:', error);
      return {
        success: false,
        message: 'QRコード一覧の取得に失敗しました',
        error: error.message
      };
    }
  }

  /**
   * QRコードを無効化
   * @param {number} id - QRコードID
   * @returns {Promise<Object>} 無効化結果
   */
  static async deactivateQRCode(id) {
    try {
      const sql = 'UPDATE qr_codes SET is_active = FALSE WHERE id = ?';
      await query(sql, [id]);

      logger.info('QRコードを無効化しました', { id });

      return {
        success: true,
        message: 'QRコードを無効化しました'
      };
    } catch (error) {
      logger.error('QRコード無効化エラー:', error);
      return {
        success: false,
        message: 'QRコードの無効化に失敗しました',
        error: error.message
      };
    }
  }

  /**
   * QRコードを削除
   * @param {number} id - QRコードID
   * @returns {Promise<Object>} 削除結果
   */
  static async deleteQRCode(id) {
    try {
      const sql = 'DELETE FROM qr_codes WHERE id = ?';
      await query(sql, [id]);

      logger.info('QRコードを削除しました', { id });

      return {
        success: true,
        message: 'QRコードを削除しました'
      };
    } catch (error) {
      logger.error('QRコード削除エラー:', error);
      return {
        success: false,
        message: 'QRコードの削除に失敗しました',
        error: error.message
      };
    }
  }

  /**
   * QRコード履歴を取得（後方互換性）
   */
  static async getQRHistory(options) {
    logger.warn('getQRHistory は非推奨です。getQRCodes を使用してください。');
    return await this.getQRCodes(options);
  }
}

module.exports = QRService;
