import React, { useState, useEffect, useMemo, useCallback } from 'react';
import useAuthStore from '../stores/authStore';
import { attendanceApi } from '../api/attendanceApi';
import { absenceRequestApi } from '../api/absenceRequestApi';
import { formatDate, getMonthDays, isToday, formatTime as formatTimeUtil } from '../utils/dateUtils';
import ExportButton from '../components/common/ExportButton';
import AbsenceRequestModal from '../components/calendar/AbsenceRequestModal';
import AbsenceListModal from '../components/calendar/AbsenceListModal';
import './CalendarPage.css';

interface CalendarPageProps {
  isDashboardMode?: boolean;
}

const CalendarPage: React.FC<CalendarPageProps> = React.memo(({ isDashboardMode = false }) => {
  const { user, isAuthenticated } = useAuthStore();
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [attendanceRecords, setAttendanceRecords] = useState<Record<string, any>>({});
  const [events, setEvents] = useState<Record<string, any[]>>({}); // [追加] イベント用 state
  const [dailyStats, setDailyStats] = useState<Record<string, any>>({}); // [追加] 日次統計
  const [absenceRequests, setAbsenceRequests] = useState<Record<string, any[]>>({}); // [追加] 欠席申請用 state
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // モーダル用 state
  const [showAbsenceRequest, setShowAbsenceRequest] = useState<boolean>(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [showAbsenceList, setShowAbsenceList] = useState<boolean>(false);
  const [absenceData, setAbsenceData] = useState<any>(null);

  const loadCalendarData = useCallback(async() => {
    try {
      console.log('[CalendarPage] loadCalendarData started. User:', user?.id);
      if (!isAuthenticated || !user?.id) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      const year = currentDate.getFullYear();
      const month = currentDate.getMonth() + 1;
      const userId = user.id;

      const startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
      const endDate = new Date(year, month, 0).toISOString().split('T')[0];

      // [修正] Promise.allで出欠、イベント、統計を同時に取得
      const [attendanceResponse, eventResponse, statsResponse] = await Promise.all([
        attendanceApi.getMonthlyReport(userId, year, month),
        attendanceApi.getEvents({
          start_date: startDate,
          end_date: endDate,
        }),
        attendanceApi.getDailyStats(year, month),
      ]);

      // 1. 出欠記録の処理
      if (attendanceResponse && attendanceResponse.success) {
        // [修正] response.data.records が配列であることを確認
        const records = (attendanceResponse.data && Array.isArray((attendanceResponse.data as any).records))
          ? (attendanceResponse.data as any).records
          : [];
        const recordsMap: Record<string, any> = {};
        records.forEach((record) => {
          const recordDate = record.date || record.attendance_date;
          if (recordDate) {
            recordsMap[recordDate.split('T')[0]] = record;
          }
        });
        setAttendanceRecords(recordsMap);
      } else {
        throw new Error(attendanceResponse?.message || 'カレンダーデータの取得に失敗しました');
      }

      // 2. [追加] イベントの処理
      if (eventResponse && eventResponse.success) {
        // [修正] eventResponse.data.events が配列であることを確認
        const eventList = (eventResponse.data && Array.isArray((eventResponse.data as any).events))
          ? (eventResponse.data as any).events
          : [];
        const eventsMap: Record<string, any[]> = {};
        eventList.forEach((event) => {
          const eventDate = event.start_date.split('T')[0];
          if (!eventsMap[eventDate]) {
            eventsMap[eventDate] = [];
          }
          eventsMap[eventDate].push(event);
        });
        setEvents(eventsMap);
      } else {
        throw new Error(eventResponse?.message || 'イベントデータの取得に失敗しました');
      }

      // 3. [追加] 日次統計の処理
      if (statsResponse && statsResponse.success) {
        console.log('[Calendar Debug] Daily stats loaded:', statsResponse.data);
        setDailyStats(statsResponse.data as any || {});
      } else {
        console.warn('[Calendar Debug] Stats response failed or empty:', statsResponse);
        setDailyStats({});
      }

      // 4. [追加] 学生の欠席申請を取得
      if (user?.role === 'student' && user?.student_id) {
        try {
          const absenceResponse = await absenceRequestApi.getRequestsByStudent(user.student_id, {
            startDate,
            endDate,
          });
          if (absenceResponse && absenceResponse.success) {
            const requestsMap: Record<string, any[]> = {};
            const requests = Array.isArray(absenceResponse.data) ? absenceResponse.data : [];
            requests.forEach((req) => {
              // タイムゾーン問題を回避: YYYY-MM-DDの部分だけを使用
              let reqDate = req.request_date;
              if (reqDate) {
                // ISO形式の場合はTより前の部分を取得
                if (reqDate.includes('T')) {
                  reqDate = reqDate.split('T')[0];
                } else if (reqDate.includes(' ')) {
                  // "YYYY-MM-DD HH:MM:SS"形式の場合
                  reqDate = reqDate.split(' ')[0];
                }
                // 日付が10文字（YYYY-MM-DD）であることを確認
                if (reqDate.length === 10) {
                  if (!requestsMap[reqDate]) {
                    requestsMap[reqDate] = [];
                  }
                  requestsMap[reqDate].push(req);
                }
              }
            });
            console.log('[Calendar] Absence requests map:', requestsMap);
            setAbsenceRequests(requestsMap);
          }
        } catch (absErr) {
          console.warn('[Calendar] 欠席申請取得エラー:', absErr);
        }
      }

    } catch (err: any) {
      console.error('[Calendar Error] Calendar data loading failed:', err);
      console.error('[Calendar Error] Error details:', {
        message: err.message,
        response: err.response,
        stack: err.stack,
      });
      setError('カレンダーデータの読み込みに失敗しました: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  }, [currentDate, isAuthenticated, user]);

  useEffect(() => {
    console.log('[CalendarPage] Effect triggered. Auth:', isAuthenticated, 'User:', user?.id);
    if (isAuthenticated && user?.id) {
      loadCalendarData();
    }
  }, [isAuthenticated, user?.id, loadCalendarData]);

  const changeMonth = (offset: number) => {
    setCurrentDate(prev => new Date(prev.getFullYear(), prev.getMonth() + offset, 1));
  };

  const handleExport = async() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth() + 1;
    const startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    return await attendanceApi.exportAttendanceRecords(startDate, endDate);
  };

  // [追加] 右クリックハンドラー (学生のみ、未来の日付)
  const handleContextMenu = (e: React.MouseEvent, date?: Date) => {
    console.log('=== [Calendar] Right-click detected ===');
    console.log('[Calendar] user object:', user);
    console.log('[Calendar] user.role:', user?.role);
    console.log('[Calendar] date:', date);

    // 学生の場合は常にブラウザのコンテキストメニューを防ぐ
    if (date && user?.role === 'student') {
      e.preventDefault();

      // 今日の0時0分0秒を取得
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // 未来の日付（今日含む）かチェック
      if (date.getTime() >= today.getTime()) {
        console.log('[Calendar] Opening absence request modal for date:', date);
        setSelectedDate(date);
        setShowAbsenceRequest(true);
      } else {
        console.log('[Calendar] Date is in the past:', date);
        alert('過去の日付には欠席申請できません。今日以降の日付を選択してください。');
      }
    } else {
      console.log('[Calendar] Not a student or no date');
    }
  };

  // [追加] 日付クリックハンドラー (教員のみ)
  const handleDateClick = async(date?: Date) => {
    console.log('=== [Calendar] Left-click detected ===');
    console.log('[Calendar] user.role:', user?.role);
    console.log('[Calendar] date:', date);

    // owner, admin, teacher, employee は左クリックでモーダルを開ける
    const canViewAbsenceList = ['owner', 'admin', 'teacher', 'employee'].includes(user?.role);

    if (canViewAbsenceList && date) {
      try {
        const dateStr = formatDate(date, 'YYYY-MM-DD');
        console.log('[Calendar] Fetching absence details for:', dateStr);

        const response = await attendanceApi.getAbsenceDetails(dateStr);
        console.log('[Calendar] API response:', response);

        if (response.success) {
          setAbsenceData(response.data);
          setSelectedDate(date);
          setShowAbsenceList(true);
          console.log('[Calendar] Opening absence list modal');
        } else {
          console.warn('[Calendar] API failed:', response.message);
        }
      } catch (err) {
        console.error('[Calendar] API error:', err);
      }
    } else {
      console.log('[Calendar] Not authorized or no date. Role:', user?.role);
    }
  };

  // [追加] 欠席申請送信
  const handleAbsenceSubmit = async(formData: any) => {
    try {
      console.log('[Calendar Debug] Submitting absence request:', formData);
      const response = await attendanceApi.submitAbsenceRequest(formData);
      console.log('[Calendar Debug] Absence request response:', response);
      loadCalendarData(); // カレンダーを再読込
    } catch (err) {
      console.error('[Calendar Error] Absence request submission failed:', err);
      throw err;
    }
  };

  const calendarDays = useMemo(() => {
    return getMonthDays(currentDate.getFullYear(), currentDate.getMonth());
  }, [currentDate]);

  // 日付を週ごと（7日ずつ）にグループ化
  const calendarWeeks = useMemo(() => {
    const weeks = [];
    for (let i = 0; i < calendarDays.length; i += 7) {
      weeks.push(calendarDays.slice(i, i + 7));
    }
    return weeks;
  }, [calendarDays]);

  const formatTime = (timeStr?: string) => {
    if (!timeStr) return '---';
    return formatTimeUtil(timeStr);
  };

  if (isLoading) {
    return (
      <div className="calendar-page">
        <div className="calendar-loading">
          <div className="spinner" />
          <p>カレンダーを読み込んでいます...</p>
        </div>
      </div>
    );
  }

  if (error && !isDashboardMode) {
    return (
      <div className="calendar-page">
        <div className="calendar-container">
          <div className="error-message">
            {error}
            <button onClick={loadCalendarData} className="retry-button">
              再試行
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`calendar-page ${isDashboardMode ? 'dashboard-mode' : ''}`}>
      <div className="calendar-container">
        {!isDashboardMode && (
          <div className="calendar-header">
            <h1 className="calendar-title">出欠カレンダー</h1>
          </div>
        )}

        <div className="calendar-navigation">
          <button onClick={() => changeMonth(-1)} className="nav-button">
            &lt; 前月
          </button>
          <span className="current-month">
            {formatDate(currentDate, 'YYYY年 MM月')}
          </span>
          <button onClick={() => changeMonth(1)} className="nav-button">
            次月 &gt;
          </button>
          {!isDashboardMode && (
            <ExportButton
              onExport={handleExport}
              filename={`attendance_${currentDate.getFullYear()}_${String(currentDate.getMonth() + 1).padStart(2, '0')}.csv`}
              label="エクスポート"
              size="small"
            />
          )}
        </div>

        <div className="calendar-grid">
          <div className="calendar-weekdays">
            {['日', '月', '火', '水', '木', '金', '土'].map((day) => (
              <div key={day} className="weekday-header">
                {day}
              </div>
            ))}
          </div>

          <div className="calendar-days">
            {calendarWeeks.map((week, weekIndex) => (
              <div key={weekIndex} className="calendar-week">
                {week.map((day, dayIndex) => {
                  const dateStr = day.date ? formatDate(day.date, 'YYYY-MM-DD') : '';
                  const record = day.date ? attendanceRecords[dateStr] : null;
                  const dayEvents = day.date ? (events[dateStr] || []) : [];
                  const dayRequests = day.date ? (absenceRequests[dateStr] || []) : [];

                  const isCurrentMonth = day.isCurrentMonth;
                  const isTodayFlag = day.date && isToday(day.date);

                  // 承認された申請がある場合、そのタイプに応じたステータスを設定
                  const approvedRequest = dayRequests.find(req => req.status === 'approved');
                  let statusClass = 'status-none';
                  if (approvedRequest) {
                    // 承認された申請のタイプに応じてステータスを設定
                    if (approvedRequest.request_type === 'absence' || approvedRequest.request_type === 'absent' || approvedRequest.request_type === 'official_absence') {
                      statusClass = 'status-absent';
                    } else if (approvedRequest.request_type === 'late' || approvedRequest.request_type === 'official_late') {
                      statusClass = 'status-late';
                    } else if (approvedRequest.request_type === 'early_departure') {
                      statusClass = 'status-early_departure';
                    }
                  } else if (record) {
                    statusClass = `status-${record.status}`;
                  }

                  const dayClasses = [
                    'calendar-day',
                    isCurrentMonth ? 'current-month' : 'other-month',
                    isTodayFlag ? 'today' : '',
                    statusClass,
                    dayEvents.length > 0 ? 'has-event' : '',
                    dayRequests.length > 0 ? 'has-request' : '',
                  ].join(' ');

                  // [追加] ツールチップ用タイトル
                  const stats = day.date ? dailyStats[dateStr] : null;
                  const hasPendingRequests = stats && stats.pending_requests > 0;

                  const tooltipText = stats
                    ? `欠席: ${stats.absent || 0}名, 遅刻: ${stats.late || 0}名, 早退: ${stats.early_departure || 0}名${hasPendingRequests ? `, 承認待ち: ${stats.pending_requests}件` : ''}`
                    : '';

                  return (
                    <div
                      key={dayIndex}
                      className={dayClasses}
                      onContextMenu={(e) => handleContextMenu(e, day.date)}
                      onClick={() => handleDateClick(day.date)}
                      title={tooltipText}
                    >
                      <div className="day-number">
                        {day.day}
                        {hasPendingRequests && (user?.role === 'teacher' || user?.role === 'admin') && (
                          <span className="pending-indicator">●</span>
                        )}
                      </div>
                      {isCurrentMonth && (
                        <div className="day-content">
                          {record && (
                            <div className="attendance-info">
                              <span className="status-badge">
                                {record.status === 'present' ? '出' :
                                  record.status === 'absent' ? '欠' :
                                    record.status === 'late' ? '遅' :
                                      record.status === 'early_departure' ? '早' : '他'}
                              </span>

                              <div className="attendance-times-calendar">
                                <span className="time-value">
                                  {formatTime(record.check_in_time)}
                                </span>
                                <span className="time-separator">~</span>
                                <span className="time-value">
                                  {formatTime(record.check_out_time)}
                                </span>
                              </div>

                              {record.reason && (
                                <div className="time-item">
                                  <span className="time-label">理由:</span>
                                  <span className="time-value">
                                    {record.reason}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          {dayEvents.length > 0 && (
                            <div className="event-info">
                              {dayEvents.map(event => (
                                <div key={event.id} className="event-item" title={event.title}>
                                  {event.title}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* [追加] 欠席申請の表示（1日1件のみ） */}
                          {/* [追加] 欠席申請の表示（1日1件のみ、却下済みは非表示） */}
                          {dayRequests.length > 0 && (() => {
                            // 却下された申請は除外
                            const visibleRequests = dayRequests.filter(req => req.status !== 'rejected');

                            if (visibleRequests.length === 0) return null;

                            // 1日につき最新の申請のみ表示
                            const latestRequest = visibleRequests[0];
                            const getStatusMark = (status) => {
                              switch (status) {
                                case 'pending': return '📝';
                                case 'approved': return '✅';
                                case 'rejected': return '❌';
                                default: return '📋';
                              }
                            };
                            const getStatusText = (status) => {
                              switch (status) {
                                case 'pending': return '申請中';
                                case 'approved': return '承認済';
                                case 'rejected': return '却下';
                                default: return '';
                              }
                            };
                            return (
                              <div
                                className={`request-item request-${latestRequest.status}`}
                                title={`${latestRequest.request_type}: ${latestRequest.reason}`}
                              >
                                <span className="request-mark">{getStatusMark(latestRequest.status)}</span>
                                <span className="request-text">{getStatusText(latestRequest.status)}</span>
                              </div>
                            );
                          })()}

                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="calendar-legend">
          <div className="legend-item">
            <div className="legend-color legend-color--present" />
            <span>出勤</span>
          </div>
          <div className="legend-item">
            <div className="legend-color legend-color--absent" />
            <span>欠勤</span>
          </div>
          <div className="legend-item">
            <div className="legend-color legend-color--late" />
            <span>遅刻</span>
          </div>
          <div className="legend-item">
            <div className="legend-color legend-color--early-departure" />
            <span>早退</span>
          </div>
          <div className="legend-item">
            <div className="legend-color legend-color--today" />
            <span>今日</span>
          </div>
          <div className="legend-item">
            <div className="legend-color legend-color--event" />
            <span>イベント</span>
          </div>
        </div>

        {/* [追加] 欠席申請モーダル (学生用) */}
        <AbsenceRequestModal
          isOpen={showAbsenceRequest}
          onClose={() => setShowAbsenceRequest(false)}
          defaultDate={selectedDate}
          onSubmit={handleAbsenceSubmit}
        />

        {/* [追加] 欠席者リストモーダル (教員用) */}
        <AbsenceListModal
          isOpen={showAbsenceList}
          onClose={() => setShowAbsenceList(false)}
          date={selectedDate}
          absenceData={absenceData}
        />
      </div>
    </div >
  );
});

CalendarPage.displayName = 'CalendarPage';

export default CalendarPage;
