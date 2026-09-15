import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, X } from 'lucide-react';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export default function CalendarPicker({
  days = {},
  selectedDay,
  onSelectDay,
  streamColor = 'amber'
}) {
  const [isOpen, setIsOpen] = useState(false);

  // Map stream dates (YYYY-MM-DD) to day information and key
  const dateMap = useMemo(() => {
    const map = new Map();
    for (const [dayKey, dayInfo] of Object.entries(days)) {
      const rawDate = String(dayInfo?.streamDate || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        map.set(rawDate, { dayKey, dayInfo });
      }
    }
    return map;
  }, [days]);

  // Determine initial month/year from selected day or first available stream date
  const initialDate = useMemo(() => {
    const selectedDate = days[selectedDay]?.streamDate;
    if (selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
      const [y, m] = selectedDate.split('-').map(Number);
      return { year: y, month: m - 1 };
    }
    for (const d of dateMap.keys()) {
      const [y, m] = d.split('-').map(Number);
      return { year: y, month: m - 1 };
    }
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }, [days, selectedDay, dateMap]);

  const [viewYear, setViewYear] = useState(initialDate.year);
  const [viewMonth, setViewMonth] = useState(initialDate.month);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Build calendar matrix for viewMonth / viewYear
  const calendarCells = useMemo(() => {
    const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells = [];

    // Leading empty cells
    for (let i = 0; i < firstDayOfWeek; i++) {
      cells.push({ dayNumber: null, isCurrentMonth: false });
    }

    // Days in current month
    for (let d = 1; d <= daysInMonth; d++) {
      const monthStr = String(viewMonth + 1).padStart(2, '0');
      const dayStr = String(d).padStart(2, '0');
      const dateKey = `${viewYear}-${monthStr}-${dayStr}`;
      const stream = dateMap.get(dateKey) || null;

      cells.push({
        dayNumber: d,
        dateKey,
        isCurrentMonth: true,
        stream
      });
    }

    return cells;
  }, [viewYear, viewMonth, dateMap]);

  const selectedDateStr = days[selectedDay]?.streamDate?.slice(0, 10);
  const totalStreamDays = dateMap.size;

  const colorAccent = streamColor === 'rose'
    ? 'bg-rose-500 text-white shadow-rose-500/30'
    : 'bg-amber-500 text-black shadow-amber-500/30';

  const dotColor = streamColor === 'rose' ? 'bg-rose-400' : 'bg-amber-400';

  return (
    <div className="relative inline-block">
      {/* Calendar Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all flex items-center gap-1.5 cursor-pointer shadow-sm ${
          isOpen
            ? 'bg-zinc-800 text-white border-zinc-600 shadow-md'
            : 'bg-zinc-900/90 text-zinc-300 border-white/10 hover:border-zinc-700 hover:text-white'
        }`}
        title="Open calendar to browse streams by date"
      >
        <CalendarIcon className="w-3.5 h-3.5 text-amber-400" />
        <span className="hidden sm:inline">Calendar</span>
        {totalStreamDays > 0 && (
          <span className="text-[10px] font-mono text-zinc-400 opacity-80">
            ({totalStreamDays})
          </span>
        )}
      </button>

      {/* Popover Calendar Modal */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
            onClick={() => setIsOpen(false)}
          />

          {/* Calendar Panel */}
          <div className="absolute left-0 sm:left-auto sm:right-0 top-full mt-2 z-50 w-72 sm:w-80 p-3.5 rounded-2xl bg-zinc-950/95 border border-white/[0.12] shadow-2xl backdrop-blur-md animate-fadeIn">
            {/* Header: Month / Year Navigation */}
            <div className="flex items-center justify-between gap-2 pb-2.5 mb-2 border-b border-white/[0.08]">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-white tracking-tight">
                  {MONTH_NAMES[viewMonth]} {viewYear}
                </span>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={prevMonth}
                  className="p-1 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors cursor-pointer"
                  title="Previous month"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={nextMonth}
                  className="p-1 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors cursor-pointer"
                  title="Next month"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors cursor-pointer ml-1"
                  title="Close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Weekday Row */}
            <div className="grid grid-cols-7 gap-1 text-center mb-1">
              {WEEKDAY_NAMES.map((w) => (
                <span key={w} className="text-[10px] font-semibold text-zinc-500">
                  {w}
                </span>
              ))}
            </div>

            {/* Calendar Grid Days */}
            <div className="grid grid-cols-7 gap-1">
              {calendarCells.map((cell, idx) => {
                if (!cell.isCurrentMonth) {
                  return <div key={`empty-${idx}`} className="h-9" />;
                }

                const hasStream = Boolean(cell.stream);
                const isSelected = cell.dateKey === selectedDateStr;
                const momentCount = cell.stream?.dayInfo?.eventsCount || cell.stream?.dayInfo?.events?.length || 0;
                const isLive = cell.stream?.dayInfo?.isLive;
                let cellDot = dotColor;
                if (isSelected) {
                  cellDot = streamColor === 'rose' ? 'bg-white' : 'bg-black';
                }

                if (!hasStream) {
                  return (
                    <div
                      key={cell.dateKey}
                      className="h-9 flex items-center justify-center text-[11px] text-zinc-600 rounded-lg select-none"
                    >
                      {cell.dayNumber}
                    </div>
                  );
                }

                return (
                  <button
                    key={cell.dateKey}
                    type="button"
                    onClick={() => {
                      if (cell.stream?.dayKey) {
                        onSelectDay(cell.stream.dayKey);
                        setIsOpen(false);
                      }
                    }}
                    className={`relative h-9 rounded-lg flex flex-col items-center justify-center text-xs font-semibold transition-all cursor-pointer group ${
                      isSelected
                        ? `${colorAccent} shadow-md font-bold ring-2 ring-white/20`
                        : 'bg-zinc-900/90 hover:bg-zinc-800 text-zinc-100 border border-white/10 hover:border-zinc-600'
                    }`}
                    title={`${cell.dateKey}: ${momentCount} moments${isLive ? ' (LIVE)' : ''}`}
                  >
                    <span className="leading-none text-[11px]">{cell.dayNumber}</span>
                    <span className="flex items-center gap-0.5 mt-0.5">
                      <span className={`w-1 h-1 rounded-full ${cellDot}`} />
                      <span className={`text-[8px] font-mono tabular-nums leading-none ${isSelected ? 'opacity-90' : 'text-zinc-400'}`}>
                        {momentCount}
                      </span>
                    </span>
                    {isLive && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-black animate-pulse" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Footer Summary / Quick Tip */}
            <div className="mt-3 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[10px] text-zinc-500">
              <span className="flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                <span>Highlighted days have stream recaps</span>
              </span>
              <span className="font-mono text-zinc-400 tabular-nums">
                {totalStreamDays} active
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
