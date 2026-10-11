import { ActionButton } from '@webview/shared/ui';

import type { LogData, LogIntent } from '../../model/view';
import { DateFilter } from './DateFilter';
import styles from './HistoryToolbar.module.css';
import { SearchControls } from './SearchControls';
import { UserFilter } from './UserFilter';
import { ViewOptions } from './ViewOptions';

export function HistoryToolbar({
  data,
  onIntent,
}: {
  data: LogData;
  onIntent(this: void, intent: LogIntent): void;
}) {
  const { filters } = data;

  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label="History filters and actions"
    >
      <SearchControls
        text={data.text}
        regex={filters.regex}
        matchCase={filters.matchCase}
        onApply={(text) => onIntent({ kind: 'search', text })}
        onOptionsChange={(options) =>
          onIntent({ kind: 'filters', filters: { ...filters, ...options } })
        }
      />
      <UserFilter
        author={filters.author}
        onChange={(author) =>
          onIntent({ kind: 'filters', filters: { ...filters, author } })
        }
        onChoose={() =>
          onIntent({ kind: 'request', body: { kind: 'choose-authors' } })
        }
      />
      <DateFilter
        date={filters.date}
        onInvalid={() =>
          onIntent({ kind: 'request', body: { kind: 'invalid-date-filter' } })
        }
        onChange={(date) =>
          onIntent({ kind: 'filters', filters: { ...filters, date } })
        }
      />
      <div className={styles.actions}>
        <ActionButton
          icon="sync"
          id="refresh"
          className={styles.icon}
          label="Refresh"
          tooltip="Refresh local history"
          onClick={() =>
            onIntent({ kind: 'request', body: { kind: 'refresh' } })
          }
        />
        <ViewOptions
          showHash={data.showHash}
          presentation={data.presentation}
          onPresentationChange={(presentation) =>
            onIntent({ kind: 'presentation', presentation })
          }
          onChange={(show) => onIntent({ kind: 'show-hash', show })}
        />
      </div>
    </div>
  );
}
