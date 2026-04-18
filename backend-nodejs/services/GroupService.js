/**
 * グループ管理サービス
 *
 * 責務:
 *   - グループ（クラス・チーム等）の CRUD
 *   - グループメンバー（招待・承諾・削除）管理
 *   - 担当教員の紐付け管理
 *
 * テーブル: groups / group_members / group_teachers / users
 */
const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');

/**
 * グループ管理サービス
 */
class GroupService {
  /**
   * [完全版] グループの作成 (作成者IDも保存)
   */
  static async createGroup(data, creatorId) {
    try {
      if (!creatorId) {
        throw new Error('作成者ID (creatorId) が必要です');
      }

      const result = await transaction(async (conn) => {
        const existingGroups = await query(
          'SELECT id FROM `groups` WHERE name = ?',
          [data.name],
          conn
        );

        if (existingGroups.length > 0) {
          throw new Error('このグループ名は既に使用されています');
        }

        const insertResult = await query(
          'INSERT INTO `groups` (name, icon, description, created_by, is_active) VALUES (?, ?, ?, ?, ?)',
          [
            data.name,
            data.icon || null,
            data.description || null,
            creatorId, // [修正] 作成者IDをセット
            data.is_active !== undefined ? data.is_active : true
          ],
          conn
        );

        return {
          success: true,
          message: 'グループが作成されました',
          data: { id: insertResult.insertId }
        };
      });

      logger.info('グループ作成成功', { groupId: result.data.id, name: data.name, creatorId });
      return result;
    } catch (error) {
      logger.error('グループ作成エラー:', error.message);
      return {
        success: false,
        message: error.message || 'グループの作成に失敗しました'
      };
    }
  }

  /**
   * グループ一覧の取得
   */
  static async getGroups(options = {}) {
    try {
      const {
        search, // [修正] 'search' パラメータも受け取る
        is_active,
        created_by,
        student_id,
        include_members,
        limit,
        offset = 0
      } = options;

      let sql = `
        SELECT 
          g.id, g.name, g.icon, g.is_active, g.created_at, g.created_by,
          u.name as creator_name,
          (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as member_count
        FROM \`groups\` g
        LEFT JOIN users u ON g.created_by = u.id
      `;
      const params = [];

      if (student_id) {
        // student_id (identifier) から user_id を特定してフィルタリング
        sql += ` JOIN group_members gm_filter ON g.id = gm_filter.group_id 
                 JOIN users u_filter ON gm_filter.user_id = u_filter.id 
                 WHERE u_filter.identifier = ?`;
        params.push(student_id);
      } else if (options.teacher_id) { // [追加] 担当教員でフィルタリング
        sql += ` JOIN group_teachers gt_filter ON g.id = gt_filter.group_id WHERE gt_filter.user_id = ?`;
        params.push(options.teacher_id);
      } else {
        sql += ` WHERE 1=1`;
      }

      if (search) {
        sql += ' AND g.name LIKE ?';
        params.push(`%${search}%`);
      }
      if (is_active !== undefined) {
        sql += ' AND g.is_active = ?';
        params.push(Boolean(is_active));
      }
      if (created_by) {
        sql += ' AND g.created_by = ?';
        params.push(created_by);
      }

      sql += ' ORDER BY g.created_at DESC';

      if (limit) {
        sql += ' LIMIT ?';
        params.push(parseInt(limit));
      }
      if (offset) {
        sql += ' OFFSET ?';
        params.push(parseInt(offset));
      }

      // デバッグログ
      logger.debug('グループ取得SQL:', { sql, params, options });

      let groups = await query(sql, params);

      if (include_members && groups.length > 0) {
        const groupIds = groups.map(g => g.id);

        // プレースホルダーの生成 (?,?,...)
        const placeholders = groupIds.map(() => '?').join(',');

        // usersテーブルからメンバー情報を取得
        const allMembers = await query(
          `SELECT 
            gm.id, 
            gm.group_id, 
            gm.user_id as student_id_internal,
            u.identifier as student_id,
            u.name, 
            gm.status, 
            gm.joined_at 
          FROM group_members gm
          LEFT JOIN users u ON gm.user_id = u.id
          WHERE gm.group_id IN (${placeholders})`,
          groupIds
        );

        // グループIDごとにメンバーをマッピング
        const membersMap = {};
        allMembers.forEach(member => {
          if (!membersMap[member.group_id]) {
            membersMap[member.group_id] = [];
          }
          membersMap[member.group_id].push(member);
        });

        // 各グループにメンバーを割り当て
        for (const group of groups) {
          group.members = membersMap[group.id] || [];
        }
      }

      // -------------------------------------------------------
      // ページング前の総件数を独立したカウントSQLで取得する
      // ⛔ groups.length だと LIMIT 後の件数（例: 10）になり
      //    ページネーションの計算が誤る
      // -------------------------------------------------------
      let countSql = `SELECT COUNT(*) as total FROM \`groups\` g WHERE 1=1`;
      const countParams = [];

      if (student_id) {
        countSql += ` AND EXISTS (
          SELECT 1 FROM group_members gm2
          JOIN users u2 ON gm2.user_id = u2.id
          WHERE gm2.group_id = g.id AND u2.identifier = ?)`;
        countParams.push(student_id);
      } else if (options.teacher_id) {
        countSql += ` AND EXISTS (
          SELECT 1 FROM group_teachers gt2
          WHERE gt2.group_id = g.id AND gt2.user_id = ?)`;
        countParams.push(options.teacher_id);
      }

      if (search) {
        countSql += ' AND g.name LIKE ?';
        countParams.push(`%${search}%`);
      }
      if (is_active !== undefined) {
        countSql += ' AND g.is_active = ?';
        countParams.push(Boolean(is_active));
      }
      if (created_by) {
        countSql += ' AND g.created_by = ?';
        countParams.push(created_by);
      }

      const countResult = await query(countSql, countParams);
      const totalCount = countResult[0]?.total || 0;

      return {
        success: true,
        data: {
          groups,
          total: totalCount  // ページング前の全件数
        }
      };
    } catch (error) {
      logger.error('グループ一覧取得エラー:', error.message);
      return {
        success: false,
        message: 'グループ一覧の取得に失敗しました'
      };
    }
  }

  /**
   * 特定グループの取得
   */
  static async getGroup(id) {
    try {
      const groups = await query(
        `SELECT 
          g.id, g.name, g.icon, g.description, g.is_active, g.created_at, g.created_by,
          u.name as creator_name,
          (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as member_count
         FROM \`groups\` g
         LEFT JOIN users u ON g.created_by = u.id
         WHERE g.id = ?`,
        [id]
      );

      if (groups.length === 0) {
        return {
          success: false,
          message: 'グループが見つかりません'
        };
      }

      const group = groups[0];

      // studentsテーブルとusersテーブルの両方からメンバー情報を取得
      const members = await query(
        `SELECT 
          gm.id, 
          gm.group_id, 
          u.identifier as student_id, 
          u.name, 
          gm.status, 
          gm.joined_at 
        FROM group_members gm
        LEFT JOIN users u ON gm.user_id = u.id
        WHERE gm.group_id = ?`,
        [id]
      );
      group.members = members;

      return {
        success: true,
        data: { group }
      };
    } catch (error) {
      logger.error('グループ取得エラー:', error.message);
      return {
        success: false,
        message: 'グループ情報の取得に失敗しました'
      };
    }
  }

  /**
   * グループ情報の更新
   */
  static async updateGroup(id, updateData) {
    try {
      const allowedFields = ['name', 'icon', 'description', 'is_active'];
      const updateFields = [];
      const updateValues = [];

      for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
          updateFields.push(`${field} = ?`);
          updateValues.push(updateData[field]);
        }
      }

      if (updateFields.length === 0) {
        return {
          success: false,
          message: '更新するデータがありません'
        };
      }

      updateValues.push(id);

      await query(
        `UPDATE \`groups\` SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );

      logger.info('グループ情報更新成功', { groupId: id });

      return {
        success: true,
        message: 'グループ情報が更新されました'
      };
    } catch (error) {
      logger.error('グループ情報更新エラー:', error.message);
      return {
        success: false,
        message: 'グループ情報の更新に失敗しました'
      };
    }
  }

  /**
   * グループメンバーの追加（招待）
   * [修正] 'role' ではなく 'status' を使う
   */
  static async addMember(groupId, studentId, inviterId) {
    try {
      const result = await transaction(async (conn) => {
        const groups = await query('SELECT id FROM `groups` WHERE id = ?', [groupId], conn);
        if (groups.length === 0) throw new Error('グループが見つかりません');

        // ユーザーが存在するか確認 (Identifierで検索)
        const users = await query(
          'SELECT id, name, email FROM users WHERE identifier = ?',
          [studentId],
          conn
        );

        let userId;
        let userName = '';
        let userEmail = '';

        if (users.length > 0) {
          userId = users[0].id;
          userName = users[0].name;
          userEmail = users[0].email;
        } else {
          throw new Error(`指定された学生ID (${studentId}) が見つかりません`);
        }

        // 既にメンバーかチェック
        const existingMember = await query(
          'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
          [groupId, userId],
          conn
        );

        if (existingMember.length > 0) {
          throw new Error('この学生は既にグループに参加しています');
        }

        // メンバー追加
        await query(
          'INSERT INTO group_members (group_id, user_id, invited_by, status, joined_at) VALUES (?, ?, ?, ?, NOW())',
          [groupId, userId, inviterId, 'pending'],
          conn
        );

        return {
          success: true,
          message: '学生をグループに招待しました'
        };
      });

      logger.info('グループメンバー追加成功', { groupId, studentId, inviterId });
      return result;
    } catch (error) {
      logger.error('グループメンバー追加エラー:', {
        groupId,
        studentId,
        inviterId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      return {
        success: false,
        message: error.message || 'メンバーの追加に失敗しました'
      };
    }
  }

  /**
   * メンバーの招待ステータス更新 (学生本人による操作)
   */
  static async updateMemberStatus(id, studentId, status) {
    try {
      if (status !== 'accepted' && status !== 'declined') {
        return { success: false, message: '無効なステータスです' };
      }

      // studentId (identifier) から user_id を取得
      const users = await query('SELECT id FROM users WHERE identifier = ?', [studentId]);
      if (users.length === 0) {
        return { success: false, message: '学生が見つかりません' };
      }
      const userId = users[0].id;

      const result = await query(
        'UPDATE group_members SET status = ?, joined_at = ? WHERE group_id = ? AND user_id = ? AND status = ?',
        [
          status,
          (status === 'accepted') ? new Date() : null,
          id,
          userId,
          'pending'
        ]
      );

      if (result.affectedRows === 0) {
        return { success: false, message: '招待が見つからないか、既に応答済みです' };
      }

      return { success: true, message: `招待を${status === 'accepted' ? '承諾' : '辞退'}しました` };

    } catch (error) {
      logger.error('グループ招待応答エラー:', error.message);
      return { success: false, message: '招待への応答に失敗しました' };
    }
  }

  /**
   * グループメンバーの一覧取得
   */
  static async getMembers(id, options = {}) {
    try {
      const { status, limit, offset = 0 } = options;

      // studentsテーブルとusersテーブルの両方からメンバー情報を取得
      let sql = `
        SELECT 
          u.identifier as student_id, 
          u.name, 
          u.email, 
          gm.status, 
          gm.joined_at, 
          gm.invited_by
        FROM group_members gm
        LEFT JOIN users u ON gm.user_id = u.id
        WHERE gm.group_id = ?
      `;
      const params = [id];

      if (status) {
        sql += ' AND gm.status = ?';
        params.push(status);
      }

      sql += ' ORDER BY name ASC';

      if (limit) {
        sql += ' LIMIT ?';
        params.push(parseInt(limit));
      }
      if (offset) {
        sql += ' OFFSET ?';
        params.push(parseInt(offset));
      }

      const members = await query(sql, params);

      return {
        success: true,
        data: { members }
      };
    } catch (error) {
      logger.error('グループメンバー取得エラー:', error.message);
      return {
        success: false,
        message: 'メンバー一覧の取得に失敗しました'
      };
    }
  }

  /**
   * グループメンバーの削除
   */
  static async removeMember(groupId, studentId) {
    try {
      const result = await transaction(async (conn) => {
        // ユーザーIDの取得
        const users = await query('SELECT id FROM users WHERE identifier = ?', [studentId], conn);
        if (users.length === 0) throw new Error('学生が見つかりません');
        const userId = users[0].id;

        const existingMember = await query(
          'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
          [groupId, userId],
          conn
        );

        if (existingMember.length === 0) {
          throw new Error('メンバーが見つかりません');
        }

        await query(
          'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
          [groupId, userId],
          conn
        );

        return {
          success: true,
          message: 'メンバーが削除されました'
        };
      });

      logger.info('グループメンバー削除成功', { groupId: id, studentId });
      return result;
    } catch (error) {
      logger.error('グループメンバー削除エラー:', error.message);
      return {
        success: false,
        message: error.message || 'メンバーの削除に失敗しました'
      };
    }
  }

  /**
   * グループの削除
   */
  static async deleteGroup(id) {
    try {
      const result = await transaction(async (conn) => {
        const groups = await query(
          'SELECT id FROM `groups` WHERE id = ?',
          [id],
          conn
        );

        if (groups.length === 0) {
          throw new Error('グループが見つかりません');
        }

        await query(
          'DELETE FROM group_members WHERE group_id = ?',
          [id],
          conn
        );

        await query(
          'DELETE FROM `groups` WHERE id = ?',
          [id],
          conn
        );

        return {
          success: true,
          message: 'グループが削除されました'
        };
      });

      logger.info('グループ削除成功', { groupId: id });
      return result;
    } catch (error) {
      logger.error('グループ削除エラー:', error.message);
      return {
        success: false,
        message: error.message || 'グループの削除に失敗しました'
      };
    }
  }
  /**
   * 担当教員の追加
   */
  static async addTeacher(groupId, userId, role = 'main') {
    try {
      const result = await transaction(async (conn) => {
        const groups = await query('SELECT id FROM `groups` WHERE id = ?', [groupId], conn);
        if (groups.length === 0) throw new Error('グループが見つかりません');

        const users = await query('SELECT id, role FROM users WHERE id = ?', [userId], conn);
        if (users.length === 0) throw new Error('ユーザーが見つかりません');
        if (users[0].role !== 'teacher' && users[0].role !== 'admin') {
          throw new Error('教員または管理者のみ担当になれます');
        }

        const existingTeacher = await query(
          'SELECT id FROM group_teachers WHERE group_id = ? AND user_id = ?',
          [groupId, userId],
          conn
        );

        if (existingTeacher.length > 0) {
          throw new Error('このユーザーは既に担当教員です');
        }

        await query(
          'INSERT INTO group_teachers (group_id, user_id, role, assigned_at) VALUES (?, ?, ?, CURDATE())',
          [groupId, userId, role],
          conn
        );

        return {
          success: true,
          message: '担当教員を追加しました'
        };
      });

      logger.info('担当教員追加成功', { groupId, userId, role });
      return result;
    } catch (error) {
      logger.error('担当教員追加エラー:', error.message);
      return {
        success: false,
        message: error.message || '担当教員の追加に失敗しました'
      };
    }
  }

  /**
   * 担当教員の削除
   */
  static async removeTeacher(groupId, userId) {
    try {
      const result = await transaction(async (conn) => {
        const existingTeacher = await query(
          'SELECT id FROM group_teachers WHERE group_id = ? AND user_id = ?',
          [groupId, userId],
          conn
        );

        if (existingTeacher.length === 0) {
          throw new Error('担当教員が見つかりません');
        }

        await query(
          'DELETE FROM group_teachers WHERE group_id = ? AND user_id = ?',
          [groupId, userId],
          conn
        );

        return {
          success: true,
          message: '担当教員を削除しました'
        };
      });

      logger.info('担当教員削除成功', { groupId, userId });
      return result;
    } catch (error) {
      logger.error('担当教員削除エラー:', error.message);
      return {
        success: false,
        message: error.message || '担当教員の削除に失敗しました'
      };
    }
  }

  /**
   * 担当教員一覧の取得
   */
  static async getTeachers(groupId) {
    try {
      const teachers = await query(
        `SELECT u.id, u.name, u.email, gt.role, gt.assigned_at
         FROM group_teachers gt
         JOIN users u ON gt.user_id = u.id
         WHERE gt.group_id = ?
         ORDER BY gt.role DESC, u.name ASC`, // main role first
        [groupId]
      );

      return {
        success: true,
        data: { teachers }
      };
    } catch (error) {
      logger.error('担当教員一覧取得エラー:', error.message);
      return {
        success: false,
        message: '担当教員一覧の取得に失敗しました'
      };
    }
  }
}

module.exports = GroupService;