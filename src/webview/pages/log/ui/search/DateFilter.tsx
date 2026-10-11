import { useEffect, useRef, useState } from 'react';

import { isDateFilter } from '@contracts/date-filter';
import type { DateFilter as CalendarFilter } from '@contracts/model';

import styles from './DateFilter.module.css';
import dropdown from './Dropdown.module.css';
import { FilterDropdown } from './FilterDropdown';

export function DateFilter({
  date,
  onChange,
  onInvalid,
}: {
  date: CalendarFilter;
  onChange(this: void, date: CalendarFilter): void;
  onInvalid(this: void): void;
}) {
  const [period, setPeriod] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (period) range.current?.focus();
  }, [period]);
  const label =
    date === 'all'
      ? 'Date'
      : date === '24h'
        ? 'Last 24 hours'
        : date === '7d'
          ? 'Last 7 days'
          : 'Period';

  return (
    <FilterDropdown
      id="date-filter"
      name="Date"
      label={label}
      active={date !== 'all'}
      panelLabel="Filter by committed date"
      title={
        typeof date === 'object'
          ? `${date.from ?? 'Any date'} through ${date.to ?? 'Any date'}`
          : label
      }
      onClear={() => onChange('all')}
      onOpen={() => {
        setFrom(typeof date === 'object' ? (date.from ?? '') : '');
        setTo(typeof date === 'object' ? (date.to ?? '') : '');
        setPeriod(false);
      }}
    >
      {(close) => {
        const apply = (value: CalendarFilter) => {
          onChange(value);
          close();
        };

        return (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const selectedRange: CalendarFilter = {
                kind: 'range',
                from: from || null,
                to: to || null,
              };

              if (!from && !to) apply('all');
              else if (isDateFilter(selectedRange)) apply(selectedRange);
              else onInvalid();
            }}
          >
            {period ? (
              <>
                <div className={styles.range}>
                  <label>
                    From
                    <input
                      type="date"
                      ref={range}
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                    />
                  </label>
                  <label>
                    To
                    <input
                      type="date"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                    />
                  </label>
                </div>
                <div className={styles.actions}>
                  <button type="button" onClick={close}>
                    Cancel
                  </button>
                  <button type="submit" aria-label="Apply dates">
                    Apply
                  </button>
                </div>
              </>
            ) : (
              <div className={dropdown.options}>
                <button type="button" onClick={() => setPeriod(true)}>
                  Select period…
                </button>
                {(
                  [
                    ['24h', 'Last 24 hours'],
                    ['7d', 'Last 7 days'],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={date === value}
                    onClick={() => apply(value)}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </form>
        );
      }}
    </FilterDropdown>
  );
}
