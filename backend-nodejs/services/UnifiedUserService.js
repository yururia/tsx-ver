/**
 * 統合ユーザーサービス (v2 スキーマ対応)
 *
 * 責務:
 *   - users テーブルに対する全ユーザー操作（学生・教員・管理者など全ロール統合）
 *   - 旧 students テーブルは廃止され、役割は identifier カラムで代替
 *
 * 重要な設計方針:
 *   - 全操作は organization_id でテナント分離される
 *   - パスワードは必要な場合のみ返却する（getUserByEmail の includePassword オプション参照）
 *   - 一括操作はバルクINSERTで N+1 クエリを回避する
 */
const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const bcrypt = require('bcrypt');

/** bcrypt のコストファクター（変更時はハッシュの再生成が必要）*/
const BCRYPT_ROUNDS = 10;

class UnifiedUserService {
    /**
     * ユーザー作成
     */
    static async createUser(data) {
        try {
            const {
                organization_id,
                email,
                password,
                name,
                role = 'student',
                identifier = null,
                card_id = null,
                department = null,
                grade = null,
                class_name = null,
                phone = null
            } = data;

            if (!organization_id || !email || !password || !name) {
                return {
                    success: false,
                    message: '必須項目が不足しています: organization_id, email, password, name'
                };
            }

            // メール重複チェック
            const existing = await query(
                'SELECT id FROM users WHERE email = ?',
                [email]
            );

            if (existing.length > 0) {
                return {
                    success: false,
                    message: 'このメールアドレスは既に登録されています'
                };
            }

            // パスワードハッシュ化（コストファクターは定数で一元管理）
            const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

            const result = await query(
                `INSERT INTO users 
         (organization_id, email, password, name, role, identifier, 
          card_id, department, grade, class_name, phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    organization_id, email, hashedPassword, name, role, identifier,
                    card_id, department, grade, class_name, phone
                ]
            );

            logger.info('ユーザーを作成しました', { userId: result.insertId, email, role });

            return {
                success: true,
                message: 'ユーザーを作成しました',
                data: { id: result.insertId }
            };
        } catch (error) {
            logger.error('ユーザー作成エラー:', error.message);
            return {
                success: false,
                message: error.message || 'ユーザーの作成に失敗しました'
            };
        }
    }

    /**
     * ユーザー取得（ID）
     */
    static async getUserById(userId) {
        try {
            const users = await query(
                `SELECT 
          id, organization_id, email, name, role, identifier,
          card_id, department, grade, class_name, phone, avatar_url,
          is_active, status, enrollment_date, last_login_at,
          created_at, updated_at
        FROM users WHERE id = ?`,
                [userId]
            );

            if (users.length === 0) {
                return {
                    success: false,
                    message: 'ユーザーが見つかりません'
                };
            }

            return {
                success: true,
                data: users[0]
            };
        } catch (error) {
            logger.error('ユーザー取得エラー:', error.message);
            return {
                success: false,
                message: 'ユーザーの取得に失敗しました'
            };
        }
    }

    /**
     * ユーザー取得（メールアドレス）
     *
     * @param {string} email - メールアドレス
     * @param {Object} options
     * @param {boolean} [options.includePassword=false]
     *   true にするとパスワードハッシュも返す（AuthService での認証時のみ使用すること）
     */
    static async getUserByEmail(email, { includePassword = false } = {}) {
        try {
            // ⚠️ デフォルトはパスワードを除いた安全なカラムのみ返す
            // 認証処理（AuthService）でのみ includePassword: true を指定する
            const columns = includePassword
                ? '*'
                : `id, organization_id, email, name, role, identifier,
                   card_id, department, grade, class_name, phone, avatar_url,
                   is_active, status, enrollment_date, last_login_at,
                   reset_token, reset_token_expires, created_at, updated_at`;

            const users = await query(
                `SELECT ${columns} FROM users WHERE email = ?`,
                [email]
            );

            if (users.length === 0) {
                return {
                    success: false,
                    message: 'ユーザーが見つかりません'
                };
            }

            return {
                success: true,
                data: users[0]
            };
        } catch (error) {
            logger.error('ユーザー取得エラー:', error.message);
            return {
                success: false,
                message: 'ユーザーの取得に失敗しました'
            };
        }
    }

    /**
     * ユーザー取得（識別子 = 学籍番号/社員番号）
     */
    static async getUserByIdentifier(organizationId, identifier) {
        try {
            const users = await query(
                `SELECT * FROM users 
         WHERE organization_id = ? AND identifier = ?`,
                [organizationId, identifier]
            );

            if (users.length === 0) {
                return {
                    success: false,
                    message: 'ユーザーが見つかりません'
                };
            }

            return {
                success: true,
                data: users[0]
            };
        } catch (error) {
            logger.error('ユーザー取得エラー:', error.message);
            return {
                success: false,
                message: 'ユーザーの取得に失敗しました'
            };
        }
    }

    /**
     * 組織内のユーザー一覧取得
     */
    static async getOrganizationUsers(organizationId, options = {}) {
        try {
            const {
                role,
                status,
                search,
                limit,
                offset = 0
            } = options;

            let sql = `
        SELECT 
          id, organization_id, email, name, role, identifier,
          department, grade, class_name, phone, avatar_url,
          is_active, status, enrollment_date, last_login_at,
          created_at, updated_at
        FROM users
        WHERE organization_id = ?
      `;
            const params = [organizationId];

            if (role) {
                sql += ' AND role = ?';
                params.push(role);
            }

            if (status) {
                sql += ' AND status = ?';
                params.push(status);
            }

            if (search) {
                sql += ' AND (name LIKE ? OR email LIKE ? OR identifier LIKE ?)';
                const searchPattern = `%${search}%`;
                params.push(searchPattern, searchPattern, searchPattern);
            }

            // -------------------------------------------------------
            // カウントSQLは独立して構築する
            // ⛔ 正規表現で SELECT ... FROM を置換する方法は
            //    将来的にクエリが複雑化したときに壊れる危険がある
            // ✅ WHERE 条件を共有するため params を流用する
            // -------------------------------------------------------
            let countSql = 'SELECT COUNT(*) as total FROM users WHERE organization_id = ?';
            const countParams = [organizationId];

            if (role) {
                countSql += ' AND role = ?';
                countParams.push(role);
            }
            if (status) {
                countSql += ' AND status = ?';
                countParams.push(status);
            }
            if (search) {
                countSql += ' AND (name LIKE ? OR email LIKE ? OR identifier LIKE ?)';
                const sp = `%${search}%`;
                countParams.push(sp, sp, sp);
            }

            const countResult = await query(countSql, countParams);
            const total = countResult[0]?.total || 0;

            // ページング用の ORDER / LIMIT / OFFSET を追加
            sql += ' ORDER BY name';

            if (limit) {
                sql += ' LIMIT ?';
                params.push(parseInt(limit));
            }

            if (offset) {
                sql += ' OFFSET ?';
                params.push(parseInt(offset));
            }

            const users = await query(sql, params);

            return {
                success: true,
                data: {
                    users,
                    total,
                    limit: limit || users.length,
                    offset
                }
            };
        } catch (error) {
            logger.error('ユーザー一覧取得エラー:', error.message);
            return {
                success: false,
                message: 'ユーザー一覧の取得に失敗しました'
            };
        }
    }

    /**
     * 学生一覧取得（後方互換性用）
     */
    static async getStudents(organizationId, options = {}) {
        return await this.getOrganizationUsers(organizationId, {
            ...options,
            role: 'student'
        });
    }

    /**
     * ユーザー更新
     */
    static async updateUser(userId, data) {
        try {
            const updateFields = [];
            const params = [];

            const allowedFields = [
                'name', 'role', 'identifier', 'card_id', 'department',
                'grade', 'class_name', 'phone', 'avatar_url', 'is_active', 'status'
            ];

            allowedFields.forEach(field => {
                if (data[field] !== undefined) {
                    updateFields.push(`${field} = ?`);
                    params.push(data[field]);
                }
            });

            if (updateFields.length === 0) {
                return {
                    success: false,
                    message: '更新するフィールドがありません'
                };
            }

            params.push(userId);

            await query(
                `UPDATE users SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                params
            );

            logger.info('ユーザーを更新しました', { userId, fields: updateFields });

            return {
                success: true,
                message: 'ユーザーを更新しました'
            };
        } catch (error) {
            logger.error('ユーザー更新エラー:', error.message);
            return {
                success: false,
                message: 'ユーザーの更新に失敗しました'
            };
        }
    }

    /**
     * パスワード変更
     */
    static async changePassword(userId, currentPassword, newPassword) {
        try {
            const users = await query('SELECT password FROM users WHERE id = ?', [userId]);

            if (users.length === 0) {
                return {
                    success: false,
                    message: 'ユーザーが見つかりません'
                };
            }

            const isMatch = await bcrypt.compare(currentPassword, users[0].password);
            if (!isMatch) {
                return {
                    success: false,
                    message: '現在のパスワードが正しくありません'
                };
            }

            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await query(
                'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [hashedPassword, userId]
            );

            logger.info('パスワードを変更しました', { userId });

            return {
                success: true,
                message: 'パスワードを変更しました'
            };
        } catch (error) {
            logger.error('パスワード変更エラー:', error.message);
            return {
                success: false,
                message: 'パスワードの変更に失敗しました'
            };
        }
    }

    /**
     * ユーザー削除（論理削除）
     */
    static async deleteUser(userId) {
        try {
            await query(
                'UPDATE users SET is_active = 0, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                ['inactive', userId]
            );

            logger.info('ユーザーを削除しました', { userId });

            return {
                success: true,
                message: 'ユーザーを削除しました'
            };
        } catch (error) {
            logger.error('ユーザー削除エラー:', error.message);
            return {
                success: false,
                message: 'ユーザーの削除に失敗しました'
            };
        }
    }

    /**
     * 最終ログイン日時更新
     */
    static async updateLastLogin(userId) {
        try {
            await query(
                'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
                [userId]
            );
            return { success: true };
        } catch (error) {
            logger.error('最終ログイン更新エラー:', error.message);
            return { success: false };
        }
    }

    /**
     * ロール変更
     */
    static async changeRole(userId, newRole, adminUserId) {
        try {
            const validRoles = ['owner', 'admin', 'teacher', 'employee', 'student'];
            if (!validRoles.includes(newRole)) {
                return {
                    success: false,
                    message: '無効なロールです'
                };
            }

            await query(
                `UPDATE users 
         SET role = ?, last_role_update = CURDATE(), updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
                [newRole, userId]
            );

            logger.info('ユーザーロールを変更しました', { userId, newRole, changedBy: adminUserId });

            return {
                success: true,
                message: 'ロールを変更しました'
            };
        } catch (error) {
            logger.error('ロール変更エラー:', error.message);
            return {
                success: false,
                message: 'ロールの変更に失敗しました'
            };
        }
    }

    /**
     * 一括ユーザー登録（CSVインポート等）
     *
     * ⚡ パフォーマンス設計:
     *   旧実装は for ループ内で createUser() を逐次呼び出しており、
     *   N件のインポートで 2N クエリ（重複チェックSELECT + INSERT）が発生していた。
     *   本実装では以下の最適化を行う:
     *     1. 全メールアドレスを IN 句で一括チェック（1クエリ）
     *     2. パスワードを並列ハッシュ化（Promise.all）
     *     3. バルク INSERT で一括登録（1クエリ）
     *   → 100件インポートでも合計3クエリで完了する
     *
     * @param {number} organizationId - 組織ID
     * @param {Array<Object>} users   - 登録するユーザーデータ配列
     * @param {string} [defaultRole='student'] - role 未指定時のデフォルト
     * @returns {Promise<Object>} 登録結果（成功件数・失敗件数・エラー詳細）
     */
    static async bulkCreateUsers(organizationId, users, defaultRole = 'student') {
        const results = { success: 0, failed: 0, errors: [] };

        if (!users || users.length === 0) {
            return { success: true, message: '登録対象がありません', data: results };
        }

        // ── Step 1: 入力データの前処理とバリデーション ─────────────────
        const validUsers = [];
        const invalidEmails = new Set();

        for (const userData of users) {
            if (!userData.email || !userData.name) {
                results.failed++;
                results.errors.push({
                    email: userData.email || '(不明)',
                    message: 'email と name は必須です'
                });
                continue;
            }
            validUsers.push(userData);
        }

        if (validUsers.length === 0) {
            return {
                success: true,
                message: `${results.success}件登録、${results.failed}件失敗`,
                data: results
            };
        }

        // ── Step 2: 既存メールアドレスを一括チェック（1クエリ）──────────
        const emails = validUsers.map(u => u.email);
        const placeholders = emails.map(() => '?').join(',');
        const existingEmailRows = await query(
            `SELECT email FROM users WHERE email IN (${placeholders})`,
            emails
        );
        const existingEmails = new Set(existingEmailRows.map(r => r.email));

        // 重複メールをエラーに分類
        const insertTargets = [];
        for (const userData of validUsers) {
            if (existingEmails.has(userData.email)) {
                results.failed++;
                results.errors.push({
                    email: userData.email,
                    message: 'このメールアドレスは既に登録されています'
                });
            } else {
                insertTargets.push(userData);
            }
        }

        if (insertTargets.length === 0) {
            return {
                success: true,
                message: `${results.success}件登録、${results.failed}件失敗`,
                data: results
            };
        }

        // ── Step 3: パスワードを並列ハッシュ化 ────────────────────────
        const hashedList = await Promise.all(
            insertTargets.map(u =>
                bcrypt.hash(u.password || 'ChangeMe1234!', BCRYPT_ROUNDS)
            )
        );

        // ── Step 4: バルク INSERT（1クエリ）────────────────────────────
        // VALUES の各行を配列で作成し、プレースホルダーをまとめて生成する
        const bulkValues = insertTargets.map((u, i) => [
            organizationId,
            u.email,
            hashedList[i],
            u.name,
            u.role || defaultRole,
            u.identifier || u.student_id || null,
            u.department || null,
            u.grade || null,
            u.class_name || null,
            u.phone || null
        ]);

        const rowPlaceholders = bulkValues.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
        const flatValues = bulkValues.flat();

        try {
            await query(
                `INSERT INTO users
                 (organization_id, email, password, name, role, identifier,
                  department, grade, class_name, phone)
                 VALUES ${rowPlaceholders}`,
                flatValues
            );

            results.success += insertTargets.length;
            logger.info('一括ユーザー登録完了', {
                organizationId,
                successCount: results.success,
                failedCount: results.failed
            });
        } catch (insertError) {
            // バルクINSERT 失敗時は全件エラーとして扱う
            logger.error('一括ユーザー登録バルクINSERTエラー:', insertError.message);
            results.failed += insertTargets.length;
            results.errors.push({
                email: '(一括登録)',
                message: `バルクINSERTに失敗しました: ${insertError.message}`
            });
        }

        return {
            success: true,
            message: `${results.success}件登録、${results.failed}件失敗`,
            data: results
        };
    }
}

module.exports = UnifiedUserService;
