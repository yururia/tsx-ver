/**
 * 認証ストア (Zustand)
 *
 * 責務:
 *   - ログイン・ログアウト・新規登録の処理
 *   - 認証状態の保持と初期化 (checkAuth)
 *   - 管理者の「学生視点切り替え」機能 (viewMode)
 *
 * パフォーマンス設計:
 *   - checkAuth は APP 起動時と明示的な呼び出し時のみ API を叩く
 *   - 最終確認時刻を lastCheckedAt に保持し、一定時間内の再呼び出しをスキップする
 *   - これにより SPA の画面遷移ごとに不要な API 呼び出しが発生しない
 */
import { create } from 'zustand';
import { attendanceApi } from '../api/attendanceApi';

// ─────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────

/**
 * checkAuth の最小再実行間隔（ミリ秒）
 * この時間内に再度 checkAuth が呼ばれてもサーバー問い合わせをスキップする
 */
const CHECK_AUTH_THROTTLE_MS = 5 * 60 * 1000; // 5分

// ─────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────

/** ユーザー型 */
export interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'owner' | 'teacher' | 'employee' | 'student';
  organization_id?: number;
  organization_name?: string;
  student_id?: string;
  identifier?: string;      // v2スキーマ: 学籍番号 / 社員番号を統合
  employee_id?: string;
  department?: string;
  [key: string]: any;
}

/** ログイン・登録の結果型 */
interface AuthResult {
  success: boolean;
  message?: string;
}

/** ストア状態の型定義 */
interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  viewMode: 'student' | null;

  /** 最後に checkAuth でサーバー問い合わせを行った時刻（ms） */
  lastCheckedAt: number | null;

  // ─── アクション ──────────────────────────────────
  setLoading: (loading: boolean) => void;
  toggleViewMode: () => void;
  login: (email: string, password: string) => Promise<AuthResult>;
  register: (userData: any) => Promise<AuthResult>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;

  /**
   * 認証状態を確認する（Cookie ベースの自動ログイン復元）
   *
   * @param {boolean} [force=false]
   *   true を渡すと throttle をスキップして必ずサーバーへ問い合わせる。
   *   通常の画面遷移では false（デフォルト）のまま呼び出すこと。
   */
  checkAuth: (force?: boolean) => Promise<void>,
}

// ─────────────────────────────────────────────────────────────
// ストア実装
// ─────────────────────────────────────────────────────────────

const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  viewMode: null,
  lastCheckedAt: null,  // 初回は必ずサーバー問い合わせを行う

  // ─── ローディング状態の更新 ───────────────────────────────
  setLoading: (loading) => set({ isLoading: loading }),

  // ─── 学生視点切り替え（管理者・教員のみ利用可能）─────────
  toggleViewMode: () => {
    const { user, viewMode } = get();
    // 学生ロールは自分自身の視点しか持てないため切り替え不可
    if (!user || user.role === 'student') return;
    set({ viewMode: viewMode === 'student' ? null : 'student' });
  },

  // ─── ログイン ─────────────────────────────────────────────
  login: async (email, password) => {
    try {
      const response = await attendanceApi.login(email, password);

      if (response.success) {
        const { user } = response.data;
        // ログイン成功時は lastCheckedAt を更新してすぐに再問い合わせしないようにする
        set({
          user,
          isAuthenticated: true,
          viewMode: null,
          lastCheckedAt: Date.now(),
        });
        return { success: true };
      } else {
        set({ user: null, isAuthenticated: false, viewMode: null, lastCheckedAt: null });
        return { success: false, message: response.message };
      }
    } catch (error) {
      console.error('Login failed:', error);
      set({ user: null, isAuthenticated: false, viewMode: null, lastCheckedAt: null });
      return { success: false, message: 'ログインに失敗しました' };
    }
  },

  // ─── 新規登録 ─────────────────────────────────────────────
  register: async (userData) => {
    try {
      const response = await attendanceApi.register(userData);

      if (response.success) {
        const { user } = response.data;
        set({
          user,
          isAuthenticated: true,
          viewMode: null,
          lastCheckedAt: Date.now(),
        });
        return { success: true };
      } else {
        set({ user: null, isAuthenticated: false, viewMode: null, lastCheckedAt: null });
        return { success: false, message: response.message || '登録に失敗しました' };
      }
    } catch (error: any) {
      console.error('Registration failed:', error);
      set({ user: null, isAuthenticated: false, viewMode: null, lastCheckedAt: null });
      return { success: false, message: error.message || '登録に失敗しました' };
    }
  },

  // ─── ログアウト ───────────────────────────────────────────
  logout: async () => {
    try {
      await attendanceApi.logout();
    } catch (error) {
      // ログアウト API の失敗はクライアント側の状態リセットを妨げない
      console.error('Logout API failed:', error);
    } finally {
      // 最終確認時刻もリセットして次回起動時に再問い合わせさせる
      set({ user: null, isAuthenticated: false, viewMode: null, lastCheckedAt: null });
    }
  },

  // ─── ユーザー情報の直接セット（外部から利用） ────────────
  setUser: (user) => {
    set({ user, isAuthenticated: !!user });
  },

  // ─── 認証状態の確認（アプリ起動時・ページロード時に呼ぶ）──
  checkAuth: async (force = false) => {
    const { lastCheckedAt } = get();
    const now = Date.now();

    // throttle: 前回チェックからの経過時間が閾値以内なら API 呼び出しをスキップ
    // force=true の場合はスキップしない（例: プロフィール更新後の強制リフレッシュ）
    if (!force && lastCheckedAt !== null && (now - lastCheckedAt) < CHECK_AUTH_THROTTLE_MS) {
      return; // キャッシュ有効期間内なので何もしない
    }

    try {
      set({ isLoading: true });
      const response = await attendanceApi.getAuthUser();

      if (response.success) {
        set({
          user: response.data?.user ?? response.data,
          isAuthenticated: true,
          lastCheckedAt: now,   // 問い合わせを実行した時刻を更新
        });
      } else {
        // 認証失敗（Cookie期限切れなど）
        set({ user: null, isAuthenticated: false, lastCheckedAt: null });
      }
    } catch (error) {
      // ネットワークエラーや 401 などは未ログイン状態にする
      set({ user: null, isAuthenticated: false, lastCheckedAt: null });
    } finally {
      set({ isLoading: false });
    }
  },
}));

export default useAuthStore;
