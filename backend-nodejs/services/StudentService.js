/**
 * 学生管理サービス (新スキーマ対応版)
 * 旧 StudentService のインターフェースを維持しつつ、
 * users テーブルや UnifiedUserService を使用するようにリファクタリング
 */
const { query } = require('../config/database');
const logger = require('../utils/logger');
const UnifiedUserService = require('./UnifiedUserService');

class StudentService {
  /**
   * 学生の作成
   */
  static async createStudent(studentData) {
    try {
      // organization_id の取得 (デフォルト組織または管理者から取得すべきだが、暫定的に1)
      const organizationId = 1;

      // UnifiedUserService を使用してユーザー(学生)を作成
      const result = await UnifiedUserService.createUser({
        organization_id: organizationId,
        email: studentData.email || `${studentData.student_id}@student.local`, // メール必須のためダミー生成
        password: 'defaultStudentPassword', // 初期パスワード
        name: studentData.name,
        role: 'student',
        identifier: studentData.student_id,
        card_id: studentData.card_id,
        grade: studentData.grade,
        class_name: studentData.class_name,
        phone: studentData.phone,
        status: studentData.status
      });

      if (!result.success) {
        throw new Error(result.message);
      }

      return {
        success: true,
        message: '学生が作成されました',
        data: { studentId: studentData.student_id }
      };
    } catch (error) {
      logger.error('学生作成エラー:', error.message);
      return {
        success: false,
        message: error.message || '学生の作成に失敗しました'
      };
    }
  }

  /**
   * 学生一覧の取得
   */
  static async getStudents(options = {}) {
    try {
      const organizationId = 1; // デフォルト組織
      // UnifiedUserService を使用
      const result = await UnifiedUserService.getStudents(organizationId, options);

      // レスポンス形式を旧APIに合わせる
      if (result.success) {
        // identifier -> student_id マッピングなどは UnifiedUserService 側で調整済みか確認
        // UnifiedUserService.getOrganizationUsers は raw users オブジェクトを返す
        // 必要なら整形
        const formattedUsers = result.data.users.map(u => ({
          ...u,
          student_id: u.identifier
        }));

        return {
          success: true,
          data: {
            students: formattedUsers,
            total: result.data.total,
            limit: result.data.limit,
            offset: result.data.offset
          }
        };
      }

      return result;
    } catch (error) {
      logger.error('学生一覧取得エラー:', error.message);
      return {
        success: false,
        message: '学生一覧の取得に失敗しました'
      };
    }
  }

  /**
   * 特定学生の取得
   */
  static async getStudent(studentId) {
    try {
      const organizationId = 1;
      const result = await UnifiedUserService.getUserByIdentifier(organizationId, studentId);

      if (result.success) {
        const user = result.data;
        return {
          success: true,
          data: {
            ...user,
            student_id: user.identifier
          }
        };
      }

      return {
        success: false,
        message: '学生が見つかりません'
      };
    } catch (error) {
      logger.error('学生取得エラー:', error.message);
      return {
        success: false,
        message: '学生情報の取得に失敗しました'
      };
    }
  }

  /**
   * カードIDで学生を検索
   */
  static async getStudentByCardId(cardId) {
    try {
      const users = await query(
        'SELECT * FROM users WHERE card_id = ? AND role = ?',
        [cardId, 'student']
      );

      if (users.length === 0) {
        return {
          success: false,
          message: '学生が見つかりません'
        };
      }

      const user = users[0];
      return {
        success: true,
        data: {
          ...user,
          student_id: user.identifier
        }
      };
    } catch (error) {
      logger.error('カードID検索エラー:', error.message);
      return {
        success: false,
        message: '学生の検索に失敗しました'
      };
    }
  }

  /**
   * 学生情報の更新
   */
  static async updateStudent(studentId, updateData) {
    try {
      const organizationId = 1;
      // まずIDを取得
      const userResult = await UnifiedUserService.getUserByIdentifier(organizationId, studentId);
      if (!userResult.success) {
        throw new Error('学生が見つかりません');
      }
      const userId = userResult.data.id;

      // 更新実行
      // student_id の更新が含まれる場合は identifier にマッピング
      if (updateData.student_id) {
        updateData.identifier = updateData.student_id;
        delete updateData.student_id;
      }

      const result = await UnifiedUserService.updateUser(userId, updateData);

      return result;
    } catch (error) {
      logger.error('学生情報更新エラー:', error.message);
      return {
        success: false,
        message: error.message || '学生情報の更新に失敗しました'
      };
    }
  }

  /**
   * 学生の削除
   */
  static async deleteStudent(studentId) {
    try {
      const organizationId = 1;
      const userResult = await UnifiedUserService.getUserByIdentifier(organizationId, studentId);
      if (!userResult.success) {
        throw new Error('学生が見つかりません');
      }
      const userId = userResult.data.id;

      // 関連データの削除 (UnifiedUserService.deleteUser は論理削除のみ)
      // 必要であれば物理削除や関連データ削除を追加するが、
      // 基本は論理削除でOKとする
      const result = await UnifiedUserService.deleteUser(userId);

      return result;
    } catch (error) {
      logger.error('学生削除エラー:', error.message);
      return {
        success: false,
        message: error.message || '学生の削除に失敗しました'
      };
    }
  }
}

module.exports = StudentService;